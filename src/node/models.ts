import fs from 'node:fs';
import path from 'node:path';
import type { Model, Field, TypeRef, EmitterContext, GeneratedFile, Operation, Service } from '@workos/oagen';
import { planOperation } from '@workos/oagen';
import { mapTypeRef, mapWireTypeRef, isInlineEnum } from './type-map.js';
import {
  fieldName,
  wireFieldName,
  fileName,
  resolveInterfaceName,
  wireInterfaceName,
  resolveMethodName,
  isAdoptedModelName,
} from './naming.js';
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
  collectNonPaginatedResponseModelNames,
  collectReferencedListMetadataModels,
  buildDeduplicationMap,
  relativeImport,
  modelHasNewFields,
  computeNonEventReachable,
  isServiceCoveredByExisting,
  hasMethodsAbsentFromBaseline,
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
import { liveSurfaceHasExistingSdk, liveSurfaceHasManagedFile } from './live-surface.js';
import { isNodeOwnedService } from './options.js';
import { unwrapListModel } from './fixtures.js';
import { groupByMount, buildResolvedLookup, lookupResolved } from '../shared/resolved-ops.js';
import { resolveWrapperParams } from '../shared/wrapper-utils.js';
import { collectWrapperResponseModels } from './wrappers.js';
import { resolveResourceClassName } from './resources.js';

// ---------------------------------------------------------------------------
// Shared context
// ---------------------------------------------------------------------------

interface SharedModelContext {
  modelToService: Map<string, string>;
  resolveDir: (irService: string | undefined) => string;
  dedup: Map<string, string>;
  genericDefaults: Map<string, string>;
}

