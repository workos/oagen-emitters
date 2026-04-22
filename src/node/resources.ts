// @oagen-ignore: Operation.async — all TypeScript SDK methods are async by nature

import type {
  Service,
  Operation,
  EmitterContext,
  GeneratedFile,
  TypeRef,
  Model,
  ResolvedOperation,
} from '@workos/oagen';
import { planOperation, toPascalCase, toCamelCase } from '@workos/oagen';
import type { OperationPlan } from '@workos/oagen';
import { mapTypeRef } from './type-map.js';
import {
  fieldName,
  wireFieldName,
  fileName,
  resolveServiceDir,
  resolveMethodName,
  resolveInterfaceName,
  resolveServiceName,
  wireInterfaceName,
} from './naming.js';
import {
  docComment,
  createServiceDirResolver,
  isServiceCoveredByExisting,
  hasMethodsAbsentFromBaseline,
  uncoveredOperations,
} from './utils.js';
import { assignEnumsToServices } from './enums.js';
import { unwrapListModel } from './fixtures.js';
import { buildNodeStatusExceptions } from './sdk-errors.js';
import {
  buildResolvedLookup,
  lookupResolved,
  groupByMount,
  getOpDefaults,
  getOpInferFromClient,
} from '../shared/resolved-ops.js';
import { generateWrapperMethods, collectWrapperResponseModels } from './wrappers.js';
import { resolveWrapperParams } from '../shared/wrapper-utils.js';

/**
 * Check whether the baseline (hand-written) class has a constructor compatible
 * with the generated pattern `constructor(private readonly workos: WorkOS)`.
 * Returns true when no baseline exists (fresh generation) or when compatible.
 */
export function hasCompatibleConstructor(className: string, ctx: EmitterContext): boolean {
  const baselineClass = ctx.apiSurface?.classes?.[className];
  if (!baselineClass) return true; // No baseline — fresh generation
  const params = baselineClass.constructorParams;
  if (!params || params.length === 0) return true; // No-arg constructor is compatible
  // Compatible if there is a single `workos` param whose type contains "WorkOS"
  return params.some((p) => p.name === 'workos' && p.type.includes('WorkOS'));
}

/**
 * Resolve the resource class name for a service, accounting for constructor
 * compatibility with the baseline class.
 *
 * When the overlay-resolved class has an incompatible constructor (e.g., a
 * hand-written `Webhooks` class that takes `CryptoProvider` instead of `WorkOS`),
 * falls back to the IR name (`toPascalCase(service.name)`). If the IR name
 * collides with the overlay name, appends an `Endpoints` suffix.
 */
export function resolveResourceClassName(service: Service, ctx: EmitterContext): string {
  const overlayName = resolveServiceName(service, ctx);
  if (hasCompatibleConstructor(overlayName, ctx)) {
    return overlayName;
  }
  // Incompatible constructor — fall back to IR name
  const irName = toPascalCase(service.name);
  if (irName === overlayName) {
    return irName + 'Endpoints';
  }
  return irName;
}

/** Standard pagination query params handled by PaginationOptions — not imported individually. */
const PAGINATION_PARAM_NAMES = new Set(['limit', 'before', 'after', 'order']);

/** Map HTTP status codes to their corresponding exception class names for @throws docs.
 *  Built from sdk.errors.statusCodeMap with Node-specific naming overrides. */
const STATUS_TO_EXCEPTION_NAME: Record<number, string> = buildNodeStatusExceptions();

/**
 * Compute the options interface name for a paginated method.
 * When the method name is simply "list", prefix with the service name to avoid
 * naming collisions at barrel-export level (e.g. "ConnectionsListOptions"
 * instead of the generic "ListOptions").
 */
function paginatedOptionsName(method: string, resolvedServiceName: string): string {
  if (method === 'list') {
    return `${toPascalCase(resolvedServiceName)}ListOptions`;
  }
  return toPascalCase(method) + 'Options';
}

/** HTTP methods that require a body argument even when the spec has no request body. */
function httpMethodNeedsBody(method: string): boolean {
  return method === 'post' || method === 'put' || method === 'patch';
}

// ---------------------------------------------------------------------------
// Method-name deduplication helpers
// ---------------------------------------------------------------------------

/** Split a camelCase/PascalCase name into lowercase word parts. */
function splitCamelWords(name: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let i = 1; i < name.length; i++) {
    if (name[i] >= 'A' && name[i] <= 'Z') {
      parts.push(name.slice(start, i).toLowerCase());
      start = i;
    }
  }
  parts.push(name.slice(start).toLowerCase());
  return parts;
}

/** Naive singularize: strip trailing 's' unless it ends in 'ss'. */
function singularize(word: string): string {
  return word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

/**
 * Deduplicate method names within the plans array.
 *
 * When `disambiguateOperationNames()` in `@workos/oagen` fails (e.g., for
 * single-segment paths like `/organizations`), two operations can resolve to
 * the same method name. Disambiguate by appending a path-derived suffix.
 */
function deduplicateMethodNames(
  plans: Array<{ op: Operation; plan: OperationPlan; method: string }>,
  _ctx: EmitterContext,
): void {
  const nameCount = new Map<string, number>();
  for (const p of plans) {
    nameCount.set(p.method, (nameCount.get(p.method) ?? 0) + 1);
  }

  for (const [name, count] of nameCount) {
    if (count <= 1) continue;
    const dupes = plans.filter((p) => p.method === name);

    // If all duplicates are on the SAME base path (different HTTP methods),
    // trust the names — they represent the same resource.
    const basePaths = new Set(dupes.map((d) => d.op.path.replace(/\/\{[^}]+\}$/, '')));
    if (basePaths.size <= 1) continue;

    // Disambiguate: keep the name for the plan whose path best matches,
    // append path suffix for the others.
    // Score: how many words in the method name appear in the path segments
    const nameWords = new Set(splitCamelWords(name).map(singularize));
    const scored = dupes.map((d) => {
      const pathWords = d.op.path
        .split('/')
        .filter((s) => s && !s.startsWith('{'))
        .flatMap((s) => s.split('_'))
        .map(singularize);
      const overlap = pathWords.filter((w) => nameWords.has(w)).length;
      return { plan: d, score: overlap };
    });
    scored.sort((a, b) => b.score - a.score);

    // The best-scoring plan keeps the name; others get disambiguated
    for (let i = 1; i < scored.length; i++) {
      const dupe = scored[i].plan;
      const segments = dupe.op.path.split('/').filter((s) => s && !s.startsWith('{'));
      // Use first segment as suffix (the resource collection name)
      const suffix = segments[0] ?? '';
      if (suffix) {
        dupe.method = toCamelCase(`${name}_${suffix}`);
      }
    }

    // If still colliding after suffix, append index
    const stillDuped = new Map<string, typeof dupes>();
    for (const dupe of dupes) {
      const group = stillDuped.get(dupe.method) ?? [];
      group.push(dupe);
      stillDuped.set(dupe.method, group);
    }
    for (const [, group] of stillDuped) {
      if (group.length <= 1) continue;
      for (let i = 1; i < group.length; i++) {
        group[i].method = `${group[i].method}${i + 1}`;
      }
    }
  }
}

/**
 * Emit one interface file per paginated list operation that has extension
 * query params.  Placing the options interface under `interfaces/` lets the
 * per-service barrel pick it up via `export * from './interfaces'`, which
 * is what the root `src/index.ts` re-exports.  When the interface was
 * declared inline in the resource file, it was unreachable from the barrel
 * and callers couldn't import the type by name from the package root.
 */
function generatePaginatedOptionsInterfaces(
  service: Service,
  ctx: EmitterContext,
  specEnumNames: Set<string>,
): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const resolvedName = resolveResourceClassName(service, ctx);
  const serviceDir = resolveServiceDir(resolvedName);

  const plans = service.operations.map((op) => ({
    op,
    plan: planOperation(op),
    method: resolveMethodName(op, service, ctx),
  }));

  for (const { op, plan, method } of plans) {
    if (!plan.isPaginated) continue;
    const extraParams = op.queryParams.filter((p) => !PAGINATION_PARAM_NAMES.has(p.name));
    if (extraParams.length === 0) continue;

    const optionsName = paginatedOptionsName(method, resolvedName);
    const filePath = `src/${serviceDir}/interfaces/${fileName(optionsName)}.interface.ts`;

    const lines: string[] = [];
    lines.push("import type { PaginationOptions } from '../../common/interfaces/pagination-options.interface';");
    lines.push('');
    lines.push(`export interface ${optionsName} extends PaginationOptions {`);
    for (const param of extraParams) {
      const opt = !param.required ? '?' : '';
      if (param.description || param.deprecated) {
        const parts: string[] = [];
        if (param.description) parts.push(param.description);
        if (param.deprecated) parts.push('@deprecated');
        lines.push(...docComment(parts.join('\n'), 2));
      }
      lines.push(`  ${fieldName(param.name)}${opt}: ${mapParamType(param.type, specEnumNames)};`);
    }
    lines.push('}');

    files.push({
      path: filePath,
      content: lines.join('\n'),
    });
  }

  return files;
}

