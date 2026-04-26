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

// ---------------------------------------------------------------------------
// Shared context
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
    if (genericDefaults.has(model.name)) continue;
    const domainName = resolveInterfaceName(model.name, ctx);
    const baseline = ctx.apiSurface.interfaces[domainName];
    if (!baseline?.fields) continue;

    const generatedPath = `src/${resolveDir(modelToService.get(model.name))}/interfaces/${fileName(model.name)}.interface.ts`;
    const baselineSourceFile = (baseline as any).sourceFile as string | undefined;
    if (baselineSourceFile && baselineSourceFile !== generatedPath) continue;

    if (isBaselineGeneric(baseline.fields, knownNames)) {
      genericDefaults.set(model.name, '<Record<string, unknown>>');
    }
  }
}

// ---------------------------------------------------------------------------
// Interface generation
// ---------------------------------------------------------------------------

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

  const reachableModels = computeNonEventReachable(ctx.spec.services, models);

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
        forceGenerate.add(dep);
      }
    }
  }

  for (const model of models) {
    if (!reachableModels.has(model.name)) continue;
    if (isListMetadataModel(model)) continue;
    if (isListWrapperModel(model)) continue;
    if (!modelHasNewFields(model, ctx) && !forceGenerate.has(model.name)) continue;

    const canonicalName = dedup.get(model.name);
    if (canonicalName) {
      const service = modelToService.get(model.name);
      const dirName = resolveDir(service);
      const skipTA = { skipTypeAlias: true };
      const domainName = resolveInterfaceName(model.name, ctx, skipTA);
      const responseName = wireInterfaceName(domainName);
      const canonDomainName = resolveInterfaceName(canonicalName, ctx, skipTA);
      const canonResponseName = wireInterfaceName(canonDomainName);

      const canonService = modelToService.get(canonicalName);
      const canonDir = resolveDir(canonService);

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
    const isDedupCanonical = [...dedup.values()].includes(model.name);
    const domainName = resolveInterfaceName(model.name, ctx, isDedupCanonical ? { skipTypeAlias: true } : undefined);
    const responseName = wireInterfaceName(domainName);
    const deps = collectFieldDependencies(model);
    const lines: string[] = [];

    let modelTypeRefOpts = typeRefOpts;
    let modelWireTypeRefOpts = wireTypeRefOpts;
    if (genericDefaults.has(model.name)) {
      const filteredDefaults = new Map(genericDefaults);
      filteredDefaults.delete(model.name);
      modelTypeRefOpts = { ...typeRefOpts, genericDefaults: filteredDefaults };
      modelWireTypeRefOpts = { genericDefaults: filteredDefaults };
    }

    const baselineDomain = ctx.apiSurface?.interfaces?.[domainName];
    const baselineResponse = ctx.apiSurface?.interfaces?.[responseName];

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

    const typeDecls = new Map<string, string>();
    const crossServiceImports = new Map<string, { name: string; relPath: string }>();
    const unresolvableNames = new Set<string>();
    const enumToService = assignEnumsToServices(ctx.spec.enums, ctx.spec.services);
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

          const irEnumName = resolvedEnumNames.get(name);
          if (irEnumName && !deps.enums.has(irEnumName)) {
            const eService = enumToService.get(irEnumName);
            const eDir = resolveDir(eService);
            const bEnum = ctx.apiSurface?.enums?.[irEnumName];
            const bAlias = ctx.apiSurface?.typeAliases?.[irEnumName];
            const bSrc = (bEnum as any)?.sourceFile ?? (bAlias as any)?.sourceFile;
            const gPath = `src/${eDir}/interfaces/${fileName(irEnumName)}.interface.ts`;
            const cPath = `src/${dirName}/interfaces/${fileName(model.name)}.interface.ts`;
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

          const candidates = [...importableNames].filter((n) => n.endsWith(name) && n !== name);
          if (candidates.length === 1) {
            typeDecls.set(name, candidates[0]);
            importableNames.add(name);
          } else {
            unresolvableNames.add(name);
          }
        }
      }
    }

    for (const dep of deps.models) {
      const depName = resolveInterfaceName(dep, ctx);
      const depService = modelToService.get(dep);
      const depDir = resolveDir(depService);
      const relPath =
        depDir === dirName ? `./${fileName(dep)}.interface` : `../../${depDir}/interfaces/${fileName(dep)}.interface`;
      lines.push(`import type { ${depName}, ${wireInterfaceName(depName)} } from '${relPath}';`);
    }
    for (const dep of deps.enums) {
      const baselineEnum = ctx.apiSurface?.enums?.[dep];
      const baselineAlias = ctx.apiSurface?.typeAliases?.[dep];
      const baselineSrc = (baselineEnum as any)?.sourceFile ?? (baselineAlias as any)?.sourceFile;
      const depService = enumToService.get(dep);
      const depDir = resolveDir(depService);
      const generatedPath = `src/${depDir}/interfaces/${fileName(dep)}.interface.ts`;
      const currentFilePath = `src/${dirName}/interfaces/${fileName(model.name)}.interface.ts`;

      if (baselineSrc === currentFilePath) {
        importableNames.add(dep);
        continue;
      }

      let relPath: string;
      if (baselineSrc && baselineSrc !== generatedPath) {
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

    for (const [alias, typeExpr] of typeDecls) {
      lines.push(`type ${alias} = ${typeExpr};`);
    }
    if (typeDecls.size > 0) lines.push('');

    const typeParams = renderTypeParams(model, genericDefaults);

    // Domain interface
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
          const isNewFieldOnExistingModel = baselineDomain && !baselineField;
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
    }
    lines.push('');

    // Wire/response interface
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
    }

    // Preserve inline types from existing file
    const filePath = `src/${dirName}/interfaces/${fileName(model.name)}.interface.ts`;
    if (ctx.apiSurface && ctx.targetDir) {
      const generatedNames = new Set<string>();
      for (const line of lines) {
        const m = line.match(/^export\s+(?:interface|type|enum|class|const|function)\s+(\w+)/);
        if (m) generatedNames.add(m[1]);
      }

      try {
        const existingContent = fs.readFileSync(path.join(ctx.targetDir, filePath), 'utf-8');
        const inlineNames = new Set<string>();
        const checkSurface = (items: Record<string, any> | undefined) => {
          if (!items) return;
          for (const [name, item] of Object.entries(items)) {
            const src = (item as any).sourceFile as string | undefined;
            if (src !== filePath) continue;
            if (generatedNames.has(name)) continue;
            const sepPath = `src/${dirName}/interfaces/${fileName(name)}.interface.ts`;
            if (sepPath !== filePath && files.some((f) => f.path === sepPath)) continue;
            inlineNames.add(name);
          }
        };
        checkSurface(ctx.apiSurface.interfaces);
        checkSurface(ctx.apiSurface.typeAliases);
        checkSurface(ctx.apiSurface.enums);

        if (inlineNames.size > 0) {
          const existingLines = existingContent.split('\n');
          let ei = 0;
          while (ei < existingLines.length) {
            const eline = existingLines[ei];
            const dm = eline.match(/^(export\s+)?(?:interface|type|enum|class|const|function)\s+(\w+)/);
            if (!dm || !inlineNames.has(dm[2])) {
              ei++;
              continue;
            }

            const block: string[] = [eline];
            let braces = (eline.match(/\{/g) || []).length - (eline.match(/\}/g) || []).length;
            if (braces === 0 && eline.includes(';')) {
              lines.push('');
              lines.push(block.join('\n'));
              ei++;
              continue;
            }
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
        // No existing file
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

// ---------------------------------------------------------------------------
// Serializer generation
// ---------------------------------------------------------------------------

export function generateSerializers(
  models: Model[],
  ctx: EmitterContext,
  shared?: SharedModelContext,
): GeneratedFile[] {
  if (models.length === 0) return [];

  const { modelToService, resolveDir, dedup } = shared ?? buildSharedContext(models, ctx);
  const files: GeneratedFile[] = [];
  const skippedSerializeModels = new Set<string>();

  const serializerReachable = computeNonEventReachable(ctx.spec.services, models);

  if (ctx.targetDir) {
    for (const model of models) {
      if (!serializerReachable.has(model.name)) continue;
      if (modelHasNewFields(model, ctx)) continue;
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
        // Serializer doesn't exist
      }
    }
  }

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

  const eligibleModels: Model[] = [];
  for (const model of models) {
    if (!serializerReachable.has(model.name)) continue;
    if (isListMetadataModel(model)) continue;
    if (isListWrapperModel(model)) continue;
    if (!modelHasNewFields(model, ctx) && !forceGenerateSerializer.has(model.name)) continue;
    eligibleModels.push(model);
  }

  // Pass 1: determine shouldSkipSerialize
  for (const model of eligibleModels) {
    if (dedup.has(model.name)) continue;
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

  // Pass 2: generate serializer files
  for (const model of eligibleModels) {
    const canonicalName = dedup.get(model.name);
    if (canonicalName) {
      const service = modelToService.get(model.name);
      const dirName = resolveDir(service);
      const skipTA = { skipTypeAlias: true };
      const domainName = resolveInterfaceName(model.name, ctx, skipTA);
      const canonDomainName = resolveInterfaceName(canonicalName, ctx, skipTA);

      const canonService = modelToService.get(canonicalName);
      const canonDir = resolveDir(canonService);
      const serializerPath = `src/${dirName}/serializers/${fileName(model.name)}.serializer.ts`;
      const canonSerializerPath = `src/${canonDir}/serializers/${fileName(canonicalName)}.serializer.ts`;

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

  (ctx as any)._skippedSerializeModels = skippedSerializeModels;

  return files;
}

// ---------------------------------------------------------------------------
// Combined generation
// ---------------------------------------------------------------------------

export function generateModelsAndSerializers(models: Model[], ctx: EmitterContext): GeneratedFile[] {
  if (models.length === 0) return [];
  const shared = buildSharedContext(models, ctx);
  return [...generateModels(models, ctx, shared), ...generateSerializers(models, ctx, shared)];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function baselineFieldCompatible(baselineField: { type: string; optional: boolean }, irField: Field): boolean {
  const irNullable = irField.type.kind === 'nullable';
  const baselineHasNull = baselineField.type.includes('null');

  if (irNullable && !baselineHasNull && irField.required) {
    return false;
  }

  if (!irField.required && !baselineField.optional && !baselineField.type.includes('undefined')) {
    return false;
  }

  if (baselineField.type === 'Record<string, unknown>' && hasSpecificIRType(irField.type)) {
    return false;
  }

  return true;
}

function hasSpecificIRType(ref: TypeRef): boolean {
  switch (ref.kind) {
    case 'model':
    case 'enum':
      return true;
    case 'union':
      return ref.variants.some((v) => v.kind === 'model' || v.kind === 'enum');
    case 'nullable':
      return hasSpecificIRType(ref.inner);
    default:
      return false;
  }
}

function renderTypeParams(model: Model, genericDefaults?: Map<string, string>): string {
  if (!model.typeParams?.length) {
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
