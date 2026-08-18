import type { ApiSpec, EmitterContext, Enum, Model, Service } from '@workos/oagen';
import { assignModelsToServices, collectFieldDependencies, planOperation, walkTypeRef } from '@workos/oagen';
import { fileName } from './naming.js';
import { buildListScaffoldingSkip, detectDiscriminators } from '../shared/model-utils.js';

/**
 * Walk every operation across all services and tally, per schema, the set of
 * services that transitively reference it. Schemas referenced by more than one
 * service are "shared" — they should be emitted under common/ rather than
 * the first alphabetical service that happens to use them.
 *
 * Transitive walk for models follows model->model field references AND
 * discriminator variant mappings to a fixed point; enums are leaves.
 */
export function findSharedSchemas(spec: ApiSpec): { models: Set<string>; enums: Set<string> } {
  const modelsByName = new Map(spec.models.map((m) => [m.name, m]));
  const modelToServices = new Map<string, Set<string>>();
  const enumToServices = new Map<string, Set<string>>();

  const note = (map: Map<string, Set<string>>, name: string, service: string): void => {
    let bucket = map.get(name);
    if (!bucket) {
      bucket = new Set();
      map.set(name, bucket);
    }
    bucket.add(service);
  };

  for (const service of spec.services) {
    const directModels = new Set<string>();
    const directEnums = new Set<string>();
    const collect = (ref: unknown): void => {
      walkTypeRef(ref as never, {
        model: (r) => directModels.add(r.name),
        enum: (r) => directEnums.add(r.name),
      });
    };

    for (const op of service.operations) {
      if (op.requestBody) collect(op.requestBody);
      collect(op.response);
      for (const p of [...op.pathParams, ...op.queryParams, ...op.headerParams, ...(op.cookieParams ?? [])]) {
        collect(p.type);
      }
      if (op.pagination) collect(op.pagination.itemType);
      for (const err of op.errors) {
        if (err.type) collect(err.type);
      }
      for (const sr of op.successResponses ?? []) {
        collect(sr.type);
      }
    }

    // Transitively expand model references via field types AND discriminator
    // variant mappings (dispatchers route to variants without listing them as
    // fields, so plain field-walking misses them).
    const queue = [...directModels];
    while (queue.length > 0) {
      const name = queue.pop()!;
      const model = modelsByName.get(name);
      if (!model) continue;
      for (const field of model.fields) {
        walkTypeRef(field.type as never, {
          model: (r) => {
            if (!directModels.has(r.name)) {
              directModels.add(r.name);
              queue.push(r.name);
            }
          },
          enum: (r) => directEnums.add(r.name),
        });
      }
      const disc = (model as { discriminator?: { property: string; mapping: Record<string, string> } }).discriminator;
      if (disc?.mapping) {
        for (const variantName of Object.values(disc.mapping)) {
          if (!directModels.has(variantName)) {
            directModels.add(variantName);
            queue.push(variantName);
          }
        }
      }
    }

    for (const name of directModels) note(modelToServices, name, service.name);
    for (const name of directEnums) note(enumToServices, name, service.name);
  }

  const sharedModels = new Set<string>();
  for (const [name, services] of modelToServices) {
    if (services.size >= 2) sharedModels.add(name);
  }
  const sharedEnums = new Set<string>();
  for (const [name, services] of enumToServices) {
    if (services.size >= 2) sharedEnums.add(name);
  }

  return { models: sharedModels, enums: sharedEnums };
}

/**
 * Final placement decisions for every model and enum in the spec. Computed
 * once and consumed by every Python emitter pass (models, enums, resources,
 * tests) so they all agree on which symbols live in `common/` and which live
 * in a service directory.
 */
export interface SchemaPlacement {
  /** Model -> service. Models in common/ are absent. */
  modelToService: Map<string, string>;
  /** Enum -> service. Enums in common/ are absent. */
  enumToService: Map<string, string>;
  /** Pre-relocation model -> service. Used to attach BC re-exports to the natural service barrel. */
  originalModelToService: Map<string, string>;
  /** Pre-relocation enum -> service. */
  originalEnumToService: Map<string, string>;
  /** Models relocated to common/ (the union of initial sharing + closure expansion). */
  relocatedModels: Set<string>;
  /** Enums relocated to common/. */
  relocatedEnums: Set<string>;
  /** Model alias name -> canonical model name (Python-only structural dedup). */
  modelAliases: Map<string, string>;
  /** Enum alias name -> canonical enum name. */
  enumAliases: Map<string, string>;
}

