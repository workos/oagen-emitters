import type { Operation, Service, EmitterContext } from '@workos/oagen';
import { toPascalCase, toCamelCase, toSnakeCase } from '@workos/oagen';
import { buildResolvedLookup, lookupMethodName, getMountTarget } from '../shared/resolved-ops.js';
import { stripUrnPrefix } from '../shared/naming-utils.js';

/** PascalCase class/type name. */
export function className(name: string): string {
  return toPascalCase(stripUrnPrefix(name));
}

/** PascalCase file name (matches the primary class). */
export function fileName(name: string): string {
  return toPascalCase(stripUrnPrefix(name));
}

/** snake_case file name for fixtures/test data. */
export function fixtureFileName(name: string): string {
  return toSnakeCase(stripUrnPrefix(name));
}

/** camelCase method name. */
export function methodName(name: string): string {
  return toCamelCase(name);
}

/** camelCase Kotlin property / local variable name. */
export function propertyName(name: string): string {
  const camel = toCamelCase(name);
  // `object` is a Kotlin reserved word. Instead of backtick-escaping it
  // (forcing callers to write `event.\`object\``), rename to `objectType`
  // and rely on @JsonProperty("object") for wire mapping.
  if (camel === 'object') return 'objectType';
  return escapeReserved(camel);
}

/** camelCase alias (kept for parity with other emitters). */
export const fieldName = propertyName;
export const localName = propertyName;

/** PascalCase directory segment for a service / mount group. */
export function moduleName(name: string): string {
  return toPascalCase(name);
}

/** Lower-case Kotlin package segment for a service / mount group. */
export function packageSegment(name: string): string {
  // Kotlin package convention: all-lowercase, no separators.
  return toPascalCase(name).toLowerCase();
}

/** Kotlin service class name for a mount group (e.g., `Organizations`). */
export function apiClassName(name: string): string {
  return className(name);
}

/** Accessor property exposed on the WorkOS client (camelCase). */
export function servicePropertyName(name: string): string {
  return toCamelCase(name);
}

/** Resolve the effective service (mount target) name. */
export function resolveServiceName(service: Service, ctx: EmitterContext): string {
  return resolveClassName(service, ctx);
}

/** Build a map from IR service name -> resolved mount-target name (PascalCase). */
export function buildServiceNameMap(services: Service[], ctx: EmitterContext): Map<string, string> {
  const map = new Map<string, string>();
  for (const service of services) {
    map.set(service.name, resolveServiceName(service, ctx));
  }
  return map;
}

/** Resolve the SDK method name (camelCase) for an operation. */
export function resolveMethodName(op: Operation, service: Service, ctx: EmitterContext): string {
  const lookup = buildResolvedLookup(ctx);
  const resolved = lookupMethodName(op, lookup);
  if (resolved) {
    return trimMountedResourceFromMethod(methodName(resolved), resolveClassName(service, ctx));
  }
  const httpKey = `${op.httpMethod.toUpperCase()} ${op.path}`;
  const existing = ctx.overlayLookup?.methodByOperation?.get(httpKey);
  if (existing) {
    return trimMountedResourceFromMethod(methodName(existing.methodName), resolveClassName(service, ctx));
  }
  return trimMountedResourceFromMethod(methodName(op.name), resolveClassName(service, ctx));
}

/** Resolve the SDK class name (PascalCase) for a service. */
export function resolveClassName(service: Service, ctx: EmitterContext): string {
  for (const r of ctx.resolvedOperations ?? []) {
    if (r.service.name === service.name) return className(r.mountOn);
  }
  if (ctx.overlayLookup?.methodByOperation) {
    for (const op of service.operations) {
      const httpKey = `${op.httpMethod.toUpperCase()} ${op.path}`;
      const existing = ctx.overlayLookup.methodByOperation.get(httpKey);
      if (existing) return className(existing.className);
    }
  }
  return className(service.name);
}

/** Build a map from IR service name -> mount-target directory (PascalCase). */
export function buildMountDirMap(ctx: EmitterContext): Map<string, string> {
  const map = new Map<string, string>();
  for (const service of ctx.spec.services) {
    const target = getMountTarget(service, ctx);
    map.set(service.name, moduleName(target));
  }
  return map;
}

function splitPascalWords(name: string): string[] {
  return name.match(/[A-Z]+(?:[a-z]+|(?=[A-Z]|$))|[A-Z]?[a-z]+|[0-9]+/g) ?? [name];
}

function singularize(word: string): string {
  if (word.endsWith('ies') && word.length > 3) {
    return `${word.slice(0, -3)}y`;
  }
  if (word.endsWith('s') && !word.endsWith('ss')) {
    return word.slice(0, -1);
  }
  return word;
}

function wordsMatch(left: string, right: string): boolean {
  return singularize(left.toLowerCase()) === singularize(right.toLowerCase());
}

/**
 * Trim the mount-target resource words from the start of a method name.
 * E.g. `listOrganizations` on OrganizationsApi becomes `list`.
 */
function trimMountedResourceFromMethod(method: string, mountName: string): string {
  const methodWords = splitPascalWords(method);
  if (methodWords.length < 2) return method;

  const mountWords = splitPascalWords(className(mountName));
  if (mountWords.length === 0) return method;

  let matched = 0;
  while (
    matched < mountWords.length &&
    matched + 1 < methodWords.length &&
    wordsMatch(methodWords[matched + 1], mountWords[matched])
  ) {
    matched++;
  }

  if (matched === 0) return method;

  return [methodWords[0], ...methodWords.slice(matched + 1)].join('');
}

/** Kotlin hard/soft keywords that must be back-ticked when used as identifiers. */
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

/** Escape a Kotlin identifier if it collides with a reserved word. */
export function escapeReserved(name: string): string {
  return KOTLIN_RESERVED.has(name) ? `\`${name}\`` : name;
}

/** Escape a string literal for Kotlin source. */
export function ktStringLiteral(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
}

/** Escape any scalar as a Kotlin literal expression. */
export function ktLiteral(value: string | number | boolean): string {
  if (typeof value === 'string') return ktStringLiteral(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/**
 * Map a wire field name to the expression that reads it off a WorkOS client
 * instance (used for inferFromClient fields).
 */
export function clientFieldExpression(field: string): string {
  switch (field) {
    case 'client_id':
      return 'clientId';
    case 'client_secret':
      return 'apiKey';
    default:
      return propertyName(field);
  }
}

/** Convert snake_case / camelCase to a human-readable lowercase phrase for docs. */
export function humanize(name: string): string {
  return name
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase();
}
