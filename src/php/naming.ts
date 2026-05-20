import type { Service, Operation, EmitterContext, Enum } from '@workos/oagen';
import { toPascalCase, toCamelCase, toSnakeCase } from '@workos/oagen';
import { buildResolvedLookup, lookupMethodName } from '../shared/resolved-ops.js';
import { stripUrnPrefix, applyAcronymFixes } from '../shared/naming-utils.js';
import {
  buildExportedClassNameSet as buildExportedClassNameSetShared,
  resolveServiceTarget as resolveServiceTargetShared,
} from '../shared/service-name-collision.js';

/** Namespace grouping result (shared with client.ts). */
export interface NamespaceGroup {
  prefix: string;
  entries: { service: Service; subProp: string; resolvedName: string }[];
  baseEntry?: { service: Service; resolvedName: string };
}

/** Grouping result returned by groupServicesByNamespace. */
export interface NamespaceGrouping {
  standalone: { service: Service; prop: string; resolvedName: string }[];
  namespaces: NamespaceGroup[];
}

/**
 * PHP reserved class names that would collide with builtins.
 */
const PHP_RESERVED_CLASS_NAMES = new Set([
  'Array',
  'List',
  'Callable',
  'Iterable',
  'Mixed',
  'Never',
  'Null',
  'Object',
  'Self',
  'Static',
  'Void',
  'True',
  'False',
  'Int',
  'Float',
  'String',
  'Bool',
]);

// ─── Enum deduplication ───────────────────────────────────────────────

let enumAliasMap = new Map<string, string>();

/**
 * Initialize enum deduplication by hashing sorted enum case values.
 * Enums with identical value sets are aliased to the one with the shortest PHP class name.
 */
export function initializeEnumDedup(enums: Enum[]): void {
  enumAliasMap = new Map();
  const groups = new Map<string, Enum[]>();

  for (const e of enums) {
    const hash = [...e.values]
      .sort((a, b) => String(a.value).localeCompare(String(b.value)))
      .map((v) => String(v.value))
      .join('\0');
    if (!groups.has(hash)) groups.set(hash, []);
    groups.get(hash)!.push(e);
  }

  for (const [, group] of groups) {
    if (group.length <= 1) continue;
    // Pick shortest PHP class name as canonical
    const sorted = [...group].sort((a, b) => className(a.name).length - className(b.name).length);
    const canonical = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      enumAliasMap.set(sorted[i].name, canonical.name);
    }
  }
}

/** Resolve an enum name to its canonical (deduplicated) name. */
export function resolveEnumName(name: string): string {
  return enumAliasMap.get(name) ?? name;
}

/** PHP class name for an enum, with dedup resolution + PascalCase + acronym preservation. */
export function enumClassName(name: string): string {
  return className(resolveEnumName(name));
}

/** PascalCase class name with acronym preservation. */
export function className(name: string): string {
  let result = applyAcronymFixes(toPascalCase(stripUrnPrefix(name)));
  if (PHP_RESERVED_CLASS_NAMES.has(result)) {
    result += 'Model';
  }
  return result;
}

/**
 * Build the set of model + enum class names exported by the SDK. Used to
 * detect collisions with operation-client class names — a colliding service
 * gets a `Service` suffix appended.
 */
export function buildExportedClassNameSet(ctx: EmitterContext): Set<string> {
  return buildExportedClassNameSetShared(ctx, className);
}

/**
 * Resolve a service's mount-target identifier, appending `Service` on
 * collision with an exported model/enum class. Used in `\Service\…` files
 * to avoid `use WorkOS\Resource\X; class X` PHP fatal errors.
 */
export function resolveServiceTarget(target: string, exportedClasses: Set<string>): string {
  return resolveServiceTargetShared(target, exportedClasses, className);
}

/** PascalCase file name (without extension) — PSR-4 convention. */
export function fileName(name: string): string {
  return className(name);
}