export function generateResources(services: Service[], ctx: EmitterContext): GeneratedFile[] {
  if (services.length === 0) return [];
  const files: GeneratedFile[] = [];

  // Group services by mount target to avoid file path collisions when
  // multiple IR services mount to the same resource class.
  const mountGroups = groupByMount(ctx);
  const mergedServices: Service[] =
    mountGroups.size > 0 ? [...mountGroups].map(([name, group]) => ({ name, operations: group.operations })) : services;

  const topLevelEnumNames = new Set(ctx.spec.enums.map((e) => e.name));

  for (const service of mergedServices) {
    if (isServiceCoveredByExisting(service, ctx)) {
      if (!hasMethodsAbsentFromBaseline(service, ctx)) {
        continue; // Fully covered, no new methods -- skip entirely
      }
      // Partially covered -- has new methods that need to be added.
      const file = generateResourceClass(service, ctx);
      delete file.skipIfExists;
      // Suppress auto-generated header — the file is a merge target
      // containing hand-written code, not a fully generated file.
      file.headerPlacement = 'skip';
      files.push(file);
      continue;
    }

    const ops = uncoveredOperations(service, ctx);
    if (ops.length === 0) continue;

    if (ops.length < service.operations.length) {
      // Partial coverage: generate with ALL operations so JSDoc is available
      // for both covered and uncovered methods.  Remove skipIfExists so the
      // merger adds new methods AND refreshes existing JSDoc.
      const file = generateResourceClass(service, ctx);
      delete file.skipIfExists;
      // Suppress auto-generated header — the file is a merge target
      // containing hand-written code, not a fully generated file.
      file.headerPlacement = 'skip';
      files.push(file);
    } else {
      // Purely oagen-managed: no baseline class exists, so the file is owned
      // end-to-end by the emitter.  Remove skipIfExists so regeneration always
      // overwrites — emitter improvements (serializer dispatch, JSDoc, etc.)
      // must propagate without manual intervention.
      const file = generateResourceClass(service, ctx);
      delete file.skipIfExists;
      files.push(file);
    }
  }

  // Emit paginated list options interfaces AFTER the resource classes so
  // tests and manifest ordering that index `files[0]` as the class stay
  // stable.  Placing them under `interfaces/` lets the per-service barrel
  // pick them up automatically.
  for (const service of mergedServices) {
    if (isServiceCoveredByExisting(service, ctx) && !hasMethodsAbsentFromBaseline(service, ctx)) continue;
    files.push(...generatePaginatedOptionsInterfaces(service, ctx, topLevelEnumNames));
  }

  return files;
}

