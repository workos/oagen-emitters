import type { EmitterContext, Operation } from '@workos/oagen';
import { toPascalCase, toCamelCase, resolveOperations } from '@workos/oagen';
import { buildResolvedLookup, lookupResolved } from '../shared/resolved-ops.js';
import { stripUrnPrefix, trimMountedResourceFromMethod } from '../shared/naming-utils.js';

/**
 * Swift identifier naming, reserved-word escaping, and operation method-name
 * resolution for the iOS/Swift emitter.
 *
 * IR names are PascalCase; Swift types stay PascalCase (with acronym casing via
 * `toPascalCase`'s built-in ACRONYM_SET), methods/properties are camelCase.
 */

/**
 * Swift keywords that cannot be used as bare identifiers. Used as identifiers,
 * they must be wrapped in back-ticks (e.g. `` `default` ``).
 *
 * Only TRUE reserved keywords are listed. Contextual keywords (`get`, `set`,
 * `final`, `lazy`, `weak`, `mutating`, `override`, `optional`, `required`, …)
 * are legal identifiers and are intentionally omitted — `get` in particular is a
 * common method name (GET-by-id operations). `object` is not a Swift keyword
 * (unlike Kotlin), so it is also absent.
 */
const SWIFT_RESERVED = new Set([
  // Declarations
  'associatedtype',
  'class',
  'deinit',
  'enum',
  'extension',
  'fileprivate',
  'func',
  'import',
  'init',
  'inout',
  'internal',
  'let',
  'open',
  'operator',
  'private',
  'precedencegroup',
  'protocol',
  'public',
  'rethrows',
  'static',
  'struct',
  'subscript',
  'typealias',
  'var',
  // Statements
  'break',
  'case',
  'continue',
  'default',
  'defer',
  'do',
  'else',
  'fallthrough',
  'for',
  'guard',
  'if',
  'in',
  'repeat',
  'return',
  'switch',
  'where',
  'while',
  // Expressions and types
  'Any',
  'as',
  'catch',
  'false',
  'is',
  'nil',
  'self',
  'Self',
  'super',
  'throw',
  'throws',
  'true',
  'try',
]);

/** Wrap an identifier in back-ticks when it collides with a Swift keyword. */
export function escapeReserved(name: string): string {
  return SWIFT_RESERVED.has(name) ? `\`${name}\`` : name;
}

/** PascalCase type name for models, enums, and resources. */
export function typeName(name: string): string {
  return toPascalCase(stripUrnPrefix(name));
}

/** File base name (without extension) for a generated type. */
export function fileName(name: string): string {
  return typeName(name);
}

/** camelCase method name (reserved-word escaped). */
export function methodName(name: string): string {
  return escapeReserved(toCamelCase(name));
}

/** camelCase property / parameter name (reserved-word escaped). */
export function propertyName(name: string): string {
  return escapeReserved(toCamelCase(name));
}

/** camelCase resource accessor property on the client (e.g. `organizations`). */
export function accessorName(mountName: string): string {
  return escapeReserved(toCamelCase(mountName));
}

/** The set of PascalCase type names declared by models and enums. */
export function collectDeclaredTypeNames(ctx: EmitterContext): Set<string> {
  const names = new Set<string>();
  for (const model of ctx.spec.models) names.add(typeName(model.name));
  for (const e of ctx.spec.enums) names.add(typeName(e.name));
  return names;
}

/**
 * Resource struct type name for a mount group. Swift shares one type namespace
 * per module and SwiftPM keys object files by basename, so a resource whose name
 * collides with a model/enum type must be suffixed (`OrganizationMembership` →
 * `OrganizationMembershipResource`) to avoid a duplicate declaration and a
 * duplicate source-file basename.
 */
export function resourceTypeName(mountName: string, ctx: EmitterContext): string {
  const base = typeName(mountName);
  return collectDeclaredTypeNames(ctx).has(base) ? `${base}Resource` : base;
}

/** The Swift module / SPM target name (derived from the namespace). */
export function moduleName(ctx: EmitterContext): string {
  return ctx.namespacePascal;
}

/** The main client class name (e.g. `WorkOSClient`). */
export function clientClassName(ctx: EmitterContext): string {
  return `${ctx.namespacePascal}Client`;
}

/** The base error type name (e.g. `WorkOSError`). */
export function errorTypeName(ctx: EmitterContext): string {
  return `${ctx.namespacePascal}Error`;
}

/** Escape a JS string for embedding as a Swift string literal. */
export function swiftStringLiteral(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

/**
 * Return a context whose `resolvedOperations` is guaranteed populated. When the
 * engine already populated it (`buildEmitterContext`), it is returned as-is;
 * otherwise (unit tests, hint-less specs) it is resolved from the spec so the
 * shared mount-group helpers work uniformly.
 */
export function withResolvedOps(ctx: EmitterContext): EmitterContext {
  if (ctx.resolvedOperations && ctx.resolvedOperations.length > 0) return ctx;
  return { ...ctx, resolvedOperations: resolveOperations(ctx.spec) };
}

// --- method-name resolution -------------------------------------------------

/**
 * Strip the mount-group resource noun when it directly follows the leading verb
 * (family-wide convention, shared with the Go/Kotlin/.NET emitters), so method
 * names match across languages. Canonicalizes the mount to the Swift type name
 * first; untrimmed words keep their original casing (acronyms survive intact).
 */
export function trimMountResource(method: string, mountName: string): string {
  return trimMountedResourceFromMethod(method, typeName(mountName));
}

/**
 * Resolve the Swift method name for an operation within a mount group. Prefers
 * the hint-aware `ResolvedOperation.methodName`, falls back to `op.name`, then
 * trims the mount resource noun and escapes reserved words.
 */
export function resolveMethodName(op: Operation, mountName: string, ctx: EmitterContext): string {
  const lookup = buildResolvedLookup(withResolvedOps(ctx));
  const resolved = lookupResolved(op, lookup);
  const snake = resolved?.methodName ?? op.name;
  const camel = toCamelCase(snake);
  return escapeReserved(trimMountResource(camel, mountName));
}
