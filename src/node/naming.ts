import type { Operation, Service, EmitterContext } from '@workos/oagen';
import { toPascalCase, toCamelCase, toKebabCase, toSnakeCase } from '@workos/oagen';
import { buildResolvedLookup, lookupMethodName } from '../shared/resolved-ops.js';
import { stripUrnPrefix } from '../shared/naming-utils.js';
import {
  buildExportedClassNameSet as buildExportedClassNameSetShared,
  resolveServiceTarget as resolveServiceTargetShared,
} from '../shared/service-name-collision.js';

/** Strip spec-noise suffixes (e.g., "Dto") from an IR name. */
export function stripNoiseSuffixes(name: string): string {
  return name.replace(/Dto$/i, '');
}

/** PascalCase class/interface name. */
export function className(name: string): string {
  return toPascalCase(stripUrnPrefix(name));
}

/** kebab-case file name (without extension). */
export function fileName(name: string): string {
  return toKebabCase(stripUrnPrefix(name));
}

/** camelCase method name. */
export function methodName(name: string): string {
  return toCamelCase(name);
}

/** camelCase field name for domain interfaces. */
export function fieldName(name: string): string {
  return toCamelCase(name);
}

/**
 * camelCase domain field name for a model field, honoring a `domainName`
 * override (set via the `fieldHints` config) so a wire field can surface under
 * a friendlier name. The wire name (see {@link wireFieldName}) still derives
 * from `field.name`.
 */
export function domainFieldName(field: { name: string; domainName?: string }): string {
  return toCamelCase(field.domainName ?? field.name);
}

/** snake_case field name for wire/response interfaces. */
export function wireFieldName(name: string): string {
  return toSnakeCase(name);
}

/**
 * Active set of `Serialized${Name}` interfaces in the live SDK, harvested
 * from `ctx.apiSurface` once per generation run. When non-empty, the
 * legacy wire-naming scheme wins so existing hand-written serializer files
 * continue to compile.
 *
 * Set by `index.ts` immediately after `getSurface(ctx)` runs.
 */
let baselineSerializedNames: Set<string> = new Set();
export function setBaselineSerializedNames(names: Set<string>): void {
  baselineSerializedNames = names;
}

/**
 * Set of every interface name present in the baseline live SDK, regardless
 * of naming convention. Used to detect single-form baselines (where one
 * `*Response`-suffixed interface stands for both the domain and wire shape)
 * so we don't synthesize a non-existent `*Wire` variant.
 */
let baselineInterfaceNames: Set<string> = new Set();
export function setBaselineInterfaceNames(names: Set<string>): void {
  baselineInterfaceNames = names;
}

/**
 * Every name DECLARED by the live SDK or baseline api-surface — interfaces
 * AND type aliases. Exact-name declarations preempt structural renames in
 * `resolveInterfaceName`: when the IR model's own name is already declared,
 * the structural matcher must not re-point it at a different declaration.
 *
 * This matters for alias-form files (`export type X = Y;`): the engine's
 * api-surface records X under `typeAliases` with no fields, so its
 * exact-name pass cannot claim X and the Jaccard fallback "renames" IR
 * model X to whatever interface looks similar. Propagating that rename
 * emitted duplicate, renamed declarations whose form flip-flopped on every
 * regeneration (workos-node ApiKeyOwner / UserManagement model files).
 *
 * Set by `index.ts` immediately after `getSurface(ctx)` runs.
 */
let baselineDeclaredNames: Set<string> = new Set();
export function setBaselineDeclaredNames(names: Set<string>): void {
  baselineDeclaredNames = names;
}

/**
 * IR models that belong to newly-adopted services should not be renamed by
 * structural baseline matches from unrelated hand-written services.
 */
let adoptedModelNames: Set<string> = new Set();
export function setAdoptedModelNames(names: Set<string>): void {
  adoptedModelNames = names;
}
export function isAdoptedModelName(name: string): boolean {
  return adoptedModelNames.has(name);
}

/**
 * IR model names handled by the discriminated-models module. These must not
 * be remapped by the structural matcher because that module emits files and
 * helpers under the original IR names.
 */