function generateResourceClass(service: Service, ctx: EmitterContext): GeneratedFile {
  const resolvedName = resolveResourceClassName(service, ctx);
  const serviceDir = resolveServiceDir(resolvedName);
  const serviceClass = resolvedName;
  const resourcePath = `src/${serviceDir}/${fileName(resolvedName)}.ts`;

  const plans = service.operations.map((op) => ({
    op,
    plan: planOperation(op),
    method: resolveMethodName(op, service, ctx),
  }));

  // Resolved operations already produce correct method names via the
  // centralized hint map — no per-emitter reconciliation needed.

  // Deduplicate method names within the class (e.g., two operations both
  // resolving to "create" for different paths).
  deduplicateMethodNames(plans, ctx);

  // Sort plans to match the existing file's method order.
  // When the merger integrates generated content with existing files, its
  // URL-fingerprint fallback (pass 2) matches by position among methods that
  // share the same endpoint path.  If the spec lists POST before GET for a
  // path (common in OpenAPI) but the existing class has them in a different
  // order, JSDoc comments get attached to the wrong methods (list↔create,
  // add↔set swaps).  Sorting by the overlay's method order ensures the
  // generated output matches the existing file's method order.
  //
  // We build the order from HTTP operation keys (e.g., "GET /organizations")
  // rather than method names, because resolveMethodName may return a different
  // name than the overlay's methodName (e.g., when the hint map overrides it),
  // causing the lookup to fail and the sort to produce wrong order.
  if (ctx.overlayLookup?.methodByOperation) {
    const httpKeyOrder = new Map<string, number>();
    let pos = 0;
    for (const [httpKey] of ctx.overlayLookup.methodByOperation) {
      httpKeyOrder.set(httpKey, pos++);
    }
    if (httpKeyOrder.size > 0) {
      plans.sort((a, b) => {
        const aKey = `${a.op.httpMethod.toUpperCase()} ${a.op.path}`;
        const bKey = `${b.op.httpMethod.toUpperCase()} ${b.op.path}`;
        const aPos = httpKeyOrder.get(aKey) ?? Number.MAX_SAFE_INTEGER;
        const bPos = httpKeyOrder.get(bKey) ?? Number.MAX_SAFE_INTEGER;
        return aPos - bPos;
      });
    }
  }

  const hasPaginated = plans.some((p) => p.plan.isPaginated);
  const modelMap = new Map(ctx.spec.models.map((m) => [m.name, m]));

  // When merging into an existing class, the merger keeps baseline method
  // bodies but may add imports from the generated code.  To avoid orphaned
  // imports for types used only by baseline methods (whose bodies are kept
  // intact), skip model collection for methods that already exist.
  const baselineMethodSet = new Set<string>();
  const baselineClass = ctx.apiSurface?.classes?.[serviceClass];
  if (baselineClass?.methods) {
    for (const name of Object.keys(baselineClass.methods)) {
      baselineMethodSet.add(name);
    }
  }

  // Collect models for imports — only include models that are actually used
  // in method signatures (not all union variants from the spec)
  const responseModels = new Set<string>();
  const requestModels = new Set<string>();
  const paramEnums = new Set<string>();
  const paramModels = new Set<string>();
  for (const { op, plan, method } of plans) {
    // Always collect param type refs for enums — inline options interfaces
    // are generated for all methods (including baseline ones), so their
    // type dependencies must always be imported.
    const queryParams = plan.isPaginated
      ? op.queryParams.filter((p) => !PAGINATION_PARAM_NAMES.has(p.name))
      : op.queryParams;
    for (const param of [...queryParams, ...op.pathParams]) {
      collectParamTypeRefs(param.type, paramEnums, paramModels);
    }

    // Skip response/request model imports for methods that already exist in
    // the baseline class.  The merger keeps baseline method bodies, so their
    // imports are already present in the existing file.
    if (baselineMethodSet.has(method)) continue;

    if (plan.isPaginated && op.pagination?.itemType.kind === 'model') {
      // For paginated operations, import the item type (e.g., Connection)
      // rather than the list wrapper type (e.g., ConnectionList).
      // fetchAndDeserialize handles the list envelope internally.
      // The IR's itemType may point to a list wrapper model — unwrap to the actual item.
      let itemName = op.pagination.itemType.name;
      const itemModel = modelMap.get(itemName);
      if (itemModel) {
        const unwrapped = unwrapListModel(itemModel, modelMap);
        if (unwrapped) {
          itemName = unwrapped.name;
        }
      }
      responseModels.add(itemName);
    } else if (plan.responseModelName) {
      responseModels.add(plan.responseModelName);
    }
    // Import request body model(s) — handles both single models and union variants.
    const bodyInfo = extractRequestBodyType(op, ctx);
    if (bodyInfo?.kind === 'model') {
      requestModels.add(bodyInfo.name);
    } else if (bodyInfo?.kind === 'union') {
      if (bodyInfo.discriminator) {
        // Discriminated union: import variant models with serializers so we can
        // dispatch to the correct serializer at runtime based on the discriminator.
        for (const name of bodyInfo.modelNames) {
          requestModels.add(name);
        }
      } else {
        // Non-discriminated union: import variant models with serializers so we
        // can dispatch to the correct serializer at runtime via field guards.
        for (const name of bodyInfo.modelNames) {
          requestModels.add(name);
        }
      }
    }
  }

  // Collect response models from union split wrappers so their types and
  // deserializers are imported alongside the primary operation models.
  // Also collect models referenced in wrapper param signatures (e.g.,
  // `redirect_uris: RedirectUriInput[]`) — otherwise the wrapper emits a
  // reference to a type it never imported.
  const resolvedLookup = buildResolvedLookup(ctx);
  for (const { op, method } of plans) {
    if (baselineMethodSet.has(method)) continue;
    const resolved = lookupResolved(op, resolvedLookup);
    if (resolved) {
      for (const name of collectWrapperResponseModels(resolved)) {
        responseModels.add(name);
      }
      for (const wrapper of resolved.wrappers ?? []) {
        for (const { field } of resolveWrapperParams(wrapper, ctx)) {
          if (field) collectParamTypeRefs(field.type, paramEnums, paramModels);
        }
      }
    }
  }

  const allModels = new Set([...responseModels, ...requestModels, ...paramModels]);

  const lines: string[] = [];

  // Imports
  lines.push("import type { WorkOS } from '../workos';");
  if (hasPaginated) {
    lines.push("import type { PaginationOptions } from '../common/interfaces/pagination-options.interface';");
    lines.push("import { AutoPaginatable } from '../common/utils/pagination';");
    lines.push("import { fetchAndDeserialize } from '../common/utils/fetch-and-deserialize';");
  }

  // Paginated list options live in their own interface files so they're
  // picked up by the per-service barrel (and flow through to the root
  // package barrel).  Import them here rather than declaring inline.
  for (const { op, plan, method } of plans) {
    if (!plan.isPaginated) continue;
    const extraParams = op.queryParams.filter((p) => !PAGINATION_PARAM_NAMES.has(p.name));
    if (extraParams.length === 0) continue;
    const optionsName = paginatedOptionsName(method, resolvedName);
    lines.push(`import type { ${optionsName} } from './interfaces/${fileName(optionsName)}.interface';`);
  }

  // Check if any operation needs PostOptions (idempotent POST or custom encoding)
  const hasIdempotentPost = plans.some((p) => p.plan.isIdempotentPost);
  const hasCustomEncoding = plans.some(
    (p) => p.op.requestBodyEncoding && p.op.requestBodyEncoding !== 'json' && p.plan.hasBody,
  );
  if (hasIdempotentPost || hasCustomEncoding) {
    lines.push("import type { PostOptions } from '../common/interfaces/post-options.interface';");
  }

  // Compute model-to-service mapping for correct cross-service import paths
  const { modelToService, resolveDir } = createServiceDirResolver(ctx.spec.models, ctx.spec.services, ctx);

  // Wire (Response) types are only needed for models used as response types in method signatures.
  // Request models and param models only need the domain type.
  const usedWireTypes = new Set<string>();
  for (const name of responseModels) {
    usedWireTypes.add(resolveInterfaceName(name, ctx));
  }

  // Track imported resolved names to prevent duplicate type name collisions
  const importedTypeNames = new Set<string>();
  for (const name of allModels) {
    const resolved = resolveInterfaceName(name, ctx);
    if (importedTypeNames.has(resolved)) continue; // Skip duplicate resolved names
    importedTypeNames.add(resolved);
    const modelDir = modelToService.get(name);
    const modelServiceDir = resolveDir(modelDir);
    const relPath =
      modelServiceDir === serviceDir
        ? `./interfaces/${fileName(name)}.interface`
        : `../${modelServiceDir}/interfaces/${fileName(name)}.interface`;
    if (usedWireTypes.has(resolved)) {
      lines.push(`import type { ${resolved}, ${wireInterfaceName(resolved)} } from '${relPath}';`);
    } else {
      lines.push(`import type { ${resolved} } from '${relPath}';`);
    }
  }

  // Collect serializer imports by module path so we can merge deserialize and
  // serialize imports from the same module into a single import statement.
  const serializerImportsByPath = new Map<string, string[]>();

  const importedDeserializers = new Set<string>();
  for (const name of responseModels) {
    const resolved = resolveInterfaceName(name, ctx);
    if (importedDeserializers.has(resolved)) continue;
    importedDeserializers.add(resolved);
    const modelDir = modelToService.get(name);
    const modelServiceDir = resolveDir(modelDir);
    const relPath =
      modelServiceDir === serviceDir
        ? `./serializers/${fileName(name)}.serializer`
        : `../${modelServiceDir}/serializers/${fileName(name)}.serializer`;
    const existing = serializerImportsByPath.get(relPath) ?? [];
    existing.push(`deserialize${resolved}`);
    serializerImportsByPath.set(relPath, existing);
  }

  const importedSerializers = new Set<string>();
  for (const name of requestModels) {
    const resolved = resolveInterfaceName(name, ctx);
    if (importedSerializers.has(resolved)) continue;
    importedSerializers.add(resolved);
    const modelDir = modelToService.get(name);
    const modelServiceDir = resolveDir(modelDir);
    const relPath =
      modelServiceDir === serviceDir
        ? `./serializers/${fileName(name)}.serializer`
        : `../${modelServiceDir}/serializers/${fileName(name)}.serializer`;
    const existing = serializerImportsByPath.get(relPath) ?? [];
    existing.push(`serialize${resolved}`);
    serializerImportsByPath.set(relPath, existing);
  }

  // Emit merged serializer imports
  for (const [relPath, specifiers] of serializerImportsByPath) {
    lines.push(`import { ${specifiers.join(', ')} } from '${relPath}';`);
  }

  // Build a set of global enum names — used to distinguish named enums (with files)
  // from inline enums (no file, must be rendered as string literal unions).
  const specEnumNames = new Set(ctx.spec.enums.map((e) => e.name));

  // Import enum types referenced in query/path parameters.
  // Only import enums that actually exist in the spec's global enums list —
  // inline string unions may have kind 'enum' but no corresponding file.
  if (paramEnums.size > 0) {
    const enumToService = assignEnumsToServices(ctx.spec.enums, ctx.spec.services);
    for (const name of paramEnums) {
      if (allModels.has(name)) continue; // Already imported as a model
      if (!specEnumNames.has(name)) continue; // No file generated for this enum
      const enumDir = enumToService.get(name);
      const enumServiceDir = resolveDir(enumDir);
      const relPath =
        enumServiceDir === serviceDir
          ? `./interfaces/${fileName(name)}.interface`
          : `../${enumServiceDir}/interfaces/${fileName(name)}.interface`;
      lines.push(`import type { ${name} } from '${relPath}';`);
    }
  }

  lines.push('');

  // Per-operation helpers (wire-format option serializers etc.) emitted
  // alongside the resource class.  The options interfaces themselves live
  // in separate files under `interfaces/` so the per-service barrel can
  // re-export them; see the earlier import block at the top of the file.
  for (const { op, plan, method } of plans) {
    if (plan.isPaginated) {
      const extraParams = op.queryParams.filter((p) => !PAGINATION_PARAM_NAMES.has(p.name));
      if (extraParams.length > 0) {
        const optionsName = paginatedOptionsName(method, resolvedName);

        // When any extension param has a camelCase domain name that differs
        // from its snake_case wire name, emit a serializer that translates
        // the user-facing options into the wire query shape.  Without this,
        // the query string uses camelCase keys (e.g. `organizationId=...`)
        // that the API silently ignores — the filter becomes a no-op.
        const needsWireSerializer = extraParams.some((p) => fieldName(p.name) !== wireFieldName(p.name));
        if (needsWireSerializer) {
          const serializerName = `serialize${optionsName}`;
          lines.push(`const ${serializerName} = (options: ${optionsName}): PaginationOptions => {`);
          // Pagination fields pass through unchanged (limit/before/after/order
          // share spelling in both cases).  Spread first so that wire-named
          // extension fields land on top and the camelCase keys don't also
          // leak into the query string.
          lines.push('  const wire: Record<string, unknown> = {');
          for (const p of PAGINATION_PARAM_NAMES) {
            lines.push(`    ${p}: options.${p},`);
          }
          lines.push('  };');
          for (const param of extraParams) {
            const camel = fieldName(param.name);
            const snake = wireFieldName(param.name);
            lines.push(`  if (options.${camel} !== undefined) wire.${snake} = options.${camel};`);
          }
          lines.push('  return wire as PaginationOptions;');
          lines.push('};');
          lines.push('');
        }
      }
    } else if (!plan.isPaginated && !plan.hasBody && !plan.isDelete && op.queryParams.length > 0) {
      // Non-paginated GET or void methods with query params get a typed options interface
      // instead of falling back to Record<string, unknown>.
      // Filter out hidden params (defaults and inferFromClient fields)
      const resolved = lookupResolved(op, resolvedLookup);
      const opHiddenParams = new Set<string>([
        ...Object.keys(getOpDefaults(resolved)),
        ...getOpInferFromClient(resolved),
      ]);
      const visibleParams = op.queryParams.filter((p) => !opHiddenParams.has(p.name));
      if (visibleParams.length > 0) {
        const optionsName = toPascalCase(method) + 'Options';
        lines.push(`export interface ${optionsName} {`);
        for (const param of visibleParams) {
          const opt = !param.required ? '?' : '';
          if (param.description || param.deprecated) {
            const parts: string[] = [];
            if (param.description) parts.push(param.description);
            if (param.deprecated) parts.push('@deprecated');
            lines.push(...docComment(parts.join('\n'), 2));
          }
          lines.push(`  ${fieldName(param.name)}${opt}: ${mapParamType(param.type, specEnumNames)};`);
        }
        lines.push('}');
        lines.push('');
      }
    }
  }

  // Resource class
  if (service.description) {
    lines.push(...docComment(service.description));
  }
  lines.push(`export class ${serviceClass} {`);
  lines.push('  constructor(private readonly workos: WorkOS) {}');

  for (const { op, plan, method } of plans) {
    lines.push('');
    const resolved = lookupResolved(op, resolvedLookup);
    lines.push(...renderMethod(op, plan, method, service, ctx, modelMap, specEnumNames, resolved));

    // Emit union split wrapper methods (typed convenience methods for each variant)
    if (resolved?.wrappers && resolved.wrappers.length > 0) {
      lines.push(...generateWrapperMethods(resolved, ctx));
    }
  }

  lines.push('}');

  return { path: resourcePath, content: lines.join('\n'), skipIfExists: true };
}

