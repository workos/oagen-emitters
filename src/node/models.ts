import fs from 'node:fs';
import path from 'node:path';
import type { Model, Field, TypeRef, EmitterContext, GeneratedFile } from '@workos/oagen';
import { mapTypeRef, mapWireTypeRef } from './type-map.js';
import { fieldName, wireFieldName, fileName, resolveInterfaceName, wireInterfaceName } from './naming.js';
import {
  collectFieldDependencies,
  docComment,
  buildGenericModelDefaults,
  pruneUnusedImports,
  TS_BUILTINS,
  buildKnownTypeNames,
  isBaselineGeneric,
  createServiceDirResolver,
  isListMetadataModel,
  isListWrapperModel,
  buildDeduplicationMap,
  relativeImport,
  modelHasNewFields,
  computeNonEventReachable,
} from './utils.js';
import { assignEnumsToServices } from './enums.js';
import {
  renderSerializerTypeParams,
  buildSerializerImports,
  buildSkipFormatFields,
  shouldSkipSerializeForModel,
  emitSerializerBody,
  hasDateTimeConversion,
} from './field-plan.js';

/**
 * Detect baseline interfaces that are generic (have type parameters) even though
 * the IR model has no typeParams (OpenAPI doesn't support generics).
 *
 * Heuristic: if any field type in the baseline interface contains a PascalCase
 * name that isn't a known model, enum, or builtin, it's likely a type parameter
 * (e.g., `CustomAttributesType`), indicating the interface is generic.
 *
 * When detected, adds a default generic type arg so references like `Profile`
 * become `Profile<Record<string, unknown>>`.
 */
function enrichGenericDefaultsFromBaseline(
  genericDefaults: Map<string, string>,
  models: Model[],
  ctx: EmitterContext,
  resolveDir: (irService: string | undefined) => string,
  modelToService: Map<string, string>,
): void {
  if (!ctx.apiSurface?.interfaces) return;
  const knownNames = buildKnownTypeNames(models, ctx);

  for (const model of models) {
    if (genericDefaults.has(model.name)) continue; // IR already handles it
    const domainName = resolveInterfaceName(model.name, ctx);
    const baseline = ctx.apiSurface.interfaces[domainName];
    if (!baseline?.fields) continue;

    // Only enrich generic defaults for models whose baseline file path matches
    // the generated path.  If the file is generated in a new directory, it
    // won't have generics, so references to it don't need type args.
    const generatedPath = `src/${resolveDir(modelToService.get(model.name))}/interfaces/${fileName(model.name)}.interface.ts`;
    const baselineSourceFile = (baseline as any).sourceFile as string | undefined;
    if (baselineSourceFile && baselineSourceFile !== generatedPath) continue;

    if (isBaselineGeneric(baseline.fields, knownNames)) {
      genericDefaults.set(model.name, '<Record<string, unknown>>');
    }
  }
}

