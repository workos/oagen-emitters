import type { Operation, Service, EmitterContext } from '@workos/oagen';
import { toPascalCase, toSnakeCase } from '@workos/oagen';
import { buildResolvedLookup, lookupMethodName, getMountTarget } from '../shared/resolved-ops.js';
import { stripUrnPrefix } from '../shared/naming-utils.js';

/** PascalCase class/type name. */
export function className(name: string): string {
  return toPascalCase(stripUrnPrefix(name));
}

/** PascalCase file name (without extension). */
export function fileName(name: string): string {
  return toPascalCase(stripUrnPrefix(name));
}

/** snake_case file name for fixtures/test data. */
export function fixtureFileName(name: string): string {
  return toSnakeCase(stripUrnPrefix(name));
}

/** PascalCase method name. */
export function methodName(name: string): string {
  return toPascalCase(name);
}

/** PascalCase property name. */
export function fieldName(name: string): string {
  return toPascalCase(name);
}

/** PascalCase directory name for service modules. */
export function moduleName(name: string): string {
  return toPascalCase(name);
}

/** PascalCase property name for service accessors on the client. */
export function servicePropertyName(name: string): string {
  return className(name);
}

/** Resolve the effective service name using resolved operations. */
export function resolveServiceName(service: Service, ctx: EmitterContext): string {
  return resolveClassName(service, ctx);
}

/** Build a map from IR service name to resolved service name. */
export function buildServiceNameMap(services: Service[], ctx: EmitterContext): Map<string, string> {
  const map = new Map<string, string>();
  for (const service of services) {
    map.set(service.name, resolveServiceName(service, ctx));
  }
  return map;
}

/** Resolve the output directory for a service. */
export function resolveServiceDir(resolvedServiceName: string): string {
  return moduleName(resolvedServiceName);
}

/** Resolve the SDK method name for an operation. */
export function resolveMethodName(op: Operation, _service: Service, ctx: EmitterContext): string {
  const lookup = buildResolvedLookup(ctx);
  const resolved = lookupMethodName(op, lookup);
  if (resolved) return trimMountedResourceFromMethod(methodName(resolved), resolveClassName(_service, ctx));
  const httpKey = `${op.httpMethod.toUpperCase()} ${op.path}`;
  const existing = ctx.overlayLookup?.methodByOperation?.get(httpKey);
  if (existing) return trimMountedResourceFromMethod(methodName(existing.methodName), resolveClassName(_service, ctx));
  return trimMountedResourceFromMethod(methodName(op.name), resolveClassName(_service, ctx));
}

/** Resolve the SDK class name for a service. */
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

/** Build a map from IR service name to mount-target directory name. */
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

/** Service type name for the class declaration. */
export function serviceTypeName(name: string): string {
  // Preserve pluralization for C# service names (OrganizationsService, not OrganizationService)
  return `${className(name)}Service`;
}

/** camelCase for local variables. */
export function localName(name: string): string {
  const pascal = toPascalCase(name);
  if (!pascal) return pascal;
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/** Escape a value as a C# literal. */
export function csLiteral(value: string | number | boolean): string {
  if (typeof value === 'string') return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/** Map a wire field name to the WorkOSClient property expression. */
export function clientFieldExpression(field: string): string {
  switch (field) {
    case 'client_id':
      return 'ClientId';
    case 'client_secret':
      return 'ApiKey';
    default:
      return fieldName(field);
  }
}

/** Convert an HTTP method string to the C# HttpMethod static property name. */
export function httpMethodCs(method: string): string {
  const m = method.toLowerCase();
  switch (m) {
    case 'get':
      return 'Get';
    case 'post':
      return 'Post';
    case 'put':
      return 'Put';
    case 'patch':
      return 'Patch';
    case 'delete':
      return 'Delete';
    case 'head':
      return 'Head';
    case 'options':
      return 'Options';
    default:
      return 'Get';
  }
}

/**
 * Return the name of the Service base-class helper that handles the given
 * HTTP method (e.g., `GetAsync`, `PostAsync`). Used by the resource emitter
 * to produce one-line service methods instead of inlined WorkOSRequest blocks.
 */
export function httpMethodHelperName(method: string): string {
  const m = method.toLowerCase();
  switch (m) {
    case 'get':
      return 'GetAsync';
    case 'post':
      return 'PostAsync';
    case 'put':
      return 'PutAsync';
    case 'patch':
      return 'PatchAsync';
    case 'delete':
      return 'DeleteAsync';
    default:
      return 'GetAsync';
  }
}

/** Escape XML special characters for use in XML doc comments. */
export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Distill a deprecation message from a spec description. Looks for common
 * WorkOS patterns ("Deprecated. Use X.", "Use X instead.", etc.) and falls
 * back to a generic message scoped to the item kind.
 *
 * Output is suitable for inlining into `[System.Obsolete("...")]`.
 */
export function deprecationMessage(
  description: string | undefined | null,
  kind: 'field' | 'parameter' | 'operation' | 'value',
): string {
  const generic = `This ${kind} is deprecated.`;
  if (!description) return generic;

  const text = description.replace(/\s+/g, ' ').trim();
  if (!text) return generic;

  // Match: "Deprecated. Use `foo` instead." / "Deprecated: use Foo."
  const deprecatedClause = text.match(/Deprecated[.:][\s]*(.*?)(?:\.|$)/i);
  if (deprecatedClause?.[1]?.trim()) {
    return `Deprecated. ${deprecatedClause[1].trim().replace(/\.$/, '')}.`;
  }

  // Match: "Use `foo` instead." anywhere in the description
  const useInstead = text.match(/Use\s+`?([^`.\s]+)`?\s+instead/i);
  if (useInstead) {
    return `${generic.replace(/\.$/, '')} Use \`${useInstead[1]}\` instead.`;
  }

  return generic;
}

/**
 * Escape a C# string literal for use inside `[System.Obsolete("...")]`.
 * Doubles embedded quotes and escapes backslashes.
 */
export function escapeCsAttributeString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Emit an XML doc summary block from a possibly multi-line spec description.
 * The first non-empty line becomes the `<summary>`. If there are additional
 * non-empty lines, they are emitted as `<remarks>...</remarks>` so users get
 * the full context in tooling (IntelliSense / `dotnet help`) instead of just
 * the first sentence.
 *
 * Returns an empty array if `description` is null/empty so callers can spread
 * the result unconditionally.
 */
export function emitXmlDoc(description: string | undefined | null, indent: string): string[] {
  if (!description) return [];
  const lines = description
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l);
  if (lines.length === 0) return [];

  const out: string[] = [];
  out.push(`${indent}/// <summary>${escapeXml(lines[0])}</summary>`);
  if (lines.length > 1) {
    out.push(`${indent}/// <remarks>`);
    for (const remark of lines.slice(1)) {
      out.push(`${indent}/// ${escapeXml(remark)}`);
    }
    out.push(`${indent}/// </remarks>`);
  }
  return out;
}

/** Convert a snake_case or camelCase name to a human-readable lowercase string. */
export function humanize(name: string): string {
  return name
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase();
}