function renderMethod(
  op: Operation,
  plan: OperationPlan,
  method: string,
  service: Service,
  ctx: EmitterContext,
  modelMap: Map<string, Model>,
  specEnumNames?: Set<string>,
  resolvedOp?: ResolvedOperation,
): string[] {
  const lines: string[] = [];
  const responseModel = plan.responseModelName ? resolveInterfaceName(plan.responseModelName, ctx) : null;

  const pathStr = buildPathStr(op);

  // Build the set of params hidden from the method signature
  // (injected from client config or as constant defaults)
  const hiddenParams = new Set<string>([
    ...Object.keys(getOpDefaults(resolvedOp)),
    ...getOpInferFromClient(resolvedOp),
  ]);

  // Build set of valid param names to filter @param tags.
  // Prefer the overlay (existing method signature) if available;
  // otherwise compute from what the render path will actually include.
  const httpKey = `${op.httpMethod.toUpperCase()} ${op.path}`;
  const overlayMethod = ctx.overlayLookup?.methodByOperation?.get(httpKey);
  let validParamNames: Set<string> | null = null;
  if (overlayMethod) {
    validParamNames = new Set(overlayMethod.params.map((p) => p.name));
  } else {
    // Compute actual params based on render path to avoid documenting params
    // that won't appear in the method signature
    const actualParams = new Set<string>();
    for (const p of op.pathParams) actualParams.add(fieldName(p.name));
    if (plan.hasBody) actualParams.add('payload');
    if (plan.isPaginated) actualParams.add('options');
    // renderGetMethod/renderVoidMethod add options when there are visible non-paginated query params
    const visibleQueryCount = op.queryParams.filter((q) => !hiddenParams.has(q.name)).length;
    if (!plan.isPaginated && visibleQueryCount > 0 && !plan.isDelete) {
      actualParams.add('options');
    }
    validParamNames = actualParams;
  }

  // Always generate JSDoc for all methods (both existing and new).
  // The merger matches docstrings by member name — if we skip JSDoc for
  // existing methods, previously misplaced docstrings can never be corrected.
  // Hand-written docs (e.g., @deprecated, PKCE flow descriptions) are
  // preserved by the merger's @deprecated-preservation and @oagen-ignore
  // mechanisms instead.
  {
    const docParts: string[] = [];
    if (op.description) docParts.push(op.description);
    for (const param of op.pathParams) {
      const paramName = fieldName(param.name);
      // When the overlay folds a path param into the options object,
      // document it as @param options.paramName instead of top-level.
      const folded = validParamNames && !validParamNames.has(paramName) && validParamNames.has('options');
      if (validParamNames && !validParamNames.has(paramName) && !folded) continue;
      const docName = folded ? `options.${paramName}` : paramName;
      const deprecatedPrefix = param.deprecated ? '(deprecated) ' : '';
      if (param.description) {
        docParts.push(`@param ${docName} - ${deprecatedPrefix}${param.description}`);
      } else if (param.deprecated) {
        docParts.push(`@param ${docName} - (deprecated)`);
      }
      if (param.default !== undefined) docParts.push(`@default ${JSON.stringify(param.default)}`);
      if (param.example !== undefined) docParts.push(`@example ${JSON.stringify(param.example)}`);
    }
    // Document query params for non-paginated operations
    if (!plan.isPaginated) {
      // Only document query params if the method will have an options parameter
      if (validParamNames && (validParamNames.has('options') || overlayMethod)) {
        for (const param of op.queryParams) {
          if (hiddenParams.has(param.name)) continue;
          const paramName = `options.${fieldName(param.name)}`;
          if (validParamNames && !validParamNames.has('options') && !validParamNames.has(fieldName(param.name)))
            continue;
          const deprecatedPrefix = param.deprecated ? '(deprecated) ' : '';
          if (param.description) {
            docParts.push(`@param ${paramName} - ${deprecatedPrefix}${param.description}`);
          } else if (param.deprecated) {
            docParts.push(`@param ${paramName} - (deprecated)`);
          }
          if (param.default !== undefined) docParts.push(`@default ${JSON.stringify(param.default)}`);
          if (param.example !== undefined) docParts.push(`@example ${JSON.stringify(param.example)}`);
        }
      }
    }
    // Skip header and cookie params in JSDoc — they are not exposed in the method signature.
    // The SDK handles headers and cookies internally, so documenting them would be misleading.
    // Document payload/body parameter when there is a request body.
    // Detect the actual param name from the overlay — the hand-written SDK may
    // fold the body into an 'options' param instead of the generated 'payload'.
    let bodyDocParamName: string | null = null;
    if (plan.hasBody) {
      let bodyParamName = 'payload';
      let overlayHadUnusableName = false;
      if (validParamNames && !validParamNames.has('payload') && overlayMethod) {
        const pathNames = new Set(op.pathParams.map((p) => fieldName(p.name)));
        const candidates = overlayMethod.params.filter((p) => !pathNames.has(p.name) && p.name !== 'requestOptions');
        // Filter out destructuring artifacts (e.g., __0) from extracted param names
        const isUsableName = (name: string) => !/^__\d+$/.test(name);
        if (candidates.length === 1 && isUsableName(candidates[0].name)) {
          bodyParamName = candidates[0].name;
        } else if (candidates.length === 1 && !isUsableName(candidates[0].name)) {
          overlayHadUnusableName = true;
        } else if (candidates.length > 1) {
          // Multiple non-path params — match by type against the request body model
          const bodyInfo = extractRequestBodyType(op, ctx);
          if (bodyInfo?.kind === 'model') {
            const bodyTypeName = resolveInterfaceName(bodyInfo.name, ctx);
            const typeMatch = candidates.find((p) => p.type === bodyTypeName && isUsableName(p.name));
            if (typeMatch) {
              bodyParamName = typeMatch.name;
            } else {
              // Type names diverge (overlay vs spec). Fall back to matching
              // overlay param names against body model field names so each
              // extracted param gets documented individually.
              const bodyModel = ctx.spec.models.find((m) => m.name === bodyInfo.name);
              if (bodyModel) {
                const fieldMap = new Map(bodyModel.fields.map((f) => [fieldName(f.name), f]));
                for (const candidate of candidates) {
                  const matchingField = fieldMap.get(candidate.name);
                  if (matchingField?.description) {
                    docParts.push(`@param ${candidate.name} - ${matchingField.description}`);
                    if (matchingField.example !== undefined)
                      docParts.push(`@example ${JSON.stringify(matchingField.example)}`);
                  }
                }
                bodyDocParamName = '__multi__'; // prevent duplicate body doc below
              }
            }
          }
        }
      }

      // When the overlay had an unusable param name (e.g., destructured __0),
      // force documentation under 'payload' so the body isn't silently dropped.
      if (
        bodyDocParamName !== '__multi__' &&
        (overlayHadUnusableName || !validParamNames || validParamNames.has(bodyParamName))
      ) {
        bodyDocParamName = bodyParamName;
        const bodyInfo = extractRequestBodyType(op, ctx);
        if (bodyInfo?.kind === 'model') {
          const bodyModel = ctx.spec.models.find((m) => m.name === bodyInfo.name);
          let bodyDesc: string;
          if (bodyModel?.description) {
            bodyDesc = `@param ${bodyParamName} - ${bodyModel.description}`;
          } else if (bodyModel) {
            // When the model lacks a description, list its required fields to help
            // callers understand what must be provided.
            const requiredFieldNames = bodyModel.fields.filter((f) => f.required).map((f) => fieldName(f.name));
            bodyDesc =
              requiredFieldNames.length > 0
                ? `@param ${bodyParamName} - Object containing ${requiredFieldNames.join(', ')}.`
                : `@param ${bodyParamName} - The request body.`;
          } else {
            bodyDesc = `@param ${bodyParamName} - The request body.`;
          }
          docParts.push(bodyDesc);

          // When the body is folded into an options-style param (not 'payload'),
          // expand individual fields so IDEs surface per-field documentation.
          if (bodyParamName !== 'payload' && bodyModel) {
            for (const bField of bodyModel.fields) {
              const fName = `${bodyParamName}.${fieldName(bField.name)}`;
              const deprecatedPrefix = bField.deprecated ? '(deprecated) ' : '';
              if (bField.description) {
                docParts.push(`@param ${fName} - ${deprecatedPrefix}${bField.description}`);
              } else if (bField.deprecated) {
                docParts.push(`@param ${fName} - (deprecated)`);
              }
              if (bField.example !== undefined) docParts.push(`@example ${JSON.stringify(bField.example)}`);
            }
          }
        } else {
          docParts.push(`@param ${bodyParamName} - The request body.`);
        }
      }
    }
    // Document options parameter for paginated operations
    const hasOptionsSummary = () => docParts.some((p) => /^@param options(\s|$)/.test(p));
    if (plan.isPaginated) {
      docParts.push('@param options - Pagination and filter options.');
    } else if (!hasOptionsSummary() && op.queryParams.filter((q) => !hiddenParams.has(q.name)).length > 0) {
      docParts.push('@param options - Additional query options.');
    }
    // Ensure an @param options summary exists when there are @param options.xxx
    // entries (from folded path/body params) or when the overlay exposes an
    // options param that wasn't otherwise documented.
    if (validParamNames?.has('options') && !hasOptionsSummary()) {
      const hasOptionsDotEntries = docParts.some((p) => p.startsWith('@param options.'));
      if (hasOptionsDotEntries || overlayMethod) {
        docParts.push('@param options - The request options.');
      }
    }
    // Reorder: ensure @param options summary comes before any @param options.xxx entries
    {
      const summaryIdx = docParts.findIndex((p) => /^@param options(\s|$)/.test(p));
      const firstDotIdx = docParts.findIndex((p) => p.startsWith('@param options.'));
      if (summaryIdx > firstDotIdx && firstDotIdx >= 0) {
        const [summary] = docParts.splice(summaryIdx, 1);
        docParts.splice(firstDotIdx, 0, summary);
      }
    }
    // @returns for the primary response model.
    // When an overlay method exists, prefer its return type so the JSDoc
    // matches the actual TypeScript signature (the overlay may use a
    // different model name than the OpenAPI schema).
    if (overlayMethod?.returnType) {
      docParts.push(`@returns {${overlayMethod.returnType}}`);
    } else if (plan.isPaginated && op.pagination?.itemType.kind === 'model') {
      // Unwrap list wrapper models to match the actual return type — the method returns
      // AutoPaginatable<ItemType>, not the list wrapper.
      let itemRawName = op.pagination.itemType.name;
      const pModel = modelMap.get(itemRawName);
      if (pModel) {
        const unwrapped = unwrapListModel(pModel, modelMap);
        if (unwrapped) itemRawName = unwrapped.name;
      }
      const itemTypeName = resolveInterfaceName(itemRawName, ctx);
      docParts.push(`@returns {Promise<AutoPaginatable<${itemTypeName}>>}`);
    } else if (responseModel) {
      const returnTypeDoc = plan.isArrayResponse ? `${responseModel}[]` : responseModel;
      docParts.push(`@returns {Promise<${returnTypeDoc}>}`);
    } else {
      docParts.push('@returns {Promise<void>}');
    }
    // @throws for error responses
    for (const err of op.errors) {
      const exceptionName = STATUS_TO_EXCEPTION_NAME[err.statusCode];
      if (exceptionName) {
        docParts.push(`@throws {${exceptionName}} ${err.statusCode}`);
      }
    }
    if (op.deprecated) docParts.push('@deprecated');

    if (docParts.length > 0) {
      // Flatten all parts, splitting multiline descriptions into individual lines
      const allLines: string[] = [];
      for (const part of docParts) {
        for (const line of part.split('\n')) {
          allLines.push(line);
        }
      }
      if (allLines.length === 1) {
        lines.push(`  /** ${allLines[0]} */`);
      } else {
        lines.push('  /**');
        for (const line of allLines) {
          lines.push(line === '' ? '   *' : `   * ${line}`);
        }
        lines.push('   */');
      }
    }
  }

  const preDecisionCount = lines.length;

  if (plan.isPaginated && op.pagination && op.httpMethod === 'get') {
    // For paginated operations, use the item type from pagination metadata
    // (e.g., Connection) rather than the list wrapper type (e.g., ConnectionList).
    // Unwrap list wrapper models to get the actual item type name.
    let paginatedItemRawName = op.pagination.itemType.kind === 'model' ? op.pagination.itemType.name : null;
    if (paginatedItemRawName) {
      const pModel = modelMap.get(paginatedItemRawName);
      if (pModel) {
        const unwrapped = unwrapListModel(pModel, modelMap);
        if (unwrapped) {
          paginatedItemRawName = unwrapped.name;
        }
      }
    }
    const paginatedItemType = paginatedItemRawName ? resolveInterfaceName(paginatedItemRawName, ctx) : responseModel;
    if (paginatedItemType) {
      const resolvedServiceNameForPaginated = resolveServiceName(service, ctx);
      renderPaginatedMethod(
        lines,
        op,
        plan,
        method,
        paginatedItemType,
        pathStr,
        resolvedServiceNameForPaginated,
        specEnumNames,
      );
    }
  } else if (plan.isPaginated && plan.hasBody && responseModel) {
    // Non-GET paginated operation (e.g., PUT with list response) — treat as body method
    renderBodyMethod(lines, op, plan, method, responseModel, pathStr, ctx, specEnumNames);
  } else if (plan.isDelete && plan.hasBody) {
    renderDeleteWithBodyMethod(lines, op, plan, method, pathStr, ctx, specEnumNames);
  } else if (plan.isDelete) {
    renderDeleteMethod(lines, op, plan, method, pathStr, specEnumNames);
  } else if (plan.hasBody && responseModel) {
    renderBodyMethod(lines, op, plan, method, responseModel, pathStr, ctx, specEnumNames);
  } else if (responseModel) {
    renderGetMethod(lines, op, plan, method, responseModel, pathStr, specEnumNames, resolvedOp);
  } else {
    renderVoidMethod(lines, op, plan, method, pathStr, ctx, specEnumNames, resolvedOp);
  }

  // Defensive: if no render function produced a method body, emit a stub
  if (lines.length === preDecisionCount) {
    const params = buildPathParams(op, specEnumNames);
    lines.push(`  async ${method}(${params}): Promise<void> {`);
    lines.push(
      `    await this.workos.${op.httpMethod}(${pathStr}${httpMethodNeedsBody(op.httpMethod) ? ', {}' : ''});`,
    );
    lines.push('  }');
  }

  return lines;
}

