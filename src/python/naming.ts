import type { Operation, Service, EmitterContext } from '@workos/oagen';
import { toPascalCase, toSnakeCase } from '@workos/oagen';
import { buildResolvedLookup, lookupMethodName, getMountTarget } from '../shared/resolved-ops.js';

/**
 * Map of lowercase acronym forms to their correct casing.
 * Applied as a post-processing step after toPascalCase.
 */
const ACRONYM_FIXES: [RegExp, string][] = [
  [/Workos/g, 'WorkOS'],
  [/Sso/g, 'SSO'],
  [/Mfa/g, 'MFA'],
  [/Jwt/g, 'JWT'],
  [/Cors/g, 'CORS'],
  [/Saml/g, 'SAML'],
  [/Scim/g, 'SCIM'],
  [/Rbac/g, 'RBAC'],
  [/Oauth/g, 'OAuth'],
  [/Oidc/g, 'OIDC'],
];

/**
 * Python class names that collide with builtins or typing imports.
 * When a model name resolves to one of these, suffix with "Model".
 */
const PYTHON_RESERVED_CLASS_NAMES = new Set([
  'List',
  'Dict',
  'Set',
  'Tuple',
  'Type',
  'Any',
  'Optional',
  'Union',
  'Literal',
  'Final',
  'ClassVar',
  'Callable',
]);

/** Suffixes stripped from spec model names before generating Python names. */
const STRIPPED_SUFFIXES = ['Dto', 'DTO'];

/**
 * Set of spec names that would collide with another name after suffix stripping.
 * Populated by `initializeNaming()`.
 */
let unsafeToStrip = new Set<string>();

/**
 * Initialize collision detection for suffix stripping.
 * Call once with all model + enum names before generating output.
 */
export function initializeNaming(specNames: string[]): void {
  unsafeToStrip = new Set<string>();
  const strippedToOriginals = new Map<string, string[]>();
  for (const name of specNames) {
    let stripped = name;
    for (const suffix of STRIPPED_SUFFIXES) {
      if (name.endsWith(suffix) && name.length > suffix.length) {
        stripped = name.slice(0, -suffix.length);
        break;
      }
    }
    if (!strippedToOriginals.has(stripped)) strippedToOriginals.set(stripped, []);
    strippedToOriginals.get(stripped)!.push(name);
  }
  for (const [, originals] of strippedToOriginals) {
    if (originals.length > 1) {
      for (const name of originals) unsafeToStrip.add(name);
    }
  }
}

/** Strip internal suffixes (e.g., "Dto") from a spec name, unless it would collide. */
function stripSuffixes(name: string): string {
  if (unsafeToStrip.has(name)) return name;
  for (const suffix of STRIPPED_SUFFIXES) {
    if (name.endsWith(suffix) && name.length > suffix.length) {
      return name.slice(0, -suffix.length);
    }
  }
  return name;
}

/** PascalCase class name with acronym preservation. */
export function className(name: string): string {
  let result = toPascalCase(stripSuffixes(name));
  for (const [pattern, replacement] of ACRONYM_FIXES) {
    result = result.replace(pattern, replacement);
  }
  if (PYTHON_RESERVED_CLASS_NAMES.has(result)) {
    result += 'Model';
  }
  return result;
}

/** snake_case file name (without extension). */
export function fileName(name: string): string {
  return toSnakeCase(stripSuffixes(name));
}

/** snake_case method name. */
export function methodName(name: string): string {
  return toSnakeCase(name);
}

/** snake_case field name. */
export function fieldName(name: string): string {
  return toSnakeCase(name);
}

/** snake_case module/directory name. */
export function moduleName(name: string): string {
  return toSnakeCase(name);
}

/** snake_case property name for service accessors on the client. */
export function servicePropertyName(name: string): string {
  return toSnakeCase(name);
}

/**
 * Resolve the effective service name, using the overlay-resolved class name
 * when available.
 */
export function resolveServiceName(service: Service, ctx: EmitterContext): string {
  return resolveClassName(service, ctx);
}

/**
 * Build a map from IR service name to resolved service name.
 */
export function buildServiceNameMap(services: Service[], ctx: EmitterContext): Map<string, string> {
  const map = new Map<string, string>();
  for (const service of services) {
    map.set(service.name, resolveServiceName(service, ctx));
  }
  return map;
}

/**
 * Resolve the output directory for a service.
 */
export function resolveServiceDir(resolvedServiceName: string): string {
  return moduleName(resolvedServiceName);
}

/** Resolve the SDK method name for an operation, using resolved operations first. */
export function resolveMethodName(op: Operation, _service: Service, ctx: EmitterContext): string {
  const lookup = buildResolvedLookup(ctx);
  const resolved = lookupMethodName(op, lookup);
  if (resolved) return resolved;
  // Fallback to overlay, then spec-derived
  const httpKey = `${op.httpMethod.toUpperCase()} ${op.path}`;
  const existing = ctx.overlayLookup?.methodByOperation?.get(httpKey);
  if (existing) return toSnakeCase(existing.methodName);
  return toSnakeCase(op.name);
}

/** Resolve the SDK class name for a service, using resolved operations' mountOn. */
export function resolveClassName(service: Service, ctx: EmitterContext): string {
  // Use resolved ops mountOn as canonical class name (flat pattern like PHP)
  for (const r of ctx.resolvedOperations ?? []) {
    if (r.service.name === service.name) return r.mountOn;
  }
  // Fallback to overlay, then IR name
  if (ctx.overlayLookup?.methodByOperation) {
    for (const op of service.operations) {
      const httpKey = `${op.httpMethod.toUpperCase()} ${op.path}`;
      const existing = ctx.overlayLookup.methodByOperation.get(httpKey);
      if (existing) return existing.className;
    }
  }
  return toPascalCase(service.name);
}

/** Resolve the type name for a model, checking overlay first. */
export function resolveTypeName(name: string, ctx: EmitterContext): string {
  const existing = ctx.overlayLookup?.interfaceByName?.get(name);
  if (existing) return existing;
  return toPascalCase(name);
}

/**
 * Build a map from IR service name to mount-target directory name.
 * Every service maps to its mount target's snake_case directory.
 * Replaces the old buildServiceDirMap(grouping) which required namespace grouping.
 */
export function buildMountDirMap(ctx: EmitterContext): Map<string, string> {
  const map = new Map<string, string>();
  for (const service of ctx.spec.services) {
    const target = getMountTarget(service, ctx);
    map.set(service.name, moduleName(target));
  }
  return map;
}

/** Convert a filesystem directory path (with /) to a Python dotted module path. */
export function dirToModule(dir: string): string {
  return dir.replace(/\//g, '.');
}

/**
 * Compute the relative import prefix (dots) to reach the namespace root from a given dir depth.
 * With the flat mount-based layout, dirs are always single-level so this returns ".." (2 dots).
 */
export function relativeImportPrefix(dirName: string): string {
  const depth = dirName.split('/').length;
  return '.'.repeat(depth + 1);
}