let discriminatedModelNames: Set<string> = new Set();
export function setDiscriminatedModelNames(names: Set<string>): void {
  discriminatedModelNames = names;
}

/**
 * Domain names that `resolveInterfaceName` reached via a structural rename
 * — the resolved name differs from the IR model's own name. `wireInterfaceName`
 * consults this set to decide whether to fire the "single-form wire" case:
 * that case is *only* meant for structurally-renamed models, where the
 * baseline owns a `*Response` interface representing the wire shape with no
 * separate `*Wire` companion. Without this signal, a freshly-emitted model
 * whose IR name already ends in `Response` (e.g. `CreateDataKeyResponse`)
 * would land in the same case as soon as a prior buggy regen wrote the
 * baseline — producing two `export interface CreateDataKeyResponse { ... }`
 * declarations in the same file.
 */
let structurallyRenamedDomainNames: Set<string> = new Set();
export function setStructurallyRenamedDomainNames(names: Set<string>): void {
  structurallyRenamedDomainNames = names;
}

/**
 * The structural half of `resolveInterfaceName`, pre-injectivity: look up the
 * engine's structurally-inferred match (`overlayLookup.modelNameByIR`), apply
 * the adopted/discriminated/declared-name guards, and normalize legacy
 * `Serialized*` / wire-shaped `*Response` matches down to the baseline domain
 * name. Returns the candidate live name, or undefined when no structural
 * match applies. Shared by `resolveInterfaceName` and the claims registry so
 * both see the exact same candidate for every IR model.
 */
function inferStructuralRename(name: string, ctx: EmitterContext): string | undefined {
  let inferred =
    adoptedModelNames.has(name) || discriminatedModelNames.has(name)
      ? undefined
      : ctx.overlayLookup?.modelNameByIR?.get(name);
  // Exact-name declarations preempt structural renames: when the live SDK
  // already declares `name` (interface or type alias), a non-identity
  // structural match is a misfire — the alias/typeAlias resolution in
  // `resolveInterfaceName` (or the name itself) is the canonical answer. See
  // `setBaselineDeclaredNames` for the alias-form feedback loop this breaks.
  if (inferred && inferred !== name && baselineDeclaredNames.has(name)) {
    return undefined;
  }
  if (!inferred) return undefined;
  if (inferred.startsWith('Serialized')) {
    const stripped = inferred.slice('Serialized'.length);
    if (stripped && ctx.apiSurface?.interfaces?.[stripped]) {
      inferred = stripped;
    }
  }
  // Structural matchers tend to lock onto the wire-shaped baseline
  // interface (`AuditLogSchemaResponse`) because the IR carries
  // snake_case fields. Prefer the corresponding domain name (without
  // the `Response` suffix) when both exist in baseline — domain refs
  // belong on the domain side, the wire/serialize path picks up the
  // `*Response` variant via `wireInterfaceName`.
  if (inferred.endsWith('Response') && ctx.apiSurface?.interfaces) {
    const stripped = inferred.slice(0, -'Response'.length);
    if (stripped && ctx.apiSurface.interfaces[stripped]) {
      inferred = stripped;
    }
  }
  return inferred;
}

