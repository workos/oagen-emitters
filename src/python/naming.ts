import type { Operation, Service, EmitterContext } from '@workos/oagen';
import { toPascalCase, toSnakeCase } from '@workos/oagen';
import { buildResolvedLookup, lookupMethodName, getMountTarget } from '../shared/resolved-ops.js';
import { stripUrnPrefix, applyAcronymFixes } from '../shared/naming-utils.js';
import {
  buildExportedClassNameSet as buildExportedClassNameSetShared,
  resolveServiceTarget as resolveServiceTargetShared,
} from '../shared/service-name-collision.js';

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

/** PascalCase class name with acronym preservation. */
export function className(name: string): string {
  let result = applyAcronymFixes(toPascalCase(stripUrnPrefix(name)));
  if (PYTHON_RESERVED_CLASS_NAMES.has(result)) {
    result += 'Model';
  }
  return result;
}

/** snake_case file name (without extension). */
export function fileName(name: string): string {
  return toSnakeCase(stripUrnPrefix(name));
}

/** snake_case method name. */
export function methodName(name: string): string {
  return toSnakeCase(name);
}

/** snake_case field name. */
export function fieldName(name: string): string {
  return toSnakeCase(name);
}

/**
 * snake_case domain field name for a model field, honoring a `domainName`
 * override (set via the `fieldHints` config) so a wire field can surface under
 * a friendlier name. The wire name (still derived from `field.name`) is
 * unaffected, so the API contract is preserved.
 */
export function domainFieldName(field: { name: string; domainName?: string }): string {
  return toSnakeCase(field.domainName ?? field.name);
}

/**
 * Python builtins that should not be shadowed by parameter names.
 * When a path/query param name collides, suffix with underscore.
 */
const PYTHON_BUILTIN_NAMES = new Set([
  'type',
  'id',
  'list',
  'dict',
  'set',
  'map',
  'filter',
  'input',
  'object',
  'format',
  'hash',
  'range',
  'dir',
  'max',
  'min',
  'next',
  'open',
  'print',
  'len',
  'str',
  'int',
  'float',
  'bool',
  'bytes',
  'tuple',
  'super',
]);

/**
 * Safe parameter name for path/query params that avoids shadowing Python builtins.
 * Body field names should continue to use fieldName() to preserve wire-key compatibility.
 */
export function safeParamName(name: string): string {
  const snake = toSnakeCase(name);
  return PYTHON_BUILTIN_NAMES.has(snake) ? `${snake}_` : snake;
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
 * collision with an exported model/enum class. Feeds `className`/`fileName`
 * so the class declaration, file, and any qualified references stay aligned.
 *
 * Accessor names (`servicePropertyName`) intentionally use the RAW target —
 * `client.organization_membership` reads better than the suffixed form.
 */
export function resolveServiceTarget(target: string, exportedClasses: Set<string>): string {
  return resolveServiceTargetShared(target, exportedClasses, className);
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
  return toPascalCase(stripUrnPrefix(name));
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
