import type { Operation, Service, EmitterContext } from '@workos/oagen';
import { toPascalCase, toCamelCase, toKebabCase, toSnakeCase } from '@workos/oagen';
import { buildResolvedLookup, lookupMethodName } from '../shared/resolved-ops.js';
import { stripUrnPrefix } from '../shared/naming-utils.js';

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
    if (baselineInterfaceNames.has(domainName)) return domainName;
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
 *     `ValidateApiKeyOptions`).
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

  let inferred = ctx.overlayLookup?.modelNameByIR?.get(name);
  if (inferred) {
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