export function computeSchemaPlacement(spec: ApiSpec, ctx: EmitterContext): SchemaPlacement {
  // Annotate models with implicit discriminators so the closure can follow
  // dispatcher → variant edges. detectDiscriminators is idempotent.
  const annotatedModels = detectDiscriminators(spec.models);
  if (annotatedModels !== spec.models) {
    spec = { ...spec, models: annotatedModels };
  }
  const modelsByName = new Map(spec.models.map((m) => [m.name, m]));
  const hintedModels = new Set(Object.keys(ctx.modelHints ?? {}));

  const originalModelToService = assignModelsToServices(spec.models, spec.services, ctx.modelHints);
  const originalEnumToService = assignEnumsToServicesNatural(spec.enums, spec.services);

  // Precompute Python-specific structural alias maps so the closure can
  // promote a canonical when its alias is shared.
  const modelAliases = computeModelAliases(spec);
  const enumAliases = computeEnumAliases(spec.enums);

  const initial = findSharedSchemas(spec);

  // Ensure aliases imply their canonical: if the alias is shared, the canonical
  // must follow it into common/, otherwise the alias file would import from a
  // service directory.
  for (const [aliasName, canonicalName] of modelAliases) {
    if (initial.models.has(aliasName)) initial.models.add(canonicalName);
  }
  for (const [aliasName, canonicalName] of enumAliases) {
    if (initial.enums.has(aliasName)) initial.enums.add(canonicalName);
  }

  // Initial common/-bound set: everything findSharedSchemas flagged (minus
  // hinted models — direct shares respect explicit pins) plus everything that
  // is unassigned from the natural placement and not pinned.
  const sharedModels = new Set<string>();
  for (const name of initial.models) {
    if (!hintedModels.has(name)) sharedModels.add(name);
  }
  for (const model of spec.models) {
    if (!originalModelToService.has(model.name) && !hintedModels.has(model.name)) {
      sharedModels.add(model.name);
    }
  }
  const sharedEnums = new Set(initial.enums);
  for (const enumDef of spec.enums) {
    if (!originalEnumToService.has(enumDef.name)) sharedEnums.add(enumDef.name);
  }

  // Closure: any model/enum referenced by a model that ends up in common/
  // must also be in common/, otherwise the emitted common/ file would reach
  // back into a service package and create a circular-import hazard. Hints
  // are *not* a stop signal here — the closure is structural. If a hinted
  // model is reachable from common/, leaving it pinned to a service would
  // re-introduce the back-edge. BC for the pinned import path is preserved
  // via re-exports from the natural service barrel.
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of sharedModels) {
      const model = modelsByName.get(name);
      if (!model) continue;
      const deps = collectEmittedDependencies(model, modelAliases);
      for (const dep of deps.models) {
        if (sharedModels.has(dep)) continue;
        if (!modelsByName.has(dep)) continue;
        sharedModels.add(dep);
        changed = true;
      }
      for (const dep of deps.enums) {
        if (sharedEnums.has(dep)) continue;
        sharedEnums.add(dep);
        changed = true;
      }
    }
  }

  // Build final assignment maps by relocating shared symbols to common/
  // (i.e. removing them from the per-service assignment).
  const modelToService = new Map(originalModelToService);
  for (const name of sharedModels) {
    modelToService.delete(name);
  }
  const enumToService = new Map(originalEnumToService);
  for (const name of sharedEnums) {
    enumToService.delete(name);
  }

  // relocatedModels = models with a natural service that ended up in common/.
  // Models without a natural service were never in a service barrel, so they
  // don't need a BC re-export. Hinted models DO get re-exported from the
  // hinted service so existing imports keep resolving.
  const relocatedModels = new Set<string>();
  for (const name of sharedModels) {
    if (!originalModelToService.has(name)) continue;
    relocatedModels.add(name);
  }
  const relocatedEnums = new Set<string>();
  for (const name of sharedEnums) {
    if (!originalEnumToService.has(name)) continue;
    relocatedEnums.add(name);
  }

  return {
    modelToService,
    enumToService,
    originalModelToService,
    originalEnumToService,
    relocatedModels,
    relocatedEnums,
    modelAliases,
    enumAliases,
  };
}