interface GeneratedResourceModelUsage {
  interfaceRoots: Set<string>;
  serializerRoots: Set<string>;
  /** Models that are directly used as a request body. Drive `serialize<X>`. */
  requestRoots: Set<string>;
  /** Models that are directly used as a response body. Drive `deserialize<X>`. */
  responseRoots: Set<string>;
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

function projectModelToManagedSurface(model: Model, shared: SharedModelContext, ctx: EmitterContext): Model {
  if (!ctx.outputDir && !ctx.targetDir) return model;
  if (!liveSurfaceHasExistingSdk()) return model;
  const fields = model.fields.filter((field) => isSupportedFieldType(field.type, model.name, shared, ctx));
  return fields.length === model.fields.length ? model : { ...model, fields };
}

function isSupportedFieldType(
  ref: TypeRef,
  ownerModelName: string,
  shared: SharedModelContext,
  ctx: EmitterContext,
): boolean {
  switch (ref.kind) {
    case 'primitive':
    case 'literal':
    case 'map':
      return true;
    case 'model': {
      if (ref.name === ownerModelName) return true;
      const resolvedName = resolveInterfaceName(ref.name, ctx);
      if (ctx.apiSurface?.interfaces?.[resolvedName] || ctx.apiSurface?.typeAliases?.[resolvedName]) return true;
      // Adopted-service models will have their interfaces emitted in this
      // same pass, so the field reference will resolve once writing is done.
      // Without this, fields like `UserManagementLoginRequest.user` get
      // silently dropped on first emission because the target interface
      // (`UserObject` under the adopted `connect/` dir) hasn't landed yet.
      if (isAdoptedModelName(ref.name)) return true;
      // Synthetic models produced by `enrichModelsFromSpec` (e.g. the
      // inline-object item type for `ConnectApplication.redirect_uris`)
      // are added to the models list passed into this generation pass —
      // and hence into `shared.modelToService` — but won't yet exist on
      // disk or in `apiSurface`. Accept them so their parent field
      // survives field-projection.
      if (shared.modelToService.has(ref.name)) return true;
      const relPath = `src/${shared.resolveDir(shared.modelToService.get(ref.name))}/interfaces/${fileName(ref.name)}.interface.ts`;
      return liveSurfaceHasManagedFile(relPath);
    }
    case 'enum': {
      if (ctx.apiSurface?.enums?.[ref.name] || ctx.apiSurface?.typeAliases?.[ref.name]) return true;
      const enumService = assignEnumsToServices(ctx.spec.enums, ctx.spec.services, ctx.spec.models, ctx).get(ref.name);
      if (enumService) return true;
      const relPath = `src/${shared.resolveDir(enumService)}/interfaces/${fileName(ref.name)}.interface.ts`;
      return liveSurfaceHasManagedFile(relPath);
    }
    case 'array':
      return isSupportedFieldType(ref.items, ownerModelName, shared, ctx);
    case 'nullable':
      return isSupportedFieldType(ref.inner, ownerModelName, shared, ctx);
    case 'union':
      return ref.variants.every((variant) => isSupportedFieldType(variant, ownerModelName, shared, ctx));
    default:
      return true;
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
  const projectedModels = models.map((model) =>
    projectModelToManagedSurface(model, { modelToService, resolveDir, dedup, genericDefaults }, ctx),
  );
  const projectedByName = new Map(projectedModels.map((model) => [model.name, model]));
  const resourceUsage = buildGeneratedResourceModelUsage(models, ctx);
  const interfaceEligibleModels = resourceUsage
    ? expandModelRoots(resourceUsage.interfaceRoots, projectedByName)
    : undefined;

  const reachableModels = computeNonEventReachable(ctx.spec.services, models);

  const forceGenerate = new Set<string>();
  for (const originalModel of models) {
    const model = projectedByName.get(originalModel.name) ?? originalModel;
    if (!reachableModels.has(model.name)) continue;
    if (interfaceEligibleModels && !interfaceEligibleModels.has(model.name)) continue;
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

  const discriminatedSkip = (ctx as { _discriminatedModelNames?: Set<string> })._discriminatedModelNames;
  // Wrappers referenced as a non-paginated response (e.g. `VersionListResponse`
  // for `GET /vault/v1/kv/{id}/versions`) must still be emitted — the resource
  // code references them by name and pagination iterators don't unwrap them.
  const nonPaginatedRefs = collectNonPaginatedResponseModelNames(ctx.spec.services);

  // ListMetadata-shape models are usually subsumed by the SDK's shared
  // pagination wrapper, so we blanket-skip them. But a non-paginated
  // wrapper like vault's `VersionListResponse` keeps the reference live
  // (`list_metadata: ListMetadata`), and skipping the emission leaves the
  // wrapper's interface importing from a file that was never written.
  const listMetadataNeeded = collectReferencedListMetadataModels(models, nonPaginatedRefs);

  for (const originalModel of models) {
    const model = projectedByName.get(originalModel.name) ?? originalModel;
    if (!reachableModels.has(model.name)) continue;
    if (interfaceEligibleModels && !interfaceEligibleModels.has(model.name)) continue;
    const service = modelToService.get(model.name);
    const isOwnedModel = isNodeOwnedService(ctx, service);
    if (!isOwnedModel && !modelHasNewFields(model, ctx) && !forceGenerate.has(model.name)) continue;
    const canonicalName = dedup.get(model.name);
    if (canonicalName) {
      forceGenerate.add(canonicalName);
      if (interfaceEligibleModels) interfaceEligibleModels.add(canonicalName);
    }
  }

  for (const originalModel of models) {
    const model = projectedByName.get(originalModel.name) ?? originalModel;
    if (!reachableModels.has(model.name)) continue;
    if (interfaceEligibleModels && !interfaceEligibleModels.has(model.name)) continue;
    if (isListMetadataModel(model) && !listMetadataNeeded.has(model.name)) continue;
    if (isListWrapperModel(model) && !nonPaginatedRefs.has(model.name)) continue;
    if (discriminatedSkip?.has(model.name)) continue;
    const service = modelToService.get(model.name);
    const isOwnedModel = isNodeOwnedService(ctx, service);
    if (!isOwnedModel && !modelHasNewFields(model, ctx) && !forceGenerate.has(model.name)) continue;

    const canonicalName = dedup.get(model.name);
    if (canonicalName && !isOwnedModel) {
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

      // Single-form aliases: when the resolver collapses the IR model and
      // its wire form to the same baseline name (or the alias's own
      // domain/wire shapes coincide), emit only the unique exports. The
      // earlier code unconditionally emitted both `export type X = Y;` and
      // `export type X' = Y';` lines, producing TS2300 duplicate-identifier
      // errors when X === X' and Y === Y'.
      const aliasExports: string[] = [];
      const importNeeded = new Set<string>();
      const declared = new Set<string>();
      const pushAlias = (lhs: string, rhs: string): void => {
        if (lhs === rhs) return;
        if (declared.has(lhs)) return;
        declared.add(lhs);
        aliasExports.push(`export type ${lhs} = ${rhs};`);
        importNeeded.add(rhs);
      };
      pushAlias(domainName, canonDomainName);
      pushAlias(responseName, canonResponseName);
      if (aliasExports.length === 0) continue;

      // Only import names that are referenced on the RHS of an alias AND
      // aren't declared locally (which would shadow / collide with the
      // import).
      const importSymbols = [...importNeeded]
        .filter((n) => !declared.has(n))
        .sort()
        .join(', ');
      const aliasLines = importSymbols
        ? [`import type { ${importSymbols} } from '${canonRelPath}';`, '', ...aliasExports]
        : [...aliasExports];
      files.push({
        path: aliasPath,
        content: aliasLines.join('\n'),
        overwriteExisting: true,
      });
      continue;
    }

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
    const enumToService = assignEnumsToServices(ctx.spec.enums, ctx.spec.services, ctx.spec.models, ctx);
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
      const depIsOwned = isNodeOwnedService(ctx, depService);

      // When the resolver maps the IR name to a different baseline interface
      // (via `overlayLookup.modelNameByIR` structural match), the import
      // path must follow the baseline's `sourceFile`. Otherwise we'd point
      // at the IR-named file (e.g. `audit-log-event.interface`) that the
      // emitter never generates — the canonical baseline file is at a
      // different stem (e.g. `create-audit-log-event-options.interface`).
      const currentFilePath = `src/${dirName}/interfaces/${fileName(model.name)}.interface.ts`;
      const baselineSrc = depIsOwned
        ? undefined
        : (ctx.apiSurface?.interfaces?.[depName] as { sourceFile?: string } | undefined)?.sourceFile;

      // Self-reference: the dependency lives in the file we're currently
      // emitting. Skip the import — it's already in scope.
      if (baselineSrc === currentFilePath) continue;

      let relPath: string;
      if (baselineSrc) {
        relPath = relativeImport(currentFilePath, baselineSrc).replace(/\.ts$/, '');
      } else {
        relPath =
          depDir === dirName ? `./${fileName(dep)}.interface` : `../../${depDir}/interfaces/${fileName(dep)}.interface`;
      }

      // `wireInterfaceName` consults the baseline interface set so it
      // returns the bare `depName` when the resolver mapped to a
      // single-form interface (no separate `*Wire`). That keeps the
      // import statement requesting only what the baseline file exports.
      const wireName = wireInterfaceName(depName);
      const importNames = wireName === depName ? depName : `${depName}, ${wireName}`;
      lines.push(`import type { ${importNames} } from '${relPath}';`);
    }
    for (const dep of deps.enums) {
      // Inlined enums are emitted as literal unions at the usage site
      // (handled by type-map). Skip the import — the file does not exist.
      if (isInlineEnum(dep)) continue;

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

    // Type-alias declarations are pre-collected from baseline field types.
    // The IR-driven body may end up not using them (the body uses the
    // resolved interface names, while aliases serve only as bridges from
    // baseline-name references inside `baselineField.type`). Defer their
    // emission, then filter to only those names actually referenced in
    // the body or wire interface lines.
    const typeDeclInsertIdx = lines.length;
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
          // Preserve baseline-declared optionality even when we're emitting
          // the IR-derived type (e.g. baseline `Date` for an IR string with
          // `format: date-time`). Without this, regenerating an existing
          // interface flips `external_id?: string` into `external_id: string
          // | null`, which silently breaks every hand-written test fixture
          // missing that field.
          const baselineSaysOptional = baselineField?.optional === true;
          const opt =
            baselineSaysOptional ||
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

    // Wire/response interface — skip when the wire name collapsed onto the
    // domain name (single-form structural-rename case, e.g. IR `Object` →
    // `ReadObjectResponse`). Emitting the second declaration would either
    // produce a literal duplicate `export interface ReadObjectResponse`
    // pair or, after TypeScript's silent declaration merge, leave the
    // call site with `import type { ReadObjectResponse, ReadObjectResponse }`.
    if (responseName !== domainName) {
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
            // Same baseline-optional preservation as the domain side. The
            // wire interface's optional flag drives test-fixture shape, so
            // flipping it on regen breaks every fixture that omitted the
            // field assuming it was optional.
            const baselineSaysOptional = baselineField?.optional === true;
            const opt = baselineSaysOptional || !field.required || isNewFieldOnExistingModel ? '?' : '';
            lines.push(`  ${wireField}${opt}: ${mapWireTypeRef(field.type, modelWireTypeRefOpts)};`);
          }
        }
        lines.push('}');
      }
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

    // Splice in only the type aliases referenced by the body or wire lines.
    if (typeDecls.size > 0) {
      const bodyText = lines.slice(typeDeclInsertIdx).join('\n');
      const usedDecls: string[] = [];
      for (const [alias, typeExpr] of typeDecls) {
        if (new RegExp(`\\b${alias}\\b`).test(bodyText)) {
          usedDecls.push(`type ${alias} = ${typeExpr};`);
        }
      }
      if (usedDecls.length > 0) {
        lines.splice(typeDeclInsertIdx, 0, ...usedDecls, '');
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
  const projectedModels = models.map((model) =>
    projectModelToManagedSurface(model, { modelToService, resolveDir, dedup, genericDefaults: new Map() }, ctx),
  );
  const projectedByName = new Map(projectedModels.map((model) => [model.name, model]));
  const resourceUsage = buildGeneratedResourceModelUsage(models, ctx);
  const serializerEligibleModels = resourceUsage
    ? expandModelRoots(resourceUsage.serializerRoots, projectedByName)
    : undefined;
  // Models reachable from any response — only these need a `deserialize<X>`.
  // A model used solely as a request body (e.g. `CreateWebhookEndpoint`)
  // would otherwise emit a deserializer with a partial response shape that
  // silently misbehaves if called. Undefined means "no resource usage info,
  // emit both halves" (standalone generation, smoke tests).
  const responseReachableModels = resourceUsage
    ? expandModelRoots(resourceUsage.responseRoots, projectedByName)
    : undefined;
  // Models reachable from any request — only these need a `serialize<X>`.
  // A model used solely as a response body can safely be deserialize-only;
  // emitting its serialize half is both unused and brittle when it contains
  // legacy nested response models that intentionally have no serialize helper.
  const requestReachableModels = resourceUsage
    ? expandModelRoots(resourceUsage.requestRoots, projectedByName)
    : undefined;

  const serializerReachable = computeNonEventReachable(ctx.spec.services, models);

  // Detect models whose serializer file already exists in the live SDK but
  // does not export a `serialize<Domain>` function. Generated serializers
  // that reference such a model must skip their `serialize` half — calling
  // a missing function would leave the SDK unable to compile.
  const liveRoot = ctx.targetDir ?? ctx.outputDir;
  if (liveRoot) {
    for (const originalModel of models) {
      const model = projectedByName.get(originalModel.name) ?? originalModel;
      if (!serializerReachable.has(model.name)) continue;
      if (serializerEligibleModels && !serializerEligibleModels.has(model.name)) continue;
      const service = modelToService.get(model.name);
      const dirName = resolveDir(service);
      const domainName = resolveInterfaceName(model.name, ctx);
      const baselineSource = (ctx.apiSurface?.interfaces?.[domainName] as { sourceFile?: string } | undefined)
        ?.sourceFile;
      const serializerRelPath = baselineSource
        ? baselineSource.replace('/interfaces/', '/serializers/').replace('.interface.ts', '.serializer.ts')
        : `src/${dirName}/serializers/${fileName(model.name)}.serializer.ts`;
      const serializerFile = path.join(liveRoot, serializerRelPath);
      try {
        const content = fs.readFileSync(serializerFile, 'utf-8');
        const isGeneratedFile =
          ctx.priorTargetManifestPaths?.has(serializerRelPath) ||
          /auto-generated by oagen/i.test(content.slice(0, 400));
        if (!isGeneratedFile && !new RegExp(`\\bserialize${domainName}\\b`).test(content)) {
          skippedSerializeModels.add(model.name);
        }
      } catch {
        // Serializer doesn't exist on disk yet — fine, we'll generate one.
      }
    }
  }

  const forceGenerateSerializer = new Set<string>();
  for (const originalModel of models) {
    const model = projectedByName.get(originalModel.name) ?? originalModel;
    if (!serializerReachable.has(model.name)) continue;
    if (serializerEligibleModels && !serializerEligibleModels.has(model.name)) continue;
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

  const discriminatedSerializerSkip = (ctx as { _discriminatedModelNames?: Set<string> })._discriminatedModelNames;
  const serializerNonPaginatedRefs = collectNonPaginatedResponseModelNames(ctx.spec.services);

  // Mirror the interface-emission gate (see `generateModels`).
  const serializerListMetadataNeeded = collectReferencedListMetadataModels(models, serializerNonPaginatedRefs);

  for (const originalModel of models) {
    const model = projectedByName.get(originalModel.name) ?? originalModel;
    if (!serializerReachable.has(model.name)) continue;
    if (serializerEligibleModels && !serializerEligibleModels.has(model.name)) continue;
    const service = modelToService.get(model.name);
    const isOwnedModel = isNodeOwnedService(ctx, service);
    if (!isOwnedModel && !modelHasNewFields(model, ctx) && !forceGenerateSerializer.has(model.name)) continue;
    const canonicalName = dedup.get(model.name);
    if (canonicalName) {
      forceGenerateSerializer.add(canonicalName);
      if (serializerEligibleModels) serializerEligibleModels.add(canonicalName);
    }
  }

  const eligibleModels: Model[] = [];
  for (const originalModel of models) {
    const model = projectedByName.get(originalModel.name) ?? originalModel;
    if (!serializerReachable.has(model.name)) continue;
    if (serializerEligibleModels && !serializerEligibleModels.has(model.name)) continue;
    if (isListMetadataModel(model) && !serializerListMetadataNeeded.has(model.name)) continue;
    if (isListWrapperModel(model) && !serializerNonPaginatedRefs.has(model.name)) continue;
    if (discriminatedSerializerSkip?.has(model.name)) continue;
    const service = modelToService.get(model.name);
    const isOwnedModel = isNodeOwnedService(ctx, service);
    if (!isOwnedModel && !modelHasNewFields(model, ctx) && !forceGenerateSerializer.has(model.name)) continue;
    eligibleModels.push(model);
  }
  (ctx as any)._generatedSerializerModels = new Set(eligibleModels.map((model) => model.name));

  // Pass 1: determine shouldSkipSerialize
  for (const model of eligibleModels) {
    if (dedup.has(model.name)) continue;
    const domainName = resolveInterfaceName(model.name, ctx);
    const responseName = wireInterfaceName(domainName);
    const baselineResponse = ctx.apiSurface?.interfaces?.[responseName];
    const baselineDomain = ctx.apiSurface?.interfaces?.[domainName];
    const shouldSkip =
      (requestReachableModels !== undefined && !requestReachableModels.has(model.name)) ||
      shouldSkipSerializeForModel(model, baselineResponse, baselineDomain, dedup, skippedSerializeModels, ctx);
    if (shouldSkip) {
      skippedSerializeModels.add(model.name);
    }
  }

  // Pass 2: generate serializer files
  for (const model of eligibleModels) {
    const service = modelToService.get(model.name);
    const isOwnedModel = isNodeOwnedService(ctx, service);
    const canonicalName = dedup.get(model.name);
    if (canonicalName && !isOwnedModel) {
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

      const aliasNeedsDeserialize = responseReachableModels === undefined || responseReachableModels.has(model.name);
      const canonicalHasDeserialize =
        responseReachableModels === undefined || responseReachableModels.has(canonicalName);
      const canAliasToCanonical = !aliasNeedsDeserialize || canonicalHasDeserialize;
      if (canAliasToCanonical) {
        const rel = relativeImport(serializerPath, canonSerializerPath);
        const canonSkipSerialize = skippedSerializeModels.has(canonicalName) || skippedSerializeModels.has(model.name);
        const canonSkipDeserialize =
          responseReachableModels !== undefined &&
          !responseReachableModels.has(canonicalName) &&
          !responseReachableModels.has(model.name);
        if (canonSkipSerialize && canonSkipDeserialize) continue;
        const parts: string[] = [];
        if (!canonSkipDeserialize) {
          parts.push(`deserialize${canonDomainName} as deserialize${domainName}`);
        }
        if (!canonSkipSerialize) {
          parts.push(`serialize${canonDomainName} as serialize${domainName}`);
        }
        const reexportContent = `export { ${parts.join(', ')} } from '${rel}';`;
        files.push({
          path: serializerPath,
          content: reexportContent,
          overwriteExisting: true,
        });
        continue;
      }
      // The alias is response-reachable, but the canonical model is
      // request-only. Generate a local serializer instead of re-exporting a
      // deserialize helper that the canonical serializer intentionally omits.
    }

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
    // Skip `deserialize<X>` when the model never appears as a response (and
    // we have usage info to verify that — `undefined` means "emit both halves
    // conservatively"). Cuts unused, partially-typed deserializers like
    // `deserializeCreateWebhookEndpoint` from request-body-only models.
    const shouldSkipDeserialize = responseReachableModels !== undefined && !responseReachableModels.has(model.name);
    if (shouldSkipSerialize && shouldSkipDeserialize) continue;

    const sctx = {
      modelToService,
      resolveDir,
      dedup,
      skippedSerializeModels,
      responseReachableModels,
      ctx,
    };
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
        shouldSkipDeserialize,
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
  // Surface the response-reachable set so the serializer-roundtrip test
  // generator can fall back to a deserialize-skipped path for request-only
  // models (where `deserialize<X>` was deliberately not emitted).
  (ctx as any)._responseReachableModels = responseReachableModels;

  // Emit a `serializers/index.ts` barrel per directory that received serializer
  // files in this pass. Mirrors the per-service `interfaces/index.ts` barrel so
  // consumers can `import { ... } from './serializers'` rather than reaching
  // into individual `.serializer.ts` files. Also includes any pre-existing
  // `*.serializer.ts` files in the same directory (e.g. hand-written option
  // serializers in an owned service) so we don't strand them from the barrel.
  const serializersByDir = new Map<string, Set<string>>();
  for (const f of files) {
    const match = f.path.match(/^src\/([^/]+)\/serializers\/(.+)\.serializer\.ts$/);
    if (!match) continue;
    const [, dir, stem] = match;
    if (!serializersByDir.has(dir)) serializersByDir.set(dir, new Set());
    serializersByDir.get(dir)!.add(stem);
  }
  const liveRootForBarrel = ctx.outputDir ?? ctx.targetDir;
  for (const [dir, stems] of serializersByDir) {
    if (liveRootForBarrel && !isNodeOwnedService(ctx, dir)) {
      const serializersDir = path.join(liveRootForBarrel, 'src', dir, 'serializers');
      try {
        for (const entry of fs.readdirSync(serializersDir)) {
          if (!entry.endsWith('.serializer.ts')) continue;
          stems.add(entry.replace(/\.serializer\.ts$/, ''));
        }
      } catch {
        // Directory doesn't exist yet — only this-pass serializers will appear.
      }
    }
    const lines = [...stems].sort().map((stem) => `export * from './${stem}.serializer';`);
    files.push({
      path: `src/${dir}/serializers/index.ts`,
      content: lines.join('\n') + '\n',
      overwriteExisting: true,
    });
  }

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

export function generatedResourceInterfaceModelNames(models: Model[], ctx: EmitterContext): Set<string> | undefined {
  const shared = buildSharedContext(models, ctx);
  const projectedModels = models.map((model) => projectModelToManagedSurface(model, shared, ctx));
  const projectedByName = new Map(projectedModels.map((model) => [model.name, model]));
  const resourceUsage = buildGeneratedResourceModelUsage(models, ctx);
  return resourceUsage ? expandModelRoots(resourceUsage.interfaceRoots, projectedByName) : undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildGeneratedResourceModelUsage(
  models: Model[],
  ctx: EmitterContext,
): GeneratedResourceModelUsage | undefined {
  if (ctx.spec.services.length === 0) return undefined;

  const modelMap = new Map(models.map((model) => [model.name, model]));
  const interfaceRoots = new Set<string>();
  const serializerRoots = new Set<string>();
  const requestRoots = new Set<string>();
  const responseRoots = new Set<string>();
  const resolvedLookup = buildResolvedLookup(ctx);
  const mountGroups = groupByMount(ctx);
  const services: Service[] =
    mountGroups.size > 0
      ? [...mountGroups].map(([name, group]) => ({
          name,
          operations: group.operations,
        }))
      : ctx.spec.services;

  for (const service of services) {
    const resourceClass = resolveResourceClassName(service, ctx);
    const isOwnedService = isNodeOwnedService(ctx, service.name, resourceClass);
    const baselineHasResourceClass = Boolean(ctx.apiSurface?.classes?.[resourceClass]);

    if (
      !isOwnedService &&
      baselineHasResourceClass &&
      isServiceCoveredByExisting(service, ctx) &&
      !hasMethodsAbsentFromBaseline(service, ctx)
    ) {
      continue;
    }

    let plans = service.operations.map((op) => ({
      op,
      plan: planOperation(op),
      method: resolveMethodName(op, service, ctx),
    }));

    const baselineMethodNames = new Set(Object.keys(ctx.apiSurface?.classes?.[resourceClass]?.methods ?? {}));
    if (!isOwnedService && baselineMethodNames.size > 0) {
      plans = plans.filter((p) => !baselineMethodNames.has(p.method));
    }
    if (plans.length === 0) continue;

    for (const { op, plan } of plans) {
      if (plan.isPaginated && op.pagination && op.httpMethod === 'get') {
        let itemName = op.pagination.itemType.kind === 'model' ? op.pagination.itemType.name : undefined;
        if (itemName) {
          const itemModel = modelMap.get(itemName);
          const unwrapped = itemModel ? unwrapListModel(itemModel, modelMap) : null;
          if (unwrapped) itemName = unwrapped.name;
          interfaceRoots.add(itemName);
          serializerRoots.add(itemName);
          responseRoots.add(itemName);
        }
      } else if (plan.responseModelName) {
        interfaceRoots.add(plan.responseModelName);
        serializerRoots.add(plan.responseModelName);
        responseRoots.add(plan.responseModelName);
      }

      const bodyInfo = extractRequestBodyModels(op, ctx);
      for (const name of bodyInfo) {
        interfaceRoots.add(name);
        serializerRoots.add(name);
        requestRoots.add(name);
      }

      for (const param of [...op.pathParams, ...op.queryParams, ...op.headerParams]) {
        collectTypeRefModels(param.type, interfaceRoots);
      }

      const resolved = lookupResolved(op, resolvedLookup);
      if (resolved) {
        for (const name of collectWrapperResponseModels(resolved)) {
          interfaceRoots.add(name);
          serializerRoots.add(name);
          responseRoots.add(name);
        }
        for (const wrapper of resolved.wrappers ?? []) {
          for (const { field } of resolveWrapperParams(wrapper, ctx)) {
            if (field) collectTypeRefModels(field.type, interfaceRoots);
          }
        }
      }
    }
  }

  return { interfaceRoots, serializerRoots, requestRoots, responseRoots };
}

function extractRequestBodyModels(op: Operation, ctx: EmitterContext): string[] {
  if (!op.requestBody) return [];
  if (op.requestBody.kind === 'model') return [op.requestBody.name];
  if (op.requestBody.kind !== 'union') return [];

  const names: string[] = [];
  for (const variant of op.requestBody.variants) {
    if (variant.kind === 'model') names.push(variant.name);
  }

  return names.length > 0 ? names : collectDiscriminatorModelNames(op.requestBody.discriminator, ctx);
}

function collectDiscriminatorModelNames(
  discriminator: { mapping?: Record<string, string> } | undefined,
  ctx: EmitterContext,
): string[] {
  const names = new Set<string>();
  for (const mapped of Object.values(discriminator?.mapping ?? {})) {
    const name = mapped.split('/').pop();
    if (name && ctx.spec.models.some((model) => model.name === name)) names.add(name);
  }
  return [...names];
}

function collectTypeRefModels(ref: TypeRef | undefined, out: Set<string>): void {
  if (!ref) return;
  switch (ref.kind) {
    case 'model':
      out.add(ref.name);
      return;
    case 'array':
      collectTypeRefModels(ref.items, out);
      return;
    case 'nullable':
      collectTypeRefModels(ref.inner, out);
      return;
    case 'union':
      for (const variant of ref.variants) collectTypeRefModels(variant, out);
      return;
    default:
      return;
  }
}

function expandModelRoots(roots: Set<string>, modelsByName: Map<string, Model>): Set<string> {
  const out = new Set<string>();
  const queue = [...roots];

  while (queue.length > 0) {
    const name = queue.pop()!;
    if (out.has(name)) continue;
    const model = modelsByName.get(name);
    if (!model) continue;
    out.add(name);

    for (const dep of collectFieldDependencies(model).models) {
      if (!out.has(dep)) queue.push(dep);
    }
  }

  return out;
}

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