function renderPaginatedMethod(
  lines: string[],
  op: Operation,
  plan: OperationPlan,
  method: string,
  itemType: string,
  pathStr: string,
  resolvedServiceName: string,
  specEnumNames?: Set<string>,
): void {
  const extraParams = op.queryParams.filter((p) => !PAGINATION_PARAM_NAMES.has(p.name));
  const optionsType = extraParams.length > 0 ? paginatedOptionsName(method, resolvedServiceName) : 'PaginationOptions';
  // When any extension param has a camelCase/snake_case divergence, the
  // resource file emits a `serialize<OptionsName>` helper — pass it to
  // createPaginatedList so the wire query uses snake_case keys.
  const needsWireSerializer = extraParams.some((p) => fieldName(p.name) !== wireFieldName(p.name));
  const serializerArg = needsWireSerializer ? `, serialize${optionsType}` : '';

  const pathParams = buildPathParams(op, specEnumNames);
  const allParams = pathParams ? `${pathParams}, options?: ${optionsType}` : `options?: ${optionsType}`;

  const wireType = wireInterfaceName(itemType);
  const serializeCall = serializerArg ? `options ? serialize${optionsType}(options) : undefined` : 'options';

  lines.push(`  async ${method}(${allParams}): Promise<AutoPaginatable<${itemType}, ${optionsType}>> {`);
  lines.push(`    return new AutoPaginatable(`);
  lines.push(`      await fetchAndDeserialize<${wireType}, ${itemType}>(`);
  lines.push(`        this.workos,`);
  lines.push(`        ${pathStr},`);
  lines.push(`        deserialize${itemType},`);
  lines.push(`        ${serializeCall},`);
  lines.push(`      ),`);
  lines.push(`      (params) =>`);
  lines.push(`        fetchAndDeserialize<${wireType}, ${itemType}>(`);
  lines.push(`          this.workos,`);
  lines.push(`          ${pathStr},`);
  lines.push(`          deserialize${itemType},`);
  lines.push(`          params,`);
  lines.push(`        ),`);
  lines.push(`      options,`);
  lines.push(`    );`);
  lines.push('  }');
}

