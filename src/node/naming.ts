import type { Operation, Service, EmitterContext } from '@workos/oagen';
import { toPascalCase, toCamelCase, toKebabCase, toSnakeCase } from '@workos/oagen';

/** PascalCase class/interface name. */
export function className(name: string): string {
  return toPascalCase(name);
}

/** kebab-case file name (without extension). */
export function fileName(name: string): string {
  return toKebabCase(name);
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
 * when available. This ensures directory names, file names, and property names
 * all derive from the same resolved name (e.g., "Mfa" instead of "MultiFactorAuth").
 */
export function resolveServiceName(service: Service, ctx: EmitterContext): string {
  return resolveClassName(service, ctx);
}

/**
 * Build a map from IR service name → resolved service name.
 * Used to translate modelToService/enumToService map values to overlay-resolved
 * directory names when the code only has the IR service name string.
 */
export function buildServiceNameMap(services: Service[], ctx: EmitterContext): Map<string, string> {
  const map = new Map<string, string>();
  for (const service of services) {
    map.set(service.name, resolveServiceName(service, ctx));
  }
  return map;
}

/** Resolve the SDK method name for an operation, checking overlay first. */
export function resolveMethodName(op: Operation, _service: Service, ctx: EmitterContext): string {
  const httpKey = `${op.httpMethod.toUpperCase()} ${op.path}`;
  const existing = ctx.overlayLookup?.methodByOperation?.get(httpKey);
  if (existing) return existing.methodName;
  return toCamelCase(op.name);
}

/** Resolve the SDK class name for a service, checking overlay for existing names. */
export function resolveClassName(service: Service, ctx: EmitterContext): string {
  // Check overlay's methodByOperation for any operation in this service
  // to find the existing class name
  if (ctx.overlayLookup?.methodByOperation) {
    for (const op of service.operations) {
      const httpKey = `${op.httpMethod.toUpperCase()} ${op.path}`;
      const existing = ctx.overlayLookup.methodByOperation.get(httpKey);
      if (existing) return existing.className;
    }
  }
  return toPascalCase(service.name);
}

/** Resolve the interface name for a model, checking overlay first. */
export function resolveInterfaceName(name: string, ctx: EmitterContext): string {
  const existing = ctx.overlayLookup?.interfaceByName?.get(name);
  if (existing) return existing;
  return toPascalCase(name);
}
