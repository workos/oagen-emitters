import type { EmitterContext, Operation } from '@workos/oagen';
import { toPascalCase, toCamelCase, resolveOperations } from '@workos/oagen';
import { buildResolvedLookup, lookupResolved } from '../shared/resolved-ops.js';

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

/** Strip a leading `urn:...:` prefix that some spec names carry. */
function stripUrnPrefix(name: string): string {
  const idx = name.lastIndexOf(':');
  return idx >= 0 ? name.slice(idx + 1) : name;
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

/** Split a camelCase / PascalCase / snake_case string into lower-cased words. */
function splitWords(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** Naive singularizer sufficient for matching resource nouns. */
function singularizeWord(w: string): string {
  const lw = w.toLowerCase();
  if (lw.endsWith('ies')) return lw.slice(0, -3) + 'y';
  if (lw.endsWith('ses') || lw.endsWith('shes') || lw.endsWith('ches') || lw.endsWith('xes')) {
    return lw.slice(0, -2);
  }
  if (lw.endsWith('s') && !lw.endsWith('ss')) return lw.slice(0, -1);
  return lw;
}

/** Recombine lower-cased words into camelCase. */
function joinCamel(words: string[]): string {
  return words.map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1))).join('');
}

/**
 * Strip trailing method words that duplicate the mount-group resource noun, so
 * `listOrganizations` on the `Organizations` resource becomes `list`. Never
 * trims below a single word. Matches the cross-language emitter convention.
 */
export function trimMountResource(method: string, mountName: string): string {
  const words = splitWords(method);
  if (words.length <= 1) return method;
  const mountNouns = new Set(splitWords(mountName).map(singularizeWord));
  while (words.length > 1) {
    const last = singularizeWord(words[words.length - 1]);
    if (mountNouns.has(last)) {
      words.pop();
    } else {
      break;
    }
  }
  return joinCamel(words);
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