function renderDeleteMethod(
  lines: string[],
  op: Operation,
  plan: OperationPlan,
  method: string,
  pathStr: string,
  specEnumNames?: Set<string>,
): void {
  const params = buildPathParams(op, specEnumNames);
  lines.push(`  async ${method}(${params}): Promise<void> {`);
  lines.push(`    await this.workos.delete(${pathStr});`);
  lines.push('  }');
}

function renderDeleteWithBodyMethod(
  lines: string[],
  op: Operation,
  plan: OperationPlan,
  method: string,
  pathStr: string,
  ctx: EmitterContext,
  specEnumNames?: Set<string>,
): void {
  const bodyInfo = extractRequestBodyType(op, ctx);
  let requestType: string;
  let bodyExpr: string;
  if (bodyInfo?.kind === 'model') {
    requestType = resolveInterfaceName(bodyInfo.name, ctx);
    bodyExpr = `serialize${requestType}(payload)`;
  } else if (bodyInfo?.kind === 'union') {
    requestType = bodyInfo.typeStr;
    if (bodyInfo.discriminator) {
      bodyExpr = renderUnionBodySerializer(bodyInfo.discriminator, ctx);
    } else {
      bodyExpr = renderNonDiscriminatedUnionBodySerializer(bodyInfo.modelNames, ctx);
    }
  } else {
    requestType = 'Record<string, unknown>';
    bodyExpr = 'payload';
  }

  const paramParts: string[] = [];
  for (const param of op.pathParams) {
    paramParts.push(
      `${fieldName(param.name)}: ${specEnumNames ? mapParamType(param.type, specEnumNames) : mapTypeRef(param.type)}`,
    );
  }
  paramParts.push(`payload: ${requestType}`);

  lines.push(`  async ${method}(${paramParts.join(', ')}): Promise<void> {`);
  lines.push(`    await this.workos.deleteWithBody(${pathStr}, ${bodyExpr});`);
  lines.push('  }');
}

function renderBodyMethod(
  lines: string[],
  op: Operation,
  plan: OperationPlan,
  method: string,
  responseModel: string,
  pathStr: string,
  ctx: EmitterContext,
  specEnumNames?: Set<string>,
): void {
  const bodyInfo = extractRequestBodyType(op, ctx);
  let requestType: string;
  let bodyExpr: string;
  if (bodyInfo?.kind === 'model') {
    requestType = resolveInterfaceName(bodyInfo.name, ctx);
    bodyExpr = `serialize${requestType}(payload)`;
  } else if (bodyInfo?.kind === 'union') {
    requestType = bodyInfo.typeStr;
    if (bodyInfo.discriminator) {
      bodyExpr = renderUnionBodySerializer(bodyInfo.discriminator, ctx);
    } else {
      bodyExpr = renderNonDiscriminatedUnionBodySerializer(bodyInfo.modelNames, ctx);
    }
  } else {
    requestType = 'Record<string, unknown>';
    bodyExpr = 'payload';
  }

  const paramParts: string[] = [];

  // Always pass path params as individual parameters (matches existing SDK pattern)
  for (const param of op.pathParams) {
    paramParts.push(
      `${fieldName(param.name)}: ${specEnumNames ? mapParamType(param.type, specEnumNames) : mapTypeRef(param.type)}`,
    );
  }

  paramParts.push(`payload: ${requestType}`);

  if (plan.isIdempotentPost) {
    paramParts.push('requestOptions: PostOptions = {}');
  }

  const paramsStr = paramParts.join(', ');

  // Fix 2: Pass encoding option when requestBodyEncoding is non-json
  const encoding = op.requestBodyEncoding;
  const encodingOption = encoding && encoding !== 'json' ? `, encoding: '${encoding}' as const` : '';
  const hasCustomEncoding = encodingOption !== '';

  const returnType = plan.isArrayResponse ? `${responseModel}[]` : responseModel;
  const wireType = plan.isArrayResponse ? `${wireInterfaceName(responseModel)}[]` : wireInterfaceName(responseModel);
  const returnExpr = plan.isArrayResponse
    ? `data.map(deserialize${responseModel})`
    : `deserialize${responseModel}(data)`;

  lines.push(`  async ${method}(${paramsStr}): Promise<${returnType}> {`);
  if (plan.isIdempotentPost) {
    if (hasCustomEncoding) {
      lines.push(`    const { data } = await this.workos.${op.httpMethod}<${wireType}>(`);
      lines.push(`      ${pathStr},`);
      lines.push(`      ${bodyExpr},`);
      lines.push(`      { ...requestOptions${encodingOption} },`);
      lines.push('    );');
    } else {
      lines.push(`    const { data } = await this.workos.${op.httpMethod}<${wireType}>(`);
      lines.push(`      ${pathStr},`);
      lines.push(`      ${bodyExpr},`);
      lines.push('      requestOptions,');
      lines.push('    );');
    }
  } else {
    if (hasCustomEncoding) {
      lines.push(`    const { data } = await this.workos.${op.httpMethod}<${wireType}>(`);
      lines.push(`      ${pathStr},`);
      lines.push(`      ${bodyExpr},`);
      lines.push(`      { ${encodingOption.slice(2)} },`);
      lines.push('    );');
    } else {
      lines.push(`    const { data } = await this.workos.${op.httpMethod}<${wireType}>(`);
      lines.push(`      ${pathStr},`);
      lines.push(`      ${bodyExpr},`);
      lines.push('    );');
    }
  }
  lines.push(`    return ${returnExpr};`);
  lines.push('  }');
}