export function generateModels(models: Model[], ctx: EmitterContext, shared?: SharedModelContext): GeneratedFile[] {
  if (models.length === 0) return [];

  const {
    modelToService,
    resolveDir,
    dedup: sharedDedup,
    genericDefaults: sharedDefaults,
  } = shared ?? buildSharedContext(models, ctx);
  const genericDefaults = sharedDefaults;
  const typeRefOpts = { genericDefaults };
  const wireTypeRefOpts = { genericDefaults };
  const files: GeneratedFile[] = [];
  const dedup = sharedDedup;

  // Only generate files for models reachable from non-event service operations.
  // Event operations (listEvents) pull in hundreds of webhook payload models
  // that the existing SDK handles via hand-written event types. Skip those.
  const reachableModels = computeNonEventReachable(ctx.spec.services, models);

  // Force-generate models that are dependencies of generated models but whose
  // baseline definitions are inline in another file. The merger will replace the
  // parent symbol, losing the inline definition, so a separate file is needed.
  const forceGenerate = new Set<string>();
  for (const model of models) {
    if (!reachableModels.has(model.name)) continue;
    if (!modelHasNewFields(model, ctx)) continue;
    const service = modelToService.get(model.name);
    const dirName = resolveDir(service);
    const parentPath = `src/${dirName}/interfaces/${fileName(model.name)}.interface.ts`;
    const deps = collectFieldDependencies(model);
    for (const dep of deps.models) {
      if (forceGenerate.has(dep)) continue;
      const depName = resolveInterfaceName(dep, ctx);
      const depBaseline = ctx.apiSurface?.interfaces?.[depName];
      const depSrc = (depBaseline as any)?.sourceFile as string | undefined;
      if (depSrc === parentPath) {
        // The dependency's baseline is inline in the parent's file — force-generate
        forceGenerate.add(dep);
      }
    }
  }

  for (const model of models) {
    if (!reachableModels.has(model.name)) continue;

    // Fix #4: Skip per-domain ListMetadata interfaces — the shared ListMetadata type covers these
    if (isListMetadataModel(model)) continue;

    // Fix #6: Skip per-domain list wrapper interfaces — the shared List<T>/ListResponse<T> covers these
    if (isListWrapperModel(model)) continue;

    // Skip models that are unchanged from baseline (no new fields),
    // unless they're force-generated (inline dependency of a regenerated model).
    if (!modelHasNewFields(model, ctx) && !forceGenerate.has(model.name)) continue;

    // Deduplication: if this model is structurally identical to a canonical model,
    // emit a type alias instead of a full interface.
    const canonicalName = dedup.get(model.name);
    if (canonicalName) {
      const service = modelToService.get(model.name);
      const dirName = resolveDir(service);

      // Skip typeAlias resolution for dedup models.  The canonical file may
      // still export its raw name, so the import names must match the raw
      // exports, not resolved aliases.
      const skipTA = { skipTypeAlias: true };
      const domainName = resolveInterfaceName(model.name, ctx, skipTA);
      const responseName = wireInterfaceName(domainName);
      const canonDomainName = resolveInterfaceName(canonicalName, ctx, skipTA);
      const canonResponseName = wireInterfaceName(canonDomainName);

      const canonService = modelToService.get(canonicalName);
      const canonDir = resolveDir(canonService);

      // After noise suffix stripping (e.g., "OrganizationDto" → "Organization"),
      // the alias and canonical may resolve to the same file path or the same
      // type names.  Skip — the canonical file already provides the types.
      const aliasPath = `src/${dirName}/interfaces/${fileName(model.name)}.interface.ts`;
      const canonPath = `src/${canonDir}/interfaces/${fileName(canonicalName)}.interface.ts`;
      if (aliasPath === canonPath) continue;
      if (domainName === canonDomainName) continue;
      const canonRelPath =
        canonDir === dirName
          ? `./${fileName(canonicalName)}.interface`
          : `../../${canonDir}/interfaces/${fileName(canonicalName)}.interface`;
      const aliasLines = [
        `import type { ${canonDomainName}, ${canonResponseName} } from '${canonRelPath}';`,
        '',
        `export type ${domainName} = ${canonDomainName};`,
        `export type ${responseName} = ${canonResponseName};`,
      ];
      files.push({
        path: aliasPath,
        content: aliasLines.join('\n'),
        overwriteExisting: true,
      });
      continue;
    }

    const service = modelToService.get(model.name);
    const dirName = resolveDir(service);
    // If this model is a dedup canonical (other models alias to it), skip
    // typeAlias resolution so the file exports the raw name.  Dedup aliases
    // import using the raw name to stay consistent with preserved files.
    const isDedupCanonical = [...dedup.values()].includes(model.name);
    const domainName = resolveInterfaceName(model.name, ctx, isDedupCanonical ? { skipTypeAlias: true } : undefined);
    const responseName = wireInterfaceName(domainName);
    const deps = collectFieldDependencies(model);
    const lines: string[] = [];

    // Exclude the current model from generic defaults to avoid self-referencing
    // (e.g., Profile's own fields should use TCustom, not Profile<Record<...>>)
    let modelTypeRefOpts = typeRefOpts;
    let modelWireTypeRefOpts = wireTypeRefOpts;
    if (genericDefaults.has(model.name)) {
      const filteredDefaults = new Map(genericDefaults);
      filteredDefaults.delete(model.name);
      modelTypeRefOpts = { ...typeRefOpts, genericDefaults: filteredDefaults };
      modelWireTypeRefOpts = { genericDefaults: filteredDefaults };
    }

    // Baseline interface data (for compat field type matching)
    const baselineDomain = ctx.apiSurface?.interfaces?.[domainName];
    const baselineResponse = ctx.apiSurface?.interfaces?.[responseName];

    // Build set of importable type names for this file:
    // the model itself, its Response variant, all IR-dep model names + Response variants, and all IR-dep enum names
    const importableNames = new Set<string>();
    importableNames.add(domainName);
    importableNames.add(responseName);
    for (const dep of deps.models) {
      const depName = resolveInterfaceName(dep, ctx);
      importableNames.add(depName);
      importableNames.add(wireInterfaceName(depName));
    }
    for (const dep of deps.enums) {
      importableNames.add(dep);
    }

    // Pre-pass: discover baseline type names that aren't directly importable.
    // For each unresolvable name we either:
    //   1. Import the real type from another service (if it exists as an enum/model there)
    //   2. Create a local type alias from a suffix match
    //   3. Mark as unresolvable — the field will fall back to the IR-generated type
    const typeDecls = new Map<string, string>(); // aliasName → type expression
    const crossServiceImports = new Map<string, { name: string; relPath: string }>(); // extra imports
    const unresolvableNames = new Set<string>(); // names that can't be resolved — forces IR fallback
    const enumToService = assignEnumsToServices(ctx.spec.enums, ctx.spec.services);
    // Build a lookup: resolved enum name → IR enum name
    const resolvedEnumNames = new Map<string, string>();
    for (const e of ctx.spec.enums) {
      resolvedEnumNames.set(resolveInterfaceName(e.name, ctx), e.name);
    }

    for (const field of model.fields) {
      const baselineFields = [
        baselineDomain?.fields?.[fieldName(field.name)],
        baselineResponse?.fields?.[wireFieldName(field.name)],
      ].filter(Boolean) as { type: string; optional: boolean }[];

      for (const bf of baselineFields) {
        const names = bf.type.match(/\b[A-Z][a-zA-Z0-9]*\b/g);
        if (!names) continue;

        for (const name of names) {
          if (TS_BUILTINS.has(name)) continue;
          if (importableNames.has(name)) continue;
          if (typeDecls.has(name)) continue;
          if (crossServiceImports.has(name)) continue;
          if (unresolvableNames.has(name)) continue;

          // Check if this name exists as an enum in another service —
          // import the actual type so the extractor sees the real name
          const irEnumName = resolvedEnumNames.get(name);
          if (irEnumName && !deps.enums.has(irEnumName)) {
            const eService = enumToService.get(irEnumName);
            const eDir = resolveDir(eService);
            // Check baseline sourceFile — if the enum lives at a different path
            // than the generated one, import from the baseline location.
            const bEnum = ctx.apiSurface?.enums?.[irEnumName];
            const bAlias = ctx.apiSurface?.typeAliases?.[irEnumName];
            const bSrc = (bEnum as any)?.sourceFile ?? (bAlias as any)?.sourceFile;
            const gPath = `src/${eDir}/interfaces/${fileName(irEnumName)}.interface.ts`;
            const cPath = `src/${dirName}/interfaces/${fileName(model.name)}.interface.ts`;
            // If defined inline in the same file, just add to importable names
            if (bSrc === cPath) {
              importableNames.add(name);
              continue;
            }
            let relPath: string;
            if (bSrc && bSrc !== gPath) {
              relPath = relativeImport(cPath, bSrc).replace(/\.ts$/, '');
            } else {
              relPath =
                eDir === dirName
                  ? `./${fileName(irEnumName)}.interface`
                  : `../../${eDir}/interfaces/${fileName(irEnumName)}.interface`;
            }
            crossServiceImports.set(name, { name, relPath });
            importableNames.add(name);
            continue;
          }

          // Try suffix match: find an importable name ending with this name
          const candidates = [...importableNames].filter((n) => n.endsWith(name) && n !== name);
          if (candidates.length === 1) {
            // Create local type alias (e.g., type RoleResponse = ProfileRoleResponse)
            typeDecls.set(name, candidates[0]);
            importableNames.add(name);
          } else {
            // Cannot resolve this baseline type name — mark it so the field
            // falls back to the IR-generated type instead of the baseline.
            // This avoids creating type aliases that reference undefined types.
            unresolvableNames.add(name);
          }
        }
      }
    }

    // Import referenced models (domain + response) and enums with correct cross-service paths
    for (const dep of deps.models) {
      const depName = resolveInterfaceName(dep, ctx);
      const depService = modelToService.get(dep);
      const depDir = resolveDir(depService);
      const relPath =
        depDir === dirName ? `./${fileName(dep)}.interface` : `../../${depDir}/interfaces/${fileName(dep)}.interface`;
      lines.push(`import type { ${depName}, ${wireInterfaceName(depName)} } from '${relPath}';`);
    }
    for (const dep of deps.enums) {
      // Check if the enum has a baseline sourceFile — if it lives at a
      // different path than the generated one, import from the baseline
      // location since the enum file won't be regenerated there.
      const baselineEnum = ctx.apiSurface?.enums?.[dep];
      const baselineAlias = ctx.apiSurface?.typeAliases?.[dep];
      const baselineSrc = (baselineEnum as any)?.sourceFile ?? (baselineAlias as any)?.sourceFile;
      const depService = enumToService.get(dep);
      const depDir = resolveDir(depService);
      const generatedPath = `src/${depDir}/interfaces/${fileName(dep)}.interface.ts`;
      const currentFilePath = `src/${dirName}/interfaces/${fileName(model.name)}.interface.ts`;

      // If the baseline enum is defined in the SAME file we're generating,
      // skip the import — the merger will preserve the inline definition.
      if (baselineSrc === currentFilePath) {
        importableNames.add(dep);
        continue;
      }

      let relPath: string;
      if (baselineSrc && baselineSrc !== generatedPath) {
        // Baseline provides the enum from a different file — import from there.
        relPath = relativeImport(currentFilePath, baselineSrc).replace(/\.ts$/, '');
      } else {
        relPath =
          depDir === dirName ? `./${fileName(dep)}.interface` : `../../${depDir}/interfaces/${fileName(dep)}.interface`;
      }
      lines.push(`import type { ${dep} } from '${relPath}';`);
    }
    for (const [, imp] of crossServiceImports) {
      lines.push(`import type { ${imp.name} } from '${imp.relPath}';`);
    }

    if (lines.length > 0) lines.push('');

    // Add local type declarations for unresolvable baseline type names
    for (const [alias, typeExpr] of typeDecls) {
      lines.push(`type ${alias} = ${typeExpr};`);
    }
    if (typeDecls.size > 0) lines.push('');

    // Type params (generics) — pass genericDefaults so baseline-detected generics
    // also get type parameter declarations on the interface itself.
    const typeParams = renderTypeParams(model, genericDefaults);

    // Domain interface (camelCase fields) — deduplicate by camelCase name
    const seenDomainFields = new Set<string>();
    if (model.description) {
      lines.push(...docComment(model.description));
    }
    if (model.fields.length === 0) {
      lines.push(`export type ${domainName}${typeParams} = object;`);
    } else {
      lines.push(`export interface ${domainName}${typeParams} {`);
      for (const field of model.fields) {
        const domainFieldName = fieldName(field.name);
        if (seenDomainFields.has(domainFieldName)) continue;
        seenDomainFields.add(domainFieldName);
        if (field.description || field.deprecated || field.readOnly || field.writeOnly || field.default !== undefined) {
          const parts: string[] = [];
          if (field.description) parts.push(field.description);
          if (field.readOnly) parts.push('@readonly');
          if (field.writeOnly) parts.push('@writeonly');
          if (field.default !== undefined) parts.push(`@default ${JSON.stringify(field.default)}`);
          if (field.deprecated) parts.push('@deprecated');
          lines.push(...docComment(parts.join('\n'), 2));
        }
        const baselineField = baselineDomain?.fields?.[domainFieldName];
        // For the domain interface, also check that the response baseline's optionality
        // is compatible — the serializer reads from the response type and assigns to the domain type.
        // If the domain baseline says required but the response baseline says optional,
        // the serializer would produce T | undefined for a field expecting T.
        const domainWireField = wireFieldName(field.name);
        const responseBaselineField = baselineResponse?.fields?.[domainWireField];
        const domainResponseOptionalMismatch =
          baselineField && !baselineField.optional && responseBaselineField && responseBaselineField.optional;
        const readonlyPrefix = field.readOnly ? 'readonly ' : '';
        if (
          baselineField &&
          !domainResponseOptionalMismatch &&
          !hasDateTimeConversion(field.type) &&
          baselineTypeResolvable(baselineField.type, importableNames) &&
          baselineFieldCompatible(baselineField, field)
        ) {
          const opt = baselineField.optional ? '?' : '';
          lines.push(`  ${readonlyPrefix}${domainFieldName}${opt}: ${baselineField.type};`);
        } else {
          // When a baseline exists for this model, new fields (not present in the
          // baseline) are generated as optional.  The merger can deep-merge new
          // fields into existing interfaces, but it cannot update existing
          // deserializer function bodies.  Making the field optional prevents a
          // type error where the interface requires a field that the preserved
          // deserializer never populates.
          const isNewFieldOnExistingModel = baselineDomain && !baselineField;
          // Also make the field optional when the response baseline has it as optional
          // but the domain baseline has it as required — the deserializer reads from
          // the response type, so if the response field is optional, the domain value
          // may be undefined.
          // Additionally, when a baseline exists for the RESPONSE interface but NOT the
          // domain interface, fields that are new on the response baseline become optional
          // in the wire type. The domain type must also be optional to match, otherwise
          // the deserializer produces T | undefined for a field typed as T.
          const isNewFieldOnExistingResponse = !baselineDomain && baselineResponse && !responseBaselineField;
          const opt =
            !field.required ||
            isNewFieldOnExistingModel ||
            domainResponseOptionalMismatch ||
            isNewFieldOnExistingResponse
              ? '?'
              : '';
          lines.push(`  ${readonlyPrefix}${domainFieldName}${opt}: ${mapTypeRef(field.type, modelTypeRefOpts)};`);
        }
      }
      lines.push('}');
    } // close else for non-empty domain interface
    lines.push('');

    // Wire/response interface (snake_case fields) — deduplicate by snake_case name
    const seenWireFields = new Set<string>();
    if (model.fields.length === 0) {
      lines.push(`export type ${responseName}${typeParams} = object;`);
    } else {
      lines.push(`export interface ${responseName}${typeParams} {`);
      for (const field of model.fields) {
        const wireField = wireFieldName(field.name);
        if (seenWireFields.has(wireField)) continue;
        seenWireFields.add(wireField);
        const baselineField = baselineResponse?.fields?.[wireField];
        if (
          baselineField &&
          baselineTypeResolvable(baselineField.type, importableNames) &&
          baselineFieldCompatible(baselineField, field)
        ) {
          const opt = baselineField.optional ? '?' : '';
          lines.push(`  ${wireField}${opt}: ${baselineField.type};`);
        } else {
          const isNewFieldOnExistingModel = baselineResponse && !baselineField;
          const opt = !field.required || isNewFieldOnExistingModel ? '?' : '';
          lines.push(`  ${wireField}${opt}: ${mapWireTypeRef(field.type, modelWireTypeRefOpts)};`);
        }
      }
      lines.push('}');
    } // close else for non-empty wire interface

    // When overwriting an existing interface file, preserve inline types whose
    // sourceFile matches this file but which aren't generated as separate files.
    // Query the apiSurface rather than parsing the target file with regex.
    const filePath = `src/${dirName}/interfaces/${fileName(model.name)}.interface.ts`;
    if (ctx.apiSurface) {
      const generatedNames = new Set<string>();
      for (const line of lines) {
        const m = line.match(/^export\s+(?:interface|type|enum|class|const|function)\s+(\w+)/);
        if (m) generatedNames.add(m[1]);
      }

      // Read the existing file to extract inline declarations verbatim
      if (ctx.targetDir) {
        try {
          const existingContent = fs.readFileSync(path.join(ctx.targetDir, filePath), 'utf-8');
          // Collect names of inline types from the apiSurface
          const inlineNames = new Set<string>();
          const checkSurface = (items: Record<string, any> | undefined) => {
            if (!items) return;
            for (const [name, item] of Object.entries(items)) {
              const src = (item as any).sourceFile as string | undefined;
              if (src !== filePath) continue;
              if (generatedNames.has(name)) continue;
              // Check that no separate file is generated for this type
              const sepPath = `src/${dirName}/interfaces/${fileName(name)}.interface.ts`;
              if (sepPath !== filePath && files.some((f) => f.path === sepPath)) continue;
              inlineNames.add(name);
            }
          };
          checkSurface(ctx.apiSurface.interfaces);
          checkSurface(ctx.apiSurface.typeAliases);
          checkSurface(ctx.apiSurface.enums);

          // Extract each inline type's verbatim declaration from the existing file
          if (inlineNames.size > 0) {
            const existingLines = existingContent.split('\n');
            let ei = 0;
            while (ei < existingLines.length) {
              const eline = existingLines[ei];
              // Match exported or non-exported declarations
              const dm = eline.match(/^(export\s+)?(?:interface|type|enum|class|const|function)\s+(\w+)/);
              if (!dm || !inlineNames.has(dm[2])) {
                ei++;
                continue;
              }

              // Collect the full declaration via brace tracking
              const block: string[] = [eline];
              let braces = (eline.match(/\{/g) || []).length - (eline.match(/\}/g) || []).length;
              if (braces === 0 && eline.includes(';')) {
                lines.push('');
                lines.push(block.join('\n'));
                ei++;
                continue;
              }
              // Multi-line type alias (union with |)
              if (braces === 0) {
                ei++;
                while (ei < existingLines.length) {
                  const nl = existingLines[ei];
                  block.push(nl);
                  ei++;
                  if (
                    nl.trimEnd().endsWith(';') ||
                    (nl.trim() !== '' && !nl.trim().startsWith('|') && !nl.trim().startsWith('&'))
                  )
                    break;
                }
                lines.push('');
                lines.push(block.join('\n'));
                continue;
              }
              // Brace-delimited
              ei++;
              while (ei < existingLines.length && braces > 0) {
                const nl = existingLines[ei];
                block.push(nl);
                braces += (nl.match(/\{/g) || []).length - (nl.match(/\}/g) || []).length;
                ei++;
              }
              lines.push('');
              lines.push(block.join('\n'));
            }
          }
        } catch {
          // No existing file — nothing to preserve
        }
      }
    }

    files.push({
      path: filePath,
      content: pruneUnusedImports(lines).join('\n'),
      overwriteExisting: true,
    });
  }

  return files;
}