/**
 * Per-run registry making structural name resolution INJECTIVE: live-surface
 * name → the single IR model name allowed to claim it. Built lazily from
 * `ctx.spec.models` on first use and cached per ctx.
 *
 * Cache-correctness invariant (relied on, not assumed): the `ctx` reaching
 * this function is always the memoized `nodeCtx` from `withNodeOperationOverrides`
 * — every emitter hook derives it as its first step and threads it through
 * `getSurface`/`resolveInterfaceName`, and that helper returns one stable
 * object per run. `nodeCtx.spec` is built once via spread and `spec.models` is
 * never reassigned or mutated in place anywhere (enrichment pushes only onto a
 * pre-enrichment local collector). So the cached value can never drift from
 * the `spec.models` it was computed from. Do not begin mutating `spec.models`
 * under a live ctx without invalidating this cache.
 *
 * Without it, the structural fallback could map two distinct IR models onto
 * one live declaration. workos-node AuditLogs evidence: IR
 * `AuditLogEventActor` and `AuditLogEventTarget` (near-identical shapes) both
 * resolved to the hand-written `AuditLogActor`, so
 * `audit-log-event-target.interface.ts` was emitted declaring
 * `export interface AuditLogActor` (file stem and declaration disagree),
 * with duplicate imports/`describe` blocks and two `serializeAuditLogActor`
 * definitions downstream. The raw engine overlay is injective on its own
 * names, but the resolver's `Serialized*`/`*Response` normalization below can
 * collapse two distinct raw matches onto one bare name — the claims registry
 * gates the final, post-normalization answer.
 *
 * Claim order:
 *  1. Exact-name overrides (`overlayLookup.interfaceByName`) claim first.
 *  2. Identity structural matches (IR name === live name) claim their own name.
 *  3. Contested renames go to the claimant with the higher field-overlap
 *     similarity; ties break toward the closer name (edit distance), then
 *     lexicographically for determinism. Losers are NEVER unified — they keep
 *     their canonical IR-derived names.
 */
const structuralClaimsCache = new WeakMap<EmitterContext, Map<string, string>>();

/** Jaccard similarity between two normalized field-name sets. */
function fieldJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Levenshtein distance over lowercased names (tie-break for contested claims). */
function nameDistance(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  if (s === t) return 0;
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i++) {
    const curr = [i];
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[t.length];
}

/** Normalized field-name signature of an IR model. */
function irFieldSignature(model: { fields: { name: string }[] }): Set<string> {
  return new Set(model.fields.map((f) => toSnakeCase(f.name)));
}

/** Normalized field-name signature of a live-surface interface, if known. */
function liveFieldSignature(ctx: EmitterContext, liveName: string): Set<string> | undefined {
  const iface = ctx.apiSurface?.interfaces?.[liveName] as { fields?: Record<string, unknown> } | undefined;
  if (!iface?.fields) return undefined;
  return new Set(Object.keys(iface.fields).map((f) => toSnakeCase(f)));
}

function getStructuralNameClaims(ctx: EmitterContext): Map<string, string> {
  const cached = structuralClaimsCache.get(ctx);
  if (cached) return cached;
  const claims = new Map<string, string>();

  // 1. Exact-name overrides claim first (mirrors resolveInterfaceName step 1).
  for (const [irName, liveName] of ctx.overlayLookup?.interfaceByName ?? new Map<string, string>()) {
    if (!claims.has(liveName)) claims.set(liveName, irName);
  }

  // 2. Identity matches claim their own name; renames queue up per live name.
  const contested = new Map<string, string[]>();
  const modelsByName = new Map<string, { fields: { name: string }[] }>();
  for (const model of ctx.spec.models) {
    modelsByName.set(model.name, model);
    if (ctx.overlayLookup?.interfaceByName?.has(model.name)) continue;
    const inferred = inferStructuralRename(model.name, ctx);
    if (!inferred) continue;
    if (inferred === model.name) {
      if (!claims.has(inferred)) claims.set(inferred, model.name);
      continue;
    }
    const group = contested.get(inferred);
    if (group) group.push(model.name);
    else contested.set(inferred, [model.name]);
  }

  // 3. Award each contested live name to exactly one structural claimant.
  for (const [liveName, irNames] of contested) {
    if (claims.has(liveName)) continue; // exact/identity claims preempt renames
    let winner = irNames[0];
    if (irNames.length > 1) {
      const liveFields = liveFieldSignature(ctx, liveName);
      const scoreOf = (irName: string): number => {
        const model = modelsByName.get(irName);
        if (!model || !liveFields) return 0;
        return fieldJaccard(irFieldSignature(model), liveFields);
      };
      winner = [...irNames].sort((a, b) => {
        const scoreDiff = scoreOf(b) - scoreOf(a);
        if (scoreDiff !== 0) return scoreDiff;
        const distDiff = nameDistance(a, liveName) - nameDistance(b, liveName);
        if (distDiff !== 0) return distDiff;
        return a < b ? -1 : a > b ? 1 : 0;
      })[0];
    }
    claims.set(liveName, winner);
  }

  structuralClaimsCache.set(ctx, claims);
  return claims;
}

