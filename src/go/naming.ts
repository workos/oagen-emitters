import type { Operation, Service, EmitterContext } from '@workos/oagen';
import { toPascalCase, toSnakeCase } from '@workos/oagen';
import { buildResolvedLookup, lookupMethodName, getMountTarget } from '../shared/resolved-ops.js';
import { stripUrnPrefix } from '../shared/naming-utils.js';

/**
 * Acronym map: after PascalCase conversion, fix known acronyms to all-caps Go convention.
 */
const ACRONYM_FIXES: [RegExp, string][] = [
  [/Workos/g, 'WorkOS'],
  [/Sso/g, 'SSO'],
  [/Mfa/g, 'MFA'],
  [/Jwks(?=[A-Z]|$)/g, 'JWKS'],
  [/Jwt/g, 'JWT'],
  [/Totp(?=[A-Z]|$)/g, 'TOTP'],
  [/Cors/g, 'CORS'],
  [/Saml/g, 'SAML'],
  [/Scim/g, 'SCIM'],
  [/Rbac/g, 'RBAC'],
  [/Oauth/g, 'OAuth'],
  [/Oidc/g, 'OIDC'],
  [/Api(?=[A-Z]|$)/g, 'API'],
  [/Urls(?=[A-Z]|$)/g, 'URLs'],
  [/Url(?=[A-Z]|$)/g, 'URL'],
  [/Uris(?=[A-Z]|$)/g, 'URIs'],
  [/Uri(?=[A-Z]|$)/g, 'URI'],
  [/Http(?=[A-Z]|$)/g, 'HTTP'],
  [/Uuid(?=[A-Z]|$)/g, 'UUID'],
  [/Json(?=[A-Z]|$)/g, 'JSON'],
  [/Html(?=[A-Z]|$)/g, 'HTML'],
  [/Ip(?=[A-Z]|$)/g, 'IP'],
  [/Pkce/g, 'PKCE'],
];

/**
 * Fix trailing "Id" to "ID" in Go convention.
 * Must be applied after PascalCase and other acronym fixes.
 */
function fixTrailingId(s: string): string {
  // Fix "Ids" → "IDs" first (plural), then "Id" → "ID" (singular)
  let result = s.replace(/Ids(?=[A-Z]|$)/g, 'IDs');
  result = result.replace(/Id(?=[A-Z]|$)/g, 'ID');
  return result;
}

/** Apply all Go acronym conventions to a PascalCase string. */
function applyAcronyms(s: string): string {
  let result = s;
  for (const [pattern, replacement] of ACRONYM_FIXES) {
    result = result.replace(pattern, replacement);
  }
  result = fixTrailingId(result);
  return result;
}

/** PascalCase type/struct name with Go acronym conventions. */
export function className(name: string): string {
  return applyAcronyms(toPascalCase(stripUrnPrefix(name)));
}

/** snake_case file name (without extension). */
export function fileName(name: string): string {
  return toSnakeCase(stripUrnPrefix(name));
}

/** PascalCase exported method name with Go acronym conventions. */
export function methodName(name: string): string {
  return applyAcronyms(toPascalCase(name));
}

/** PascalCase exported field name with Go acronym conventions. */
export function fieldName(name: string): string {
  return applyAcronyms(toPascalCase(name));
}

/** snake_case module/directory name. */
export function moduleName(name: string): string {
  return toSnakeCase(name);
}

/** snake_case property name for service accessors on the client. */
export function servicePropertyName(name: string): string {
  return unexportedName(className(name));
}

/** Lower-camel identifier with Go acronym conventions preserved. */
export function unexportedName(name: string): string {
  const exported = className(name);
  if (!exported) return exported;

  const initialism = exported.match(/^[A-Z]+(?=[A-Z][a-z]|[0-9]|$)/)?.[0];
  if (initialism) {
    return initialism.toLowerCase() + exported.slice(initialism.length);
  }

  return exported.charAt(0).toLowerCase() + exported.slice(1);
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

/** Resolve the SDK method name for an operation, using resolved operations first. */
export function resolveMethodName(op: Operation, _service: Service, ctx: EmitterContext): string {
  const lookup = buildResolvedLookup(ctx);
  const resolved = lookupMethodName(op, lookup);
  if (resolved) return trimMountedResourceFromMethod(methodName(resolved), resolveClassName(_service, ctx));
  const httpKey = `${op.httpMethod.toUpperCase()} ${op.path}`;
  const existing = ctx.overlayLookup?.methodByOperation?.get(httpKey);
  if (existing) return trimMountedResourceFromMethod(methodName(existing.methodName), resolveClassName(_service, ctx));
  return trimMountedResourceFromMethod(methodName(op.name), resolveClassName(_service, ctx));
}

/** Resolve the SDK class name for a service using resolved operations' mountOn. */
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