/**
 * Check if all PascalCase type references in a baseline type string
 * can be resolved to types that are actually importable in the generated file.
 * A type is importable if it's a builtin, or if it's among the set of names
 * that will be imported (the model's own name/response, or its IR deps).
 * Returns false if any reference is unresolvable (e.g., hand-written types
 * from the live SDK, or spec types from other services not in IR deps).
 */
function baselineTypeResolvable(typeStr: string, importableNames: Set<string>): boolean {
  const matches = typeStr.match(/\b[A-Z][a-zA-Z0-9]*\b/g);
  if (!matches) return true;

  for (const name of matches) {
    if (TS_BUILTINS.has(name)) continue;
    if (importableNames.has(name)) continue;
    return false;
  }
  return true;
}

/**
 * Check if a baseline field type is compatible with the IR field for use
 * in the generated interface. The serializer generates expressions based on
 * the IR type, so the interface type must be assignable from the serializer output.
 *
 * Rejects baseline types when:
 * - IR field is nullable but baseline type doesn't include `null`
 * - IR field is optional but baseline says required (and vice versa)
 * - IR field is required but baseline says optional
 */
function baselineFieldCompatible(baselineField: { type: string; optional: boolean }, irField: Field): boolean {
  const irNullable = irField.type.kind === 'nullable';
  const baselineHasNull = baselineField.type.includes('null');

  // If the IR field is nullable, the serializer produces `expr ?? null`,
  // so the baseline type must include null to be assignable.
  // Exception: for optional fields, the serializer's null guard converts
  // null to undefined (`wireAccess != null ? expr : undefined`), so the
  // result type is `T | undefined` which is compatible with `field?: T`.
  if (irNullable && !baselineHasNull && irField.required) {
    return false;
  }

  // If the IR field is optional, the serializer may produce undefined,
  // so the baseline should also be optional (or include undefined)
  if (!irField.required && !baselineField.optional && !baselineField.type.includes('undefined')) {
    return false;
  }

  // If the IR field is required but the baseline says optional,
  // the serializer produces a definite value but the interface is looser — that's OK
  // (the domain type is wider than the serializer output)

  // If the baseline type is Record<string, unknown> but the IR field has a more specific
  // type (model, enum, or union with named variants), prefer the IR type for better type safety
  if (baselineField.type === 'Record<string, unknown>' && hasSpecificIRType(irField.type)) {
    return false;
  }

  return true;
}