/** camelCase method name. */
export function methodName(name: string): string {
  return toCamelCase(name);
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

/** camelCase field/property name. */
export function fieldName(name: string): string {
  return toCamelCase(name);
}

/** snake_case name for fixtures and other snake_case contexts. */
export function snakeName(name: string): string {
  return toSnakeCase(stripUrnPrefix(name));
}

/** snake_case wire name (preserves the original API field name). */
export function wireName(name: string): string {
  return toSnakeCase(name);
}

/** camelCase property name for service accessors on the client. */
export function servicePropertyName(name: string): string {
  return toCamelCase(name);
}

/** Resolve the effective service name, using the overlay-resolved class name. */
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

/** Resolve the SDK class name for a service, using resolved operations' mountOn. */
export function resolveClassName(service: Service, ctx: EmitterContext): string {
  // Use resolved ops mountOn as canonical class name
  for (const r of ctx.resolvedOperations ?? []) {
    if (r.service.name === service.name) return r.mountOn;
  }
  // Fallback to overlay, then IR name
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

// ─── Service grouping ─────────────────────────────────────────────────

/**
 * Group services by shared camelCase prefix for nested namespaces.
 */
export function groupServicesByNamespace(services: Service[], ctx: EmitterContext): NamespaceGrouping {
  // Build entries, deduplicating props — when the overlay causes two services to
  // resolve to the same accessor name (e.g., OrganizationDomains → Organizations),
  // fall back to the IR name for the duplicate to keep both reachable.
  const usedProps = new Set<string>();
  const entries = services.map((service) => {
    const resolvedName = resolveClassName(service, ctx);
    let prop = servicePropertyName(resolvedName);
    if (usedProps.has(prop)) {
      // Collision — fall back to the raw IR service name
      prop = servicePropertyName(toPascalCase(service.name));
    }
    usedProps.add(prop);
    return { service, prop, resolvedName };
  });

  const allProps = new Set(entries.map((e) => e.prop));
  const VIRTUAL_NAMESPACES = new Set(['userManagement']);

  // Count how many property names contain each possible camelCase prefix
  // For PHP we use the snake_case version for prefix detection then convert back
  const snakeEntries = entries.map((e) => ({ ...e, snakeProp: toSnakeCase(e.prop) }));
  const prefixCount = new Map<string, number>();
  for (const entry of snakeEntries) {
    prefixCount.set(entry.snakeProp, (prefixCount.get(entry.snakeProp) || 0) + 1);
    const parts = entry.snakeProp.split('_');
    for (let len = 1; len < parts.length; len++) {
      const prefix = parts.slice(0, len).join('_');
      prefixCount.set(prefix, (prefixCount.get(prefix) || 0) + 1);
    }
  }

  const entryPrefix = new Map<string, string>();
  for (const entry of snakeEntries) {
    const parts = entry.snakeProp.split('_');
    for (let len = parts.length - 1; len >= 1; len--) {
      const prefix = parts.slice(0, len).join('_');
      const camelPrefix = toCamelCase(prefix);
      if (
        (prefixCount.get(prefix) ?? 0) >= 2 &&
        prefix !== entry.snakeProp &&
        (allProps.has(camelPrefix) || VIRTUAL_NAMESPACES.has(camelPrefix))
      ) {
        entryPrefix.set(entry.prop, camelPrefix);
        break;
      }
    }
  }

  const namespacesMap = new Map<string, NamespaceGroup['entries']>();
  const standalone: typeof entries = [];

  for (const entry of entries) {
    const prefix = entryPrefix.get(entry.prop);
    if (prefix) {
      if (!namespacesMap.has(prefix)) namespacesMap.set(prefix, []);
      // Compute sub-property: remove prefix from the camelCase name
      const snakePrefix = toSnakeCase(prefix);
      const snakeProp = toSnakeCase(entry.prop);
      const subSnake = snakeProp.slice(snakePrefix.length + 1);
      const subProp = toCamelCase(subSnake);
      namespacesMap.get(prefix)!.push({ service: entry.service, subProp, resolvedName: entry.resolvedName });
    } else {
      standalone.push(entry);
    }
  }

  const namespacePrefixes = new Set(namespacesMap.keys());
  const colliding = new Map<string, (typeof entries)[0]>();
  const filteredStandalone = standalone.filter((entry) => {
    if (namespacePrefixes.has(entry.prop)) {
      colliding.set(entry.prop, entry);
      return false;
    }
    return true;
  });

  const namespaces: NamespaceGroup[] = [...namespacesMap].map(([prefix, nsEntries]) => ({
    prefix,
    entries: nsEntries,
    baseEntry: colliding.get(prefix)
      ? { service: colliding.get(prefix)!.service, resolvedName: colliding.get(prefix)!.resolvedName }
      : undefined,
  }));
  return { standalone: filteredStandalone, namespaces };
}

/** Build a map from IR service name to the resolved directory name. */
export function buildServiceDirMap(grouping: NamespaceGrouping): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of grouping.standalone) {
    map.set(entry.service.name, toPascalCase(entry.resolvedName));
  }
  for (const ns of grouping.namespaces) {
    if (ns.baseEntry) {
      map.set(ns.baseEntry.service.name, toPascalCase(ns.prefix));
    }
    for (const entry of ns.entries) {
      map.set(entry.service.name, `${toPascalCase(ns.prefix)}/${toPascalCase(entry.subProp)}`);
    }
  }
  return map;
}
