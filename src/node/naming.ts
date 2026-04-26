import type { Operation, Service, EmitterContext } from '@workos/oagen';
import { toPascalCase, toCamelCase, toKebabCase, toSnakeCase } from '@workos/oagen';
import { buildResolvedLookup, lookupMethodName } from '../shared/resolved-ops.js';
import { stripUrnPrefix } from '../shared/naming-utils.js';

/** Strip spec-noise suffixes (e.g., "Dto") from an IR name. */
export function stripNoiseSuffixes(name: string): string {
  return name.replace(/Dto$/i, '');
}

/** PascalCase class/interface name. */
export function className(name: string): string {
  return toPascalCase(stripUrnPrefix(name));
}

/** kebab-case file name (without extension). */
export function fileName(name: string): string {
  return toKebabCase(stripUrnPrefix(name));
}

/** camelCase method name. */
export function methodName(name: string): string {
  return toCamelCase(name);
}

/** camelCase field name for domain interfaces. */
export function fieldName(name: string): string {
  return toCamelCase(name);
}

/** snake_case field name for wire/response interfaces. */
export function wireFieldName(name: string): string {
  return toSnakeCase(name);
}

/**
 * Wire/response interface name. Uses "Wire" suffix when the domain name
 * already ends in "Response" to avoid stuttering (e.g., FooResponseResponse).
 */
export function wireInterfaceName(domainName: string): string {
  return domainName.endsWith('Response') ? `${domainName}Wire` : `${domainName}Response`;
}

/** kebab-case service directory name. */
export function serviceDirName(name: string): string {
  return toKebabCase(name);
}

/** camelCase property name for service accessors on the client. */
export function servicePropertyName(name: string): string {
  return toCamelCase(name);
}

/**
 * Resolve the effective service name, using the overlay-resolved class name
 * when available.
 */
export function resolveServiceName(service: Service, ctx: EmitterContext): string {
  return resolveClassName(service, ctx);
}

/**
 * Build a map from IR service name -> resolved service name.
 */
export function buildServiceNameMap(services: Service[], ctx: EmitterContext): Map<string, string> {
  const map = new Map<string, string>();
  for (const service of services) {
    map.set(service.name, resolveServiceName(service, ctx));
  }
  return map;
}

/** Resolve the output directory for a service. */
export function resolveServiceDir(resolvedServiceName: string): string {
  return serviceDirName(resolvedServiceName);
}

/** Resolve the SDK method name for an operation, using resolved operations first. */
export function resolveMethodName(op: Operation, _service: Service, ctx: EmitterContext): string {
  const lookup = buildResolvedLookup(ctx);
  const resolved = lookupMethodName(op, lookup);
  if (resolved) return toCamelCase(resolved);
  const httpKey = `${op.httpMethod.toUpperCase()} ${op.path}`;
  const existing = ctx.overlayLookup?.methodByOperation?.get(httpKey);
  if (existing) return existing.methodName;
  return toCamelCase(op.name);
}

/** Resolve the SDK class name for a service, using resolved ops mountOn as canonical. */
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

/**
 * Resolve the interface name for a model, checking overlay first.
 */
export function resolveInterfaceName(name: string, ctx: EmitterContext, opts?: { skipTypeAlias?: boolean }): string {
  const existing = ctx.overlayLookup?.interfaceByName?.get(name);
  if (existing) return existing;

  if (!opts?.skipTypeAlias && ctx.apiSurface?.typeAliases) {
    const alias = ctx.apiSurface.typeAliases[name] as { value?: string } | undefined;
    if (alias?.value && ctx.apiSurface.interfaces?.[alias.value]) {
      return alias.value;
    }
  }

  const cleaned = ctx.apiSurface ? name : stripNoiseSuffixes(name);
  return toPascalCase(stripUrnPrefix(cleaned));
}