/** Check if an IR type is more specific than Record<string, unknown>. */
function hasSpecificIRType(ref: TypeRef): boolean {
  switch (ref.kind) {
    case 'model':
    case 'enum':
      return true;
    case 'union':
      // A union with named model/enum variants is more specific
      return ref.variants.some((v) => v.kind === 'model' || v.kind === 'enum');
    case 'nullable':
      return hasSpecificIRType(ref.inner);
    default:
      return false;
  }
}

function renderTypeParams(model: Model, genericDefaults?: Map<string, string>): string {
  if (!model.typeParams?.length) {
    // Fallback: if genericDefaults indicates this model is generic (detected
    // from the baseline), generate a default generic type parameter declaration.
    if (genericDefaults?.has(model.name)) {
      return '<GenericType extends Record<string, unknown> = Record<string, unknown>>';
    }
    return '';
  }
  const params = model.typeParams.map((tp) => {
    const def = tp.default ? ` = ${mapTypeRef(tp.default)}` : '';
    return `${tp.name}${def}`;
  });
  return `<${params.join(', ')}>`;
}

// ---------------------------------------------------------------------------
// Shared context — computed once and reused by interface + serializer passes
// ---------------------------------------------------------------------------

interface SharedModelContext {
  modelToService: Map<string, string>;
  resolveDir: (irService: string | undefined) => string;
  dedup: Map<string, string>;
  genericDefaults: Map<string, string>;
}

