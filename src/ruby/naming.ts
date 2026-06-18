import type { Operation, Service, EmitterContext } from '@workos/oagen';
import { toPascalCase, toSnakeCase } from '@workos/oagen';
import { buildResolvedLookup, lookupMethodName, getMountTarget } from '../shared/resolved-ops.js';
import { stripUrnPrefix, applyAcronymFixes } from '../shared/naming-utils.js';
import {
  buildExportedClassNameSet as buildExportedClassNameSetShared,
  resolveServiceTarget as resolveServiceTargetShared,
} from '../shared/service-name-collision.js';

/**
 * Ruby class names that collide with core classes. When a model name resolves
 * to one of these, suffix with "Model".
 */
const RUBY_RESERVED_CLASS_NAMES = new Set([
  'Array',
  'Hash',
  'String',
  'Integer',
  'Float',
  'Object',
  'Module',
  'Class',
  'Comparable',
  'Enumerable',
  'Range',
  'Proc',
  'Method',
  'Regexp',
  'Symbol',
  'File',
  'Dir',
  'IO',
  'Data',
]);

/** PascalCase class name with acronym preservation. */
export function className(name: string): string {
  let result = applyAcronymFixes(toPascalCase(stripUrnPrefix(name)));
  if (RUBY_RESERVED_CLASS_NAMES.has(result)) {
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
 * a friendlier name. The wire key (still derived from `field.name`) is what
 * gets sent/received over the wire — only the domain attr/accessor name changes.
 */
export function domainFieldName(field: { name: string; domainName?: string }): string {
  return toSnakeCase(field.domainName ?? field.name);
}

/**
 * Ruby reserved words that cannot be used as parameter names.
 * When a path/query param name collides, suffix with underscore.
 */
const RUBY_RESERVED_WORDS = new Set([
  'BEGIN',
  'END',
  'alias',
  'and',
  'begin',
  'break',
  'case',
  'class',
  'def',
  'defined?',
  'do',
  'else',
  'elsif',
  'end',
  'ensure',
  'false',
  'for',
  'if',
  'in',
  'module',
  'next',
  'nil',
  'not',
  'or',
  'redo',
  'rescue',
  'retry',
  'return',
  'self',
  'super',
  'then',
  'true',
  'undef',
  'unless',
  'until',
  'when',
  'while',
  'yield',
  // Common methods on Object/Kernel that shouldn't be shadowed
  'hash',
  'send',
  'class',
  'method',
  'tap',
]);

/**
 * Safe parameter name for path/query params that avoids shadowing Ruby reserved words.
 */
export function safeParamName(name: string): string {
  const snake = toSnakeCase(name);
  return RUBY_RESERVED_WORDS.has(snake) ? `${snake}_` : snake;
}

/** snake_case module/directory name. */
export function moduleName(name: string): string {
  return toSnakeCase(name);
}

/**
 * Build the set of model + enum Ruby class names that the SDK exposes under
 * `WorkOS::`. Used to detect collisions with operation-client class names —
 * a colliding service gets a `Service` suffix (`OrganizationMembershipService`)
 * so it doesn't shadow the model class under Zeitwerk's collapsed namespace.
 */
export function buildExportedClassNameSet(ctx: EmitterContext): Set<string> {
  return buildExportedClassNameSetShared(ctx, className);
}

/**
 * Resolve a service's mount-target identifier, appending `Service` on
 * collision with an exported model/enum class name. The returned PascalCase
 * value feeds `className`/`fileName` to derive matching class + file names
 * (e.g. `OrganizationMembershipService` / `organization_membership_service`).
 *
 * Accessor names (`servicePropertyName`) intentionally use the RAW target —
 * `client.organization_membership` is more readable than the suffixed form.
 *
 * The directory used by `loader.collapse` (the model home) likewise uses the
 * raw target.
 */
export function resolveServiceTarget(target: string, exportedClasses: Set<string>): string {
  return resolveServiceTargetShared(target, exportedClasses, className);
}

/**
 * PascalCase class name for a parameter-group variant. Mirrors the Python
 * convention: group "password" + variant "plaintext" → `PasswordPlaintext`.
 * Used as the Ruby constant under the WorkOS module.
 */
export function groupVariantClassName(groupName: string, variantName: string): string {
  return className(`${groupName}_${variantName}`);
}

/** snake_case Zeitwerk-compatible filename for a parameter-group variant. */
export function groupVariantFileName(groupName: string, variantName: string): string {
  return fileName(`${groupName}_${variantName}`);
}

/**
 * Fully-qualified Ruby constant for a parameter-group variant scoped under
 * its owning resource module — e.g. "WorkOS::UserManagement::PasswordPlaintext".
 * Mirrors Python's `workos.user_management.PasswordPlaintext` namespacing.
 */
export function scopedGroupVariantClassName(mountTarget: string, groupName: string, variantName: string): string {
  return `WorkOS::${className(mountTarget)}::${groupVariantClassName(groupName, variantName)}`;
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

/** Resolve the SDK method name for an operation, using resolved operations first. */
export function resolveMethodName(op: Operation, _service: Service, ctx: EmitterContext): string {
  const lookup = buildResolvedLookup(ctx);
  const resolved = lookupMethodName(op, lookup);
  if (resolved) return resolved;
  const httpKey = `${op.httpMethod.toUpperCase()} ${op.path}`;
  const existing = ctx.overlayLookup?.methodByOperation?.get(httpKey);
  if (existing) return toSnakeCase(existing.methodName);
  return toSnakeCase(op.name);
}

/** Resolve the SDK class name for a service, using resolved operations' mountOn. */
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

/** Resolve the type name for a model, checking overlay first. */
export function resolveTypeName(name: string, ctx: EmitterContext): string {
  const existing = ctx.overlayLookup?.interfaceByName?.get(name);
  if (existing) return existing;
  return toPascalCase(stripUrnPrefix(name));
}

/**
 * Build a map from IR service name to mount-target directory name.
 */
export function buildMountDirMap(ctx: EmitterContext): Map<string, string> {
  const map = new Map<string, string>();
  for (const service of ctx.spec.services) {
    const target = getMountTarget(service, ctx);
    map.set(service.name, moduleName(target));
  }
  return map;
}
