import type { EmitterContext, Operation } from '@workos/oagen';
import { toPascalCase, toCamelCase, resolveOperations } from '@workos/oagen';
import { buildResolvedLookup, lookupResolved } from '../shared/resolved-ops.js';
import { stripUrnPrefix, trimMountedResourceFromMethod } from '../shared/naming-utils.js';

/**
 * Kotlin identifier naming, reserved-word escaping, package resolution, and
 * operation method-name resolution for the Android/Kotlin emitter.
 *
 * IR names are PascalCase; Kotlin types stay PascalCase (with acronym casing via
 * `toPascalCase`'s built-in ACRONYM_SET), methods/properties are camelCase.
 */

/** Source-set roots for an Android library module. */
export const SRC_MAIN = 'src/main/kotlin';
export const SRC_TEST = 'src/test/kotlin';

/**
 * Kotlin HARD keywords, which are never legal as bare identifiers and must be
 * back-tick escaped.
 *
 * Soft/modifier keywords (`get`, `set`, `data`, `value`, `open`, `sealed`,
 * `internal`, `public`, `expect`, `actual`, `where`, `by`, `field`, …) are legal
 * identifiers and are intentionally omitted — `get` and `value` in particular are
 * common method and field names.
 *
 * Unlike Swift, `object` IS reserved in Kotlin, and it is a frequent wire field
 * name in this API ("object": "organization"), so escaping matters more here.
 */
const KOTLIN_RESERVED = new Set([
  'as',
  'break',
  'class',
  'continue',
  'do',
  'else',
  'false',
  'for',
  'fun',
  'if',
  'in',
  'interface',
  'is',
  'null',
  'object',
  'package',
  'return',
  'super',
  'this',
  'throw',
  'true',
  'try',
  'typealias',
  'typeof',
  'val',
  'var',
  'when',
  'while',
]);

/** Wrap an identifier in back-ticks when it collides with a Kotlin hard keyword. */
export function escapeReserved(name: string): string {
  return KOTLIN_RESERVED.has(name) ? `\`${name}\`` : name;
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

// --- packages ---------------------------------------------------------------

/**
 * The root package for the generated SDK. Defaults to `com.{namespace}.android`
 * (the convention Stripe's Android SDK uses), which also keeps the Android
 * artifact from colliding with the server-side Kotlin SDK's `com.{namespace}`
 * classes if both ever land on one classpath. Overridable via
 * `emitterOptions.packagePrefix`.
 */
export function basePackage(ctx: EmitterContext): string {
  const configured = ctx.emitterOptions?.packagePrefix;
  if (typeof configured === 'string' && configured.length > 0) return configured;
  // A package segment must be a single lower-case alphanumeric token. `ctx.namespace`
  // arrives snake_cased (`--namespace WorkOS` → `work_os`), so separators are
  // stripped rather than preserved: `com.workos.android`, not `com.work_os.android`.
  const segment = (ctx.namespace || 'api').replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'api';
  return `com.${segment}.android`;
}

/** A sub-package of the SDK root (e.g. `models` → `com.workos.android.models`). */
export function subPackage(ctx: EmitterContext, segment: string): string {
  return segment ? `${basePackage(ctx)}.${segment}` : basePackage(ctx);
}

/** Directory path form of a package (`com.workos.android` → `com/workos/android`). */
export function packageDir(pkg: string): string {
  return pkg.split('.').join('/');
}

/** Full source path for a generated main-source-set file. */
export function mainSourcePath(ctx: EmitterContext, segment: string, base: string): string {
  return `${SRC_MAIN}/${packageDir(subPackage(ctx, segment))}/${base}.kt`;
}

/** Full source path for a generated test-source-set file. */
export function testSourcePath(ctx: EmitterContext, segment: string, base: string): string {
  return `${SRC_TEST}/${packageDir(subPackage(ctx, segment))}/${base}.kt`;
}

// --- well-known type names --------------------------------------------------

/**
 * The namespace in Kotlin type-name form.
 *
 * `namespacePascal` is passed through verbatim from `--namespace`, and callers
 * only supply the cased form (`WorkOS`) for languages whose namespace doubles as
 * a type/module name. Kotlin class names must start with an upper-case letter, so
 * a lower-case namespace is capitalized here rather than emitting an
 * unconventional `workosClient`. Acronym casing beyond the first character cannot
 * be recovered from a lower-case namespace (`workos` → `Workos`, not `WorkOS`), so
 * pass `--namespace WorkOS` to get exact casing.
 */
export function namespaceType(ctx: EmitterContext): string {
  const raw = ctx.namespacePascal || ctx.namespace;
  if (!raw) return 'Api';
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/** The main client class name (e.g. `WorkOSClient`). */
export function clientClassName(ctx: EmitterContext): string {
  return `${namespaceType(ctx)}Client`;
}

/** The base exception type name (e.g. `WorkOSException`). */
export function exceptionTypeName(ctx: EmitterContext): string {
  return `${namespaceType(ctx)}Exception`;
}

// --- literals ---------------------------------------------------------------

/**
 * Escape a string for embedding as a Kotlin string literal.
 *
 * `$` MUST be escaped: Kotlin interpolates `$name` and `${expr}` inside string
 * literals, so an unescaped `$` in spec-derived text (a description, an enum wire
 * value) would become live code in the generated source.
 */
export function ktStringLiteral(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/\$/g, '\\$')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

/**
 * Escape a literal fragment for embedding inside a Kotlin **template** string
 * (one containing `${...}` interpolations, as the generated path expressions do).
 *
 * `$` MUST be escaped or the fragment would start an interpolation of its own.
 * Distinct from {@link ktStringLiteral}, which wraps and escapes a whole value;
 * this escapes a fragment that is being concatenated into a larger literal.
 */
export function ktTemplatePart(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\$/g, '\\$').replace(/"/g, '\\"');
}

/** Escape any scalar as a Kotlin literal expression. */
export function ktLiteral(value: string | number | boolean): string {
  if (typeof value === 'string') return ktStringLiteral(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

// --- resolved operations ----------------------------------------------------

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

/** The set of PascalCase type names declared by models and enums. */
export function collectDeclaredTypeNames(ctx: EmitterContext): Set<string> {
  const names = new Set<string>();
  for (const model of ctx.spec.models) names.add(typeName(model.name));
  for (const e of ctx.spec.enums) names.add(typeName(e.name));
  return names;
}

/**
 * Resource class name for a mount group. A resource whose name collides with a
 * model or enum type gets a `Resource` suffix — Kotlin would technically allow
 * the duplicate across packages, but the resulting imports are ambiguous to read
 * and easy to mis-import. Mirrors the iOS emitter's rule so type names agree.
 */
export function resourceTypeName(mountName: string, ctx: EmitterContext): string {
  const base = typeName(mountName);
  return collectDeclaredTypeNames(ctx).has(base) ? `${base}Resource` : base;
}

/**
 * Strip the mount-group resource noun when it directly follows the leading verb
 * (family-wide convention, shared with the Go/Kotlin/iOS/.NET emitters), so
 * method names match across languages.
 */
export function trimMountResource(method: string, mountName: string): string {
  return trimMountedResourceFromMethod(method, typeName(mountName));
}

/**
 * Resolve the Kotlin method name for an operation within a mount group. Prefers
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