function renderGetMethod(
  lines: string[],
  op: Operation,
  plan: OperationPlan,
  method: string,
  responseModel: string,
  pathStr: string,
  specEnumNames?: Set<string>,
  resolvedOp?: ResolvedOperation,
): void {
  const hiddenParams = new Set<string>([
    ...Object.keys(getOpDefaults(resolvedOp)),
    ...getOpInferFromClient(resolvedOp),
  ]);

  const params = buildPathParams(op, specEnumNames);
  const visibleQueryParams = op.queryParams.filter((p) => !hiddenParams.has(p.name));
  const hasVisibleQuery = visibleQueryParams.length > 0 && !plan.isPaginated;
  const hasDefaults = Object.keys(getOpDefaults(resolvedOp)).length > 0;
  const hasInferred = getOpInferFromClient(resolvedOp).length > 0;
  const hasInjected = hasDefaults || hasInferred;
  const hasQuery = (op.queryParams.length > 0 && !plan.isPaginated) || hasInjected;
  const optionsType = hasVisibleQuery ? toPascalCase(method) + 'Options' : null;

  const allParams = optionsType
    ? params
      ? `${params}, options?: ${optionsType}`
      : `options?: ${optionsType}`
    : params;

  const returnType = plan.isArrayResponse ? `${responseModel}[]` : responseModel;
  const wireType = plan.isArrayResponse ? `${wireInterfaceName(responseModel)}[]` : wireInterfaceName(responseModel);
  const returnExpr = plan.isArrayResponse
    ? `data.map(deserialize${responseModel})`
    : `deserialize${responseModel}(data)`;

  lines.push(`  async ${method}(${allParams}): Promise<${returnType}> {`);
  if (hasQuery) {
    if (hasInjected) {
      // Build the query object with visible params, defaults, and inferred fields
      const queryParts: string[] = [];

      // Regular visible query params (from options)
      if (hasVisibleQuery) {
        for (const param of visibleQueryParams) {
          const camel = fieldName(param.name);
          const snake = wireFieldName(param.name);
          if (camel === snake) {
            if (param.required) {
              queryParts.push(`${camel}: options.${camel}`);
            } else {
              queryParts.push(`...(options?.${camel} !== undefined && { ${camel}: options.${camel} })`);
            }
          } else {
            if (param.required) {
              queryParts.push(`${snake}: options.${camel}`);
            } else {
              queryParts.push(`...(options?.${camel} !== undefined && { ${snake}: options.${camel} })`);
            }
          }
        }
      }

      // Constant defaults (e.g., response_type: 'code')
      for (const [key, value] of Object.entries(getOpDefaults(resolvedOp))) {
        queryParts.push(`${key}: ${tsLiteral(value)}`);
      }

      // Inferred fields from client config (e.g., client_id from this.workos.options.clientId)
      for (const field of getOpInferFromClient(resolvedOp)) {
        queryParts.push(`${field}: ${clientFieldExpression(field)}`);
      }

      lines.push(`    const { data } = await this.workos.${op.httpMethod}<${wireType}>(${pathStr}, {`);
      lines.push(`      query: { ${queryParts.join(', ')} },`);
      lines.push('    });');
    } else {
      const queryExpr = renderQueryExpr(visibleQueryParams);
      lines.push(`    const { data } = await this.workos.${op.httpMethod}<${wireType}>(${pathStr}, {`);
      lines.push(`      query: ${queryExpr},`);
      lines.push('    });');
    }
  } else if (httpMethodNeedsBody(op.httpMethod)) {
    // PUT/PATCH/POST require a body argument even when the spec has no request body
    lines.push(`    const { data } = await this.workos.${op.httpMethod}<${wireType}>(${pathStr}, {});`);
  } else {
    lines.push(`    const { data } = await this.workos.${op.httpMethod}<${wireType}>(${pathStr});`);
  }
  lines.push(`    return ${returnExpr};`);
  lines.push('  }');
}