/**
 * Dependencies the emitter will materialize for a model's generated file.
 * Captures alias canonicals, discriminator variants, and field-level model+enum
 * references so the placement closure can decide whether the dependency must
 * also live in `common/`.
 */
function collectEmittedDependencies(
  model: Model,
  modelAliases: Map<string, string>,
): { models: Set<string>; enums: Set<string> } {
  const models = new Set<string>();
  const enums = new Set<string>();

  const canonical = modelAliases.get(model.name);
  if (canonical) {
    models.add(canonical);
    return { models, enums };
  }

  const disc = (model as { discriminator?: { property: string; mapping: Record<string, string> } }).discriminator;
  if (disc?.mapping) {
    for (const variant of Object.values(disc.mapping)) models.add(variant);
  }

  const fieldDeps = collectFieldDependencies(model);
  for (const m of fieldDeps.models) models.add(m);
  for (const e of fieldDeps.enums) enums.add(e);

  return { models, enums };
}

interface ModelUsage {
  requestOnly: Set<string>;
  response: Set<string>;
  mixed: Set<string>;
}

function collectModelUsage(spec: ApiSpec): ModelUsage {
  const request = new Set<string>();
  const response = new Set<string>();

  for (const service of spec.services) {
    for (const op of service.operations) {
      const plan = planOperation(op);
      if (plan.responseModelName) response.add(plan.responseModelName);
      if (op.pagination?.itemType.kind === 'model') response.add(op.pagination.itemType.name);
      if (op.requestBody?.kind === 'model') request.add(op.requestBody.name);
      if (op.requestBody?.kind === 'union') {
        for (const variant of op.requestBody.variants ?? []) {
          if (variant.kind === 'model') request.add(variant.name);
        }
      }
    }
  }

  const mixed = new Set<string>();
  for (const name of request) if (response.has(name)) mixed.add(name);
  const requestOnly = new Set([...request].filter((name) => !mixed.has(name)));
  const responseOnly = new Set([...response].filter((name) => !mixed.has(name)));

  return { requestOnly, response: responseOnly, mixed };
}

function compareAliasPriority(left: string, right: string, usage: ModelUsage): number {
  const score = (name: string): number => {
    if (usage.response.has(name)) return 0;
    if (usage.mixed.has(name)) return 1;
    if (usage.requestOnly.has(name)) return 2;
    return 3;
  };

  const diff = score(left) - score(right);
  if (diff !== 0) return diff;
  return left.localeCompare(right);
}

function canAliasModels(canonical: string, alias: string, usage: ModelUsage): boolean {
  // Aliases that snake_case-collide with their canonical would self-import.
  if (fileName(canonical) === fileName(alias)) return false;
  // Don't alias across the request/response boundary — they may evolve apart.
  if (
    (usage.response.has(canonical) && usage.requestOnly.has(alias)) ||
    (usage.response.has(alias) && usage.requestOnly.has(canonical))
  ) {
    return false;
  }
  return true;
}

/**
 * Compute the Python emitter's structural model dedup map: alias -> canonical.
 * Mirrors the logic in models.ts so the placement closure can promote
 * canonicals when their aliases are shared.
 */
export function computeModelAliases(spec: ApiSpec): Map<string, string> {
  const recursiveHashes = buildRecursiveHashMap(spec.models, spec.enums);
  const usage = collectModelUsage(spec);
  // List scaffolding the emitter never writes (paginated wrappers and their
  // metadata) must not participate in dedup: a surviving metadata model whose
  // canonical is a skipped twin would alias to a module that doesn't exist.
  const skipScaffolding = buildListScaffoldingSkip(spec.models, spec.services);

  const hashGroups = new Map<string, string[]>();
  for (const model of spec.models) {
    if (skipScaffolding(model)) continue;
    const hash = recursiveHashes.get(model.name) ?? '';
    if (!hashGroups.has(hash)) hashGroups.set(hash, []);
    hashGroups.get(hash)!.push(model.name);
  }

  const aliasOf = new Map<string, string>();
  for (const [, names] of hashGroups) {
    if (names.length <= 1) continue;
    const sorted = [...names].sort((a, b) => compareAliasPriority(a, b, usage));
    const canonical = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      if (canAliasModels(canonical, sorted[i], usage)) {
        aliasOf.set(sorted[i], canonical);
      }
    }
  }
  return aliasOf;
}