function buildSharedContext(models: Model[], ctx: EmitterContext): SharedModelContext {
  const { modelToService, resolveDir } = createServiceDirResolver(models, ctx.spec.services, ctx);
  const genericDefaults = buildGenericModelDefaults(ctx.spec.models);
  enrichGenericDefaultsFromBaseline(genericDefaults, models, ctx, resolveDir, modelToService);
  const nonEventReachable = computeNonEventReachable(ctx.spec.services, models);
  const dedup = buildDeduplicationMap(models, ctx, nonEventReachable);
  return { modelToService, resolveDir, dedup, genericDefaults };
}

// ---------------------------------------------------------------------------
// Serializer file generation (moved from serializers.ts)
// ---------------------------------------------------------------------------

/**
 * Generate serializer files for all models.
 * Can accept pre-computed shared context to avoid duplicating work
 * when called alongside generateModels.
 */
export function generateSerializers(
  models: Model[],
  ctx: EmitterContext,
  shared?: SharedModelContext,
): GeneratedFile[] {
  if (models.length === 0) return [];

  const { modelToService, resolveDir, dedup } = shared ?? buildSharedContext(models, ctx);
  const files: GeneratedFile[] = [];
  const skippedSerializeModels = new Set<string>();

  // Reuse the same reachability set from generateModels to skip serializers
  // for unreachable models (e.g., event/webhook payload types).
  const serializerReachable = computeNonEventReachable(ctx.spec.services, models);

  // Pre-populate skippedSerializeModels for baseline models that won't be
  // regenerated. Their existing serializers may only export deserialize.
  if (ctx.targetDir) {
    for (const model of models) {
      if (!serializerReachable.has(model.name)) continue;
      if (modelHasNewFields(model, ctx)) continue; // will be regenerated
      const service = modelToService.get(model.name);
      const dirName = resolveDir(service);
      const domainName = resolveInterfaceName(model.name, ctx);
      const serializerFile = path.join(
        ctx.targetDir,
        'src',
        dirName,
        'serializers',
        `${fileName(model.name)}.serializer.ts`,
      );
      try {
        const content = fs.readFileSync(serializerFile, 'utf-8');
        if (!new RegExp(`\\bserialize${domainName}\\b`).test(content)) {
          skippedSerializeModels.add(model.name);
        }
      } catch {
        // Serializer doesn't exist — model may be new or generated differently
      }
    }
  }

  // Force-generate serializers for inline dependency models (same logic as interfaces).
  const forceGenerateSerializer = new Set<string>();
  for (const model of models) {
    if (!serializerReachable.has(model.name)) continue;
    if (!modelHasNewFields(model, ctx)) continue;
    const service = modelToService.get(model.name);
    const dirName = resolveDir(service);
    const parentPath = `src/${dirName}/interfaces/${fileName(model.name)}.interface.ts`;
    const deps = collectFieldDependencies(model);
    for (const dep of deps.models) {
      const depName = resolveInterfaceName(dep, ctx);
      const depBaseline = ctx.apiSurface?.interfaces?.[depName];
      const depSrc = (depBaseline as any)?.sourceFile as string | undefined;
      if (depSrc === parentPath) {
        forceGenerateSerializer.add(dep);
      }
    }
  }

  // --- Pass 1: pre-compute which models skip serialize (ordering-independent) ---
  // This must run BEFORE file generation so that buildSerializerImports can
  // check the fully-populated set and avoid importing non-existent serialize functions.
  const eligibleModels: Model[] = [];
  for (const model of models) {
    if (!serializerReachable.has(model.name)) continue;
    if (isListMetadataModel(model)) continue;
    if (isListWrapperModel(model)) continue;
    if (!modelHasNewFields(model, ctx) && !forceGenerateSerializer.has(model.name)) continue;
    eligibleModels.push(model);
  }

  // First pass: determine shouldSkipSerialize for every eligible model
  for (const model of eligibleModels) {
    if (dedup.has(model.name)) continue; // dedup aliases don't get their own serialize
    const domainName = resolveInterfaceName(model.name, ctx);
    const responseName = wireInterfaceName(domainName);
    const baselineResponse = ctx.apiSurface?.interfaces?.[responseName];
    const baselineDomain = ctx.apiSurface?.interfaces?.[domainName];
    const shouldSkip = shouldSkipSerializeForModel(
      model,
      baselineResponse,
      baselineDomain,
      dedup,
      skippedSerializeModels,
      ctx,
    );
    if (shouldSkip) {
      skippedSerializeModels.add(model.name);
    }
  }

  // --- Pass 2: generate serializer files using fully-populated skip set ---
  for (const model of eligibleModels) {
    // Deduplication: for structurally identical models, re-export the canonical serializer
    const canonicalName = dedup.get(model.name);
    if (canonicalName) {
      const service = modelToService.get(model.name);
      const dirName = resolveDir(service);
      // Skip typeAlias resolution for dedup serializers (same reason as interfaces).
      const skipTA = { skipTypeAlias: true };
      const domainName = resolveInterfaceName(model.name, ctx, skipTA);
      const canonDomainName = resolveInterfaceName(canonicalName, ctx, skipTA);

      const canonService = modelToService.get(canonicalName);
      const canonDir = resolveDir(canonService);
      const serializerPath = `src/${dirName}/serializers/${fileName(model.name)}.serializer.ts`;
      const canonSerializerPath = `src/${canonDir}/serializers/${fileName(canonicalName)}.serializer.ts`;

      // After noise suffix stripping, alias and canonical may resolve to the
      // same serializer path or the same function names.  Skip — the canonical
      // serializer already provides the functions.
      if (serializerPath === canonSerializerPath) continue;
      if (domainName === canonDomainName) continue;
      const rel = relativeImport(serializerPath, canonSerializerPath);
      const canonSkipSerialize = skippedSerializeModels.has(canonicalName) || skippedSerializeModels.has(model.name);
      const reexportContent = canonSkipSerialize
        ? `export { deserialize${canonDomainName} as deserialize${domainName} } from '${rel}';`
        : `export { deserialize${canonDomainName} as deserialize${domainName}, serialize${canonDomainName} as serialize${domainName} } from '${rel}';`;
      files.push({
        path: serializerPath,
        content: reexportContent,
        overwriteExisting: true,
      });
      continue;
    }

    const service = modelToService.get(model.name);
    const dirName = resolveDir(service);
    const isDedupCanonical = [...dedup.values()].includes(model.name);
    const domainName = resolveInterfaceName(model.name, ctx, isDedupCanonical ? { skipTypeAlias: true } : undefined);
    const responseName = wireInterfaceName(domainName);
    const serializerPath = `src/${dirName}/serializers/${fileName(model.name)}.serializer.ts`;
    const typeParams = renderSerializerTypeParams(model, ctx);
    const baselineResponse = ctx.apiSurface?.interfaces?.[responseName];
    const baselineDomain = ctx.apiSurface?.interfaces?.[domainName];

    const skipFormatFields = buildSkipFormatFields(model, baselineDomain);
    const shouldSkipSerialize = skippedSerializeModels.has(model.name);

    const sctx = { modelToService, resolveDir, dedup, skippedSerializeModels, ctx };
    const lines = [
      ...buildSerializerImports(model, serializerPath, dirName, domainName, responseName, sctx),
      ...emitSerializerBody(
        model,
        domainName,
        responseName,
        typeParams,
        baselineDomain,
        baselineResponse,
        skipFormatFields,
        shouldSkipSerialize,
        ctx,
      ),
    ];

    files.push({
      path: serializerPath,
      content: pruneUnusedImports(lines).join('\n'),
      overwriteExisting: true,
    });
  }

  // Stash the fully-computed skip set on the context so the test generator
  // can read it without duplicating the detection logic.
  (ctx as any)._skippedSerializeModels = skippedSerializeModels;

  return files;
}

// ---------------------------------------------------------------------------
// Combined generation — single shared context, two output streams
// ---------------------------------------------------------------------------

/**
 * Generate both interface files and serializer files in a single pass
 * with shared context computation.
 */
export function generateModelsAndSerializers(models: Model[], ctx: EmitterContext): GeneratedFile[] {
  if (models.length === 0) return [];
  const shared = buildSharedContext(models, ctx);
  return [...generateModels(models, ctx, shared), ...generateSerializers(models, ctx, shared)];
}