/** Convert a JS value to a TypeScript literal. */
function tsLiteral(value: string | number | boolean): string {
  if (typeof value === 'string') return `'${value.replace(/'/g, "\\'")}'`;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/** Get the TypeScript expression for reading a client config field. */
function clientFieldExpression(field: string): string {
  switch (field) {
    case 'client_id':
      return 'this.workos.options.clientId';
    case 'client_secret':
      return 'this.workos.key';
    default:
      return `this.workos.${toCamelCase(field)}`;
  }
}

function renderVoidMethod(
  lines: string[],
  op: Operation,
  plan: OperationPlan,
  method: string,
  pathStr: string,
  ctx: EmitterContext,
  specEnumNames?: Set<string>,
  resolvedOp?: ResolvedOperation,
): void {
  const hiddenParams = new Set<string>([
    ...Object.keys(getOpDefaults(resolvedOp)),
    ...getOpInferFromClient(resolvedOp),
  ]);

  const params = buildPathParams(op, specEnumNames);
  const visibleQueryParams = op.queryParams.filter((p) => !hiddenParams.has(p.name));
  const hasVisibleQuery = visibleQueryParams.length > 0 && !plan.hasBody;
  const hasDefaults = Object.keys(getOpDefaults(resolvedOp)).length > 0;
  const hasInferred = getOpInferFromClient(resolvedOp).length > 0;
  const hasInjected = hasDefaults || hasInferred;
  const hasQuery = hasVisibleQuery || (hasInjected && !plan.hasBody);
  const optionsType = hasVisibleQuery ? toPascalCase(method) + 'Options' : null;

  let bodyParam = '';
  let bodyExpr = 'payload';
  if (plan.hasBody) {
    const bodyInfo = extractRequestBodyType(op, ctx);
    if (bodyInfo?.kind === 'model') {
      const requestType = resolveInterfaceName(bodyInfo.name, ctx);
      bodyParam = `payload: ${requestType}`;
      bodyExpr = `serialize${requestType}(payload)`;
    } else if (bodyInfo?.kind === 'union') {
      bodyParam = `payload: ${bodyInfo.typeStr}`;
      if (bodyInfo.discriminator) {
        bodyExpr = renderUnionBodySerializer(bodyInfo.discriminator, ctx);
      } else {
        bodyExpr = renderNonDiscriminatedUnionBodySerializer(bodyInfo.modelNames, ctx);
      }
    } else {
      bodyParam = 'payload: Record<string, unknown>';
      bodyExpr = 'payload';
    }
  }

  const paramParts: string[] = [];
  if (params) paramParts.push(params);
  if (bodyParam) paramParts.push(bodyParam);
  if (optionsType) paramParts.push(`options?: ${optionsType}`);
  const allParams = paramParts.join(', ');

  lines.push(`  async ${method}(${allParams}): Promise<void> {`);
  if (plan.hasBody) {
    lines.push(`    await this.workos.${op.httpMethod}(${pathStr}, ${bodyExpr});`);
  } else if (hasQuery) {
    if (hasInjected) {
      // Build query object with visible params, defaults, and inferred fields
      const queryParts: string[] = [];

      if (hasVisibleQuery) {
        for (const param of visibleQueryParams) {
          const camel = fieldName(param.name);
          const snake = wireFieldName(param.name);
          if (camel === snake) {
            if (param.required) {
              queryParts.push(`${camel}: options.${camel}`);
            } else {
              queryParts.push(`...(options?.${camel} !== undefined && { ${camel}: options.${camel} })`);
            }
          } else {
            if (param.required) {
              queryParts.push(`${snake}: options.${camel}`);
            } else {
              queryParts.push(`...(options?.${camel} !== undefined && { ${snake}: options.${camel} })`);
            }
          }
        }
      }

      for (const [key, value] of Object.entries(getOpDefaults(resolvedOp))) {
        queryParts.push(`${key}: ${tsLiteral(value)}`);
      }

      for (const field of getOpInferFromClient(resolvedOp)) {
        queryParts.push(`${field}: ${clientFieldExpression(field)}`);
      }

      lines.push(`    await this.workos.${op.httpMethod}(${pathStr}, {`);
      lines.push(`      query: { ${queryParts.join(', ')} },`);
      lines.push('    });');
    } else {
      const queryExpr = renderQueryExpr(visibleQueryParams);
      lines.push(`    await this.workos.${op.httpMethod}(${pathStr}, {`);
      lines.push(`      query: ${queryExpr},`);
      lines.push('    });');
    }
  } else if (httpMethodNeedsBody(op.httpMethod)) {
    lines.push(`    await this.workos.${op.httpMethod}(${pathStr}, {});`);
  } else {
    lines.push(`    await this.workos.${op.httpMethod}(${pathStr});`);
  }
  lines.push('  }');
}

/**
 * Generate an inline query serialization expression that maps camelCase option
 * keys to their snake_case wire equivalents.  When all keys already match
 * (camel === snake), returns 'options' as-is for brevity.
 */
function renderQueryExpr(queryParams: { name: string; required: boolean }[]): string {
  // Check if any key actually needs conversion
  const needsConversion = queryParams.some((p) => fieldName(p.name) !== wireFieldName(p.name));
  if (!needsConversion) return 'options';

  const parts: string[] = [];
  for (const param of queryParams) {
    const camel = fieldName(param.name);
    const snake = wireFieldName(param.name);
    if (param.required) {
      parts.push(`${snake}: options.${camel}`);
    } else {
      parts.push(`...(options.${camel} !== undefined && { ${snake}: options.${camel} })`);
    }
  }
  return `options ? { ${parts.join(', ')} } : undefined`;
}

function buildPathStr(op: Operation): string {
  const interpolated = op.path.replace(/\{(\w+)\}/g, (_, p) => `\${${fieldName(p)}}`);
  return interpolated.includes('${') ? `\`${interpolated}\`` : `'${op.path}'`;
}

function buildPathParams(op: Operation, specEnumNames?: Set<string>): string {
  // Start with declared path params
  const declaredNames = new Set(op.pathParams.map((p) => fieldName(p.name)));
  const params = op.pathParams.map((p) => {
    const type = specEnumNames ? mapParamType(p.type, specEnumNames) : mapTypeRef(p.type);
    return `${fieldName(p.name)}: ${type}`;
  });

  // Detect path template variables not in declared pathParams and add them as string params.
  // This handles cases where the spec path has {param} but pathParams is incomplete.
  const templateVars = [...op.path.matchAll(/\{(\w+)\}/g)].map(([, name]) => fieldName(name));
  for (const varName of templateVars) {
    if (!declaredNames.has(varName)) {
      params.push(`${varName}: string`);
    }
  }

  return params.join(', ');
}

/**
 * Walk a parameter's type tree and collect enum/model names for imports.
 * Handles arrays and nullable wrappers that may contain nested enums/models.
 */
function collectParamTypeRefs(type: TypeRef, enums: Set<string>, models: Set<string>): void {
  switch (type.kind) {
    case 'enum':
      enums.add(type.name);
      break;
    case 'model':
      models.add(type.name);
      break;
    case 'array':
      collectParamTypeRefs(type.items, enums, models);
      break;
    case 'nullable':
      collectParamTypeRefs(type.inner, enums, models);
      break;
  }
}

/**
 * Extract request body type info, supporting both single models and union types.
 * Returns structured info so callers can handle imports and serialization appropriately.
 */
/**
 * Generate an IIFE expression that dispatches to the correct serializer for a
 * discriminated union request body.  Switches on the camelCase discriminator
 * property of the domain object and calls the appropriate serialize function
 * for each mapped model variant.
 */
function renderUnionBodySerializer(
  disc: { property: string; mapping: Record<string, string> },
  ctx: EmitterContext,
): string {
  const prop = fieldName(disc.property);
  const cases: string[] = [];
  for (const [value, modelName] of Object.entries(disc.mapping)) {
    const resolved = resolveInterfaceName(modelName, ctx);
    // Switch on a typed discriminator narrows `payload` to the variant, so the
    // serializer call type-checks without any casts.
    cases.push(`case '${value}': return serialize${resolved}(payload)`);
  }
  // Assign `payload` to `never` in the default branch to get a compile-time
  // exhaustiveness check — if a new variant is added to the union but not to
  // the switch, the build fails here.  At runtime, we still throw so an
  // unknown discriminator slipping through via `as any` fails loudly rather
  // than silently forwarding camelCase to the API.
  return `(() => { switch (payload.${prop}) { ${cases.join('; ')}; default: { const _unknown: never = payload; throw new Error(\`Unknown ${prop}: \${(_unknown as { ${prop}?: unknown }).${prop}}\`) } } })()`;
}

/**
 * Generate an IIFE expression that dispatches to the correct serializer for a
 * non-discriminated union request body.  Inspects model fields to find a
 * required field unique to each variant and uses `'field' in payload` guards.
 * Falls back to `payload` only when no variant can be distinguished.
 */
function renderNonDiscriminatedUnionBodySerializer(modelNames: string[], ctx: EmitterContext): string {
  const modelMap = new Map(ctx.spec.models.map((m) => [m.name, m]));

  // Try to detect an implicit discriminator: a required field present in all
  // variants whose type is `kind: 'literal'` with a distinct value per variant.
  // This covers oneOf unions where each variant has e.g. `grant_type: 'authorization_code'`.
  const implicitDisc = detectImplicitDiscriminator(modelNames, modelMap);
  if (implicitDisc) {
    return renderUnionBodySerializer(implicitDisc, ctx);
  }

  // Collect required field names per model (using camelCase domain names).
  const requiredFieldsByModel = new Map<string, Set<string>>();
  for (const name of modelNames) {
    const model = modelMap.get(name);
    if (!model) return 'payload';
    requiredFieldsByModel.set(name, new Set(model.fields.filter((f) => f.required).map((f) => fieldName(f.name))));
  }

  // For each model, find a required field that no other model has.
  const guards: Array<{ modelName: string; field: string }> = [];
  let fallbackModel: string | undefined;

  for (const name of modelNames) {
    const myFields = requiredFieldsByModel.get(name)!;
    let uniqueField: string | undefined;
    for (const field of myFields) {
      const isUnique = modelNames.every((other) => other === name || !requiredFieldsByModel.get(other)?.has(field));
      if (isUnique) {
        uniqueField = field;
        break;
      }
    }
    if (uniqueField) {
      guards.push({ modelName: name, field: uniqueField });
    } else if (!fallbackModel) {
      fallbackModel = name;
    } else {
      // Multiple models with no unique field — can't dispatch
      return 'payload';
    }
  }

  if (guards.length === 0) return 'payload';

  const parts: string[] = [];
  for (const { modelName, field } of guards) {
    const resolved = resolveInterfaceName(modelName, ctx);
    parts.push(`if ('${field}' in payload) return serialize${resolved}(payload as any)`);
  }
  if (fallbackModel) {
    const resolved = resolveInterfaceName(fallbackModel, ctx);
    parts.push(`return serialize${resolved}(payload as any)`);
  } else {
    parts.push('return payload');
  }

  return `(() => { ${parts.join('; ')} })()`;
}

/**
 * Detect an implicit discriminator from literal-typed fields.
 * Returns a discriminator descriptor if all variants share a required field
 * whose type is `kind: 'literal'` with a distinct value per variant.
 */
function detectImplicitDiscriminator(
  modelNames: string[],
  modelMap: Map<string, Model>,
): { property: string; mapping: Record<string, string> } | null {
  if (modelNames.length < 2) return null;

  const firstModel = modelMap.get(modelNames[0]);
  if (!firstModel) return null;

  // Candidate fields: required fields with literal type in the first model.
  const candidates = firstModel.fields.filter((f) => f.required && f.type.kind === 'literal');

  for (const candidate of candidates) {
    const mapping: Record<string, string> = {};
    const values = new Set<string | number | boolean | null>();
    let valid = true;

    for (const name of modelNames) {
      const model = modelMap.get(name);
      if (!model) {
        valid = false;
        break;
      }
      const field = model.fields.find((f) => f.name === candidate.name);
      if (!field || !field.required || field.type.kind !== 'literal') {
        valid = false;
        break;
      }
      const val = field.type.value;
      if (values.has(val)) {
        valid = false;
        break;
      } // duplicate value
      values.add(val);
      mapping[String(val)] = name;
    }

    if (valid && Object.keys(mapping).length === modelNames.length) {
      return { property: candidate.name, mapping };
    }
  }

  return null;
}

/** Return type for extractRequestBodyType when the body is a union. */
interface UnionBodyInfo {
  kind: 'union';
  typeStr: string;
  modelNames: string[];
  discriminator?: { property: string; mapping: Record<string, string> };
}

function extractRequestBodyType(
  op: Operation,
  ctx: EmitterContext,
): { kind: 'model'; name: string } | UnionBodyInfo | null {
  if (!op.requestBody) return null;
  if (op.requestBody.kind === 'model') return { kind: 'model', name: op.requestBody.name };
  if (op.requestBody.kind === 'union') {
    const modelNames: string[] = [];
    for (const variant of op.requestBody.variants) {
      if (variant.kind === 'model') modelNames.push(variant.name);
    }
    if (modelNames.length > 0) {
      const typeStr = modelNames.map((n) => resolveInterfaceName(n, ctx)).join(' | ');
      return {
        kind: 'union',
        typeStr,
        modelNames,
        discriminator: op.requestBody.discriminator,
      };
    }
  }
  return null;
}

/**
 * Map a parameter type to a TypeScript type string, handling inline enums
 * that don't have corresponding global enum definitions.  These would
 * otherwise emit bare names like `Type` or `Action` that are never imported.
 *
 * Recursively handles container types (arrays, nullable) so that inline
 * enums nested inside e.g. `array<enum>` are also inlined as string literal unions.
 */
function mapParamType(type: TypeRef, specEnumNames: Set<string>): string {
  if (type.kind === 'enum' && !specEnumNames.has(type.name)) {
    // Inline enum with no generated file — render values as string literal union
    if (type.values && type.values.length > 0) {
      return type.values.map((v: string | number) => (typeof v === 'string' ? `'${v}'` : String(v))).join(' | ');
    }
    return 'string';
  }
  if (type.kind === 'array') {
    const inner = mapParamType(type.items, specEnumNames);
    // Parenthesize union types when used as array element type
    return inner.includes(' | ') ? `(${inner})[]` : `${inner}[]`;
  }
  if (type.kind === 'nullable') {
    return `${mapParamType(type.inner, specEnumNames)} | null`;
  }
  return mapTypeRef(type);
}