/**
 * Wire/response interface name.
 *
 * Resolution order:
 *  1. `Serialized${domainName}` if it exists in the baseline (legacy
 *     workos-node convention; lets hand-written serializer files keep
 *     compiling).
 *  2. `${domainName}Wire` when the domain ends in `Response` AND the
 *     baseline actually has a `*Wire` interface (avoids
 *     `FooResponseResponse` stutter).
 *  3. The bare `domainName` itself when it already ends in `Response` and
 *     no `*Wire` variant exists — this happens when the structural matcher
 *     maps an IR model to a baseline-wire-shaped interface
 *     (`AuditLogSchemaJson` → `AuditLogSchemaResponse`) and the baseline
 *     has no separate domain/wire split.
 *  4. `${domainName}Response` for the standard fresh-emit case.
 */
export function wireInterfaceName(domainName: string): string {
  const serialized = `Serialized${domainName}`;
  if (baselineSerializedNames.has(serialized)) return serialized;

  if (domainName.endsWith('Response')) {
    const wireForm = `${domainName}Wire`;
    if (baselineInterfaceNames.has(wireForm)) return wireForm;
    // Single-form case (#3 in the docstring): only fire when the resolver
    // structurally renamed an IR model to this baseline name. Otherwise a
    // fresh `CreateDataKeyResponse`-style IR model would collapse onto its
    // own name as soon as one buggy regen wrote `CreateDataKeyResponse` to
    // the baseline, perpetuating the duplicate-interface emission.
    if (structurallyRenamedDomainNames.has(domainName) && baselineInterfaceNames.has(domainName)) {
      return domainName;
    }
    return wireForm;
  }
  return `${domainName}Response`;
}

/** kebab-case service directory name. */
export function serviceDirName(name: string): string {
  return toKebabCase(name);
}

/** camelCase property name for service accessors on the client. */
export function servicePropertyName(name: string): string {
  return toCamelCase(name);
}

/**
 * Resolve the effective service name, using the overlay-resolved class name
 * when available.
 */
export function resolveServiceName(service: Service, ctx: EmitterContext): string {
  return resolveClassName(service, ctx);
}

/**
 * Build the set of model + enum class names exported by the SDK. Used to
 * detect collisions with operation-client class names — a colliding service
 * gets a `Service` suffix appended.
 */
export function buildExportedClassNameSet(ctx: EmitterContext): Set<string> {
  return buildExportedClassNameSetShared(ctx, className);
}

/**
 * Resolve a service's mount-target identifier, appending `Service` on
 * collision with an exported model/enum class. The result feeds `className`
 * and `fileName` so both the `export class` declaration and its file name
 * stay aligned (e.g. `OrganizationMembershipService` /
 * `organization-membership-service.ts`).
 */
export function resolveServiceTarget(target: string, exportedClasses: Set<string>): string {
  return resolveServiceTargetShared(target, exportedClasses, className);
}

/**
 * Build a map from IR service name -> resolved service name.
 */
export function buildServiceNameMap(services: Service[], ctx: EmitterContext): Map<string, string> {
  const map = new Map<string, string>();
  for (const service of services) {
    map.set(service.name, resolveServiceName(service, ctx));
  }
  return map;
}

/** Resolve the output directory for a service. */
export function resolveServiceDir(resolvedServiceName: string): string {
  return serviceDirName(resolvedServiceName);
}

/** Resolve the SDK method name for an operation, using resolved operations first. */
export function resolveMethodName(op: Operation, _service: Service, ctx: EmitterContext): string {
  const lookup = buildResolvedLookup(ctx);
  const resolved = lookupMethodName(op, lookup);
  if (resolved) return toCamelCase(resolved);
  const httpKey = `${op.httpMethod.toUpperCase()} ${op.path}`;
  const existing = ctx.overlayLookup?.methodByOperation?.get(httpKey);
  if (existing) return existing.methodName;
  return toCamelCase(op.name);
}