/**
 * Compute the Python emitter's structural enum dedup map: alias -> canonical.
 * Mirrors the logic in enums.ts.
 */
export function computeEnumAliases(enums: Enum[]): Map<string, string> {
  const hashGroups = new Map<string, string[]>();
  for (const enumDef of enums) {
    const hash = [...enumDef.values]
      .map((v) => String(v.value))
      .sort()
      .join('|');
    if (!hashGroups.has(hash)) hashGroups.set(hash, []);
    hashGroups.get(hash)!.push(enumDef.name);
  }

  const aliasOf = new Map<string, string>();
  for (const [, names] of hashGroups) {
    if (names.length <= 1) continue;
    const sorted = [...names].sort();
    const canonical = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      aliasOf.set(sorted[i], canonical);
    }
  }
  return aliasOf;
}

/**
 * Recursive structural hashing for models so dedup runs against deeply-equal
 * shapes, not just same-named ones. Cycles fall back to the model name.
 */
function buildRecursiveHashMap(models: Model[], enums: Enum[]): Map<string, string> {
  const modelByName = new Map(models.map((m) => [m.name, m]));
  const hashCache = new Map<string, string>();
  const visiting = new Set<string>();

  const enumVH = new Map<string, string>();
  for (const e of enums) {
    enumVH.set(
      e.name,
      [...e.values]
        .map((v) => String(v.value))
        .sort()
        .join('|'),
    );
  }

  function modelHash(name: string): string {
    const cached = hashCache.get(name);
    if (cached != null) return cached;
    if (visiting.has(name)) return `m:${name}`;
    visiting.add(name);

    const model = modelByName.get(name);
    if (!model) {
      visiting.delete(name);
      return `m:${name}`;
    }

    const hash = [...model.fields]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((f) => `${f.name}:${deepTypeHash(f.type)}:${f.required}`)
      .join('|');

    visiting.delete(name);
    hashCache.set(name, hash);
    return hash;
  }

  function deepTypeHash(ref: any): string {
    switch (ref.kind) {
      case 'primitive':
        return `p:${ref.type}${ref.format ? `:${ref.format}` : ''}`;
      case 'model':
        return `m:{${modelHash(ref.name)}}`;
      case 'enum': {
        const vh = enumVH.get(ref.name);
        return vh != null ? `e:{${vh}}` : `e:${ref.name}`;
      }
      case 'array':
        return `a:${deepTypeHash(ref.items)}`;
      case 'nullable':
        return `n:${deepTypeHash(ref.inner)}`;
      case 'union':
        return `u:${(ref.variants ?? [])
          .map((v: any) => deepTypeHash(v))
          .sort()
          .join(',')}`;
      case 'map':
        return `d:${deepTypeHash(ref.valueType)}`;
      case 'literal':
        return `l:${String(ref.value)}`;
      default:
        return 'unknown';
    }
  }

  for (const model of models) modelHash(model.name);
  return hashCache;
}

/**
 * Natural enum-to-service assignment without sharing logic — the first service
 * (alphabetically by spec order) to reference an enum wins.
 */
function assignEnumsToServicesNatural(enums: Enum[], services: Service[]): Map<string, string> {
  const enumNames = new Set(enums.map((e) => e.name));
  const enumToService = new Map<string, string>();

  for (const service of services) {
    const refs = new Set<string>();
    const collect = (ref: any): void => {
      walkTypeRef(ref, { enum: (r: any) => refs.add(r.name) });
    };
    for (const op of service.operations) {
      if (op.requestBody) collect(op.requestBody);
      collect(op.response);
      for (const p of [...op.pathParams, ...op.queryParams, ...op.headerParams, ...(op.cookieParams ?? [])]) {
        collect(p.type);
      }
    }
    for (const name of refs) {
      if (!enumNames.has(name)) continue;
      if (!enumToService.has(name)) enumToService.set(name, service.name);
    }
  }

  return enumToService;
}
