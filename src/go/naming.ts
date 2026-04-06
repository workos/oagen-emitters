import type { Operation, Service, EmitterContext } from '@workos/oagen';
import { toPascalCase, toSnakeCase } from '@workos/oagen';
import { buildResolvedLookup, lookupMethodName, getMountTarget } from '../shared/resolved-ops.js';

/**
 * Acronym map: after PascalCase conversion, fix known acronyms to all-caps Go convention.
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
  [/Api(?=[A-Z]|$)/g, 'API'],
  [/Url(?=[A-Z]|$)/g, 'URL'],
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
  return s.replace(/Id(?=[A-Z]|$)/g, 'ID');
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
  return applyAcronyms(toPascalCase(name));
}

/** snake_case file name (without extension). */
export function fileName(name: string): string {
  return toSnakeCase(name);
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
  return toPascalCase(name);
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
  if (resolved) return methodName(resolved);
  const httpKey = `${op.httpMethod.toUpperCase()} ${op.path}`;
  const existing = ctx.overlayLookup?.methodByOperation?.get(httpKey);
  if (existing) return methodName(existing.methodName);
  return methodName(op.name);
}

/** Resolve the SDK class name for a service using resolved operations' mountOn. */
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

/** Build a map from IR service name to mount-target directory name. */
export function buildMountDirMap(ctx: EmitterContext): Map<string, string> {
  const map = new Map<string, string>();
  for (const service of ctx.spec.services) {
    const target = getMountTarget(service, ctx);
    map.set(service.name, moduleName(target));
  }
  return map;
}