/** Resolve the SDK class name for a service, using resolved ops mountOn as canonical. */
export function resolveClassName(service: Service, ctx: EmitterContext): string {
  for (const r of ctx.resolvedOperations ?? []) {
    if (r.service.name === service.name) return r.mountOn;
  }
  if (ctx.overlayLookup?.methodByOperation) {
    for (const op of service.operations) {
      const httpKey = `${op.httpMethod.toUpperCase()} ${op.path}`;
      const existing = ctx.overlayLookup.methodByOperation.get(httpKey);
      if (existing) return existing.className;
    }
  }
  return toPascalCase(service.name);
}

/**
 * Resolve the interface name for a model, checking overlay first.
 *
 * Lookup order:
 *  1. `overlayLookup.interfaceByName` — exact-name overrides from the live SDK.
 *  2. `overlayLookup.modelNameByIR` — structurally-inferred matches (e.g., IR
 *     `ValidateApiKey` with one field `value: string` → live SDK interface
 *     `ValidateApiKeyOptions`), gated by the injective claims registry: each
 *     live name goes to at most one IR model (see `getStructuralNameClaims`).
 *  3. Type-alias resolution (when an alias points to an interface).
 *  4. Suffix-fallback heuristic for the workos-node `*Options` convention:
 *     when the IR name `X` has no baseline match but `XOptions` does, use
 *     `XOptions`. The convention is widely used for request-body interfaces
 *     in workos-node (CreateOrganizationOptions, ListUsersOptions, etc.).
 *  5. Default — clean and PascalCase the IR name.
 */
export function resolveInterfaceName(name: string, ctx: EmitterContext, opts?: { skipTypeAlias?: boolean }): string {
  const existing = ctx.overlayLookup?.interfaceByName?.get(name);
  if (existing) return existing;

  let inferred = inferStructuralRename(name, ctx);
  if (inferred !== undefined) {
    // Injectivity gate: a structurally-renamed live name may be claimed by
    // at most one IR model per run. When another model holds the claim, the
    // rename is dropped and this model keeps its canonical IR-derived name.
    if (inferred !== name) {
      const claimant = getStructuralNameClaims(ctx).get(inferred);
      if (claimant !== undefined && claimant !== name) {
        inferred = undefined;
      }
    }
    if (inferred !== undefined) return inferred;
  }

  if (!opts?.skipTypeAlias && ctx.apiSurface?.typeAliases) {
    const alias = ctx.apiSurface.typeAliases[name] as { value?: string } | undefined;
    if (alias?.value && ctx.apiSurface.interfaces?.[alias.value]) {
      return alias.value;
    }
  }

  // Suffix-fallback for the workos-node `*Options` convention, restricted to
  // the case where the baseline `${name}Options` interface lives in the file
  // we'd compute from the IR name itself (e.g. `validate-api-key.interface.ts`
  // exports `ValidateApiKeyOptions`). Without this restriction, we'd re-point
  // every IR name with an `*Options` baseline to a different file (e.g.
  // `CreateOrganizationApiKey` → `…Options` lives in
  // `create-organization-api-key-options.interface.ts`, NOT
  // `create-organization-api-key.interface.ts`).
  if (ctx.apiSurface?.interfaces) {
    const ifaces = ctx.apiSurface.interfaces;
    if (!ifaces[name]) {
      const optionsCandidate = `${name}Options`;
      const optionsInfo = ifaces[optionsCandidate] as { sourceFile?: string } | undefined;
      if (optionsInfo?.sourceFile) {
        const expectedStem = toKebabCase(stripUrnPrefix(name));
        if (optionsInfo.sourceFile.endsWith(`/${expectedStem}.interface.ts`)) {
          return optionsCandidate;
        }
      }
    }
  }

  const cleaned = ctx.apiSurface ? name : stripNoiseSuffixes(name);
  return toPascalCase(stripUrnPrefix(cleaned));
}
