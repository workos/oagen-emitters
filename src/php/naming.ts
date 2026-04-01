import type { Operation, Service, EmitterContext } from '@workos/oagen';
import { toPascalCase, toCamelCase, toSnakeCase } from '@workos/oagen';

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
 * Map of lowercase acronym forms to their correct casing.
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
];

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

/** Suffixes stripped from spec model names before generating PHP names. */
const STRIPPED_SUFFIXES = ['Dto', 'DTO'];

let unsafeToStrip = new Set<string>();

/**
 * Initialize collision detection for suffix stripping.
 */
export function initializeNaming(specNames: string[]): void {
  unsafeToStrip = new Set<string>();
  const strippedToOriginals = new Map<string, string[]>();
  for (const name of specNames) {
    let stripped = name;
    for (const suffix of STRIPPED_SUFFIXES) {
      if (name.endsWith(suffix) && name.length > suffix.length) {
        stripped = name.slice(0, -suffix.length);
        break;
      }
    }
    if (!strippedToOriginals.has(stripped)) strippedToOriginals.set(stripped, []);
    strippedToOriginals.get(stripped)!.push(name);
  }
  for (const [, originals] of strippedToOriginals) {
    if (originals.length > 1) {
      for (const name of originals) unsafeToStrip.add(name);
    }
  }
}

function stripSuffixes(name: string): string {
  if (unsafeToStrip.has(name)) return name;
  for (const suffix of STRIPPED_SUFFIXES) {
    if (name.endsWith(suffix) && name.length > suffix.length) {
      return name.slice(0, -suffix.length);
    }
  }
  return name;
}

/** PascalCase class name with acronym preservation. */
export function className(name: string): string {
  let result = toPascalCase(stripSuffixes(name));
  for (const [pattern, replacement] of ACRONYM_FIXES) {
    result = result.replace(pattern, replacement);
  }
  if (PHP_RESERVED_CLASS_NAMES.has(result)) {
    result += 'Model';
  }
  return result;
}

/** PascalCase file name (without extension) — PSR-4 convention. */
export function fileName(name: string): string {
  return className(name);
}

/** camelCase method name. */
export function methodName(name: string): string {
  return toCamelCase(name);
}

/** camelCase field/property name. */
export function fieldName(name: string): string {
  return toCamelCase(name);
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

/** Resolve the SDK method name for an operation, checking overlay first. */
export function resolveMethodName(op: Operation, service: Service, ctx: EmitterContext): string {
  void service;
  const special = SPECIAL_METHOD_NAMES[`${op.httpMethod.toUpperCase()} ${op.path}`];
  if (special) return special;
  const httpKey = `${op.httpMethod.toUpperCase()} ${op.path}`;
  const existing = ctx.overlayLookup?.methodByOperation?.get(httpKey);
  if (existing) {
    return normalizeMethodName(toCamelCase(existing.methodName), op);
  }
  return normalizeMethodName(toCamelCase(op.name), op);
}

const SPECIAL_METHOD_NAMES: Record<string, string> = {
  'POST /portal/generate_link': 'generateLink',
  'POST /audit_logs/exports': 'createExport',
  'GET /audit_logs/exports/{auditLogExportId}': 'getExport',
  'GET /authorization/organizations/{organizationId}/roles': 'listOrganizationRoles',
  'POST /authorization/organizations/{organizationId}/roles': 'createOrganizationRole',
  'GET /authorization/organizations/{organizationId}/roles/{slug}': 'getOrganizationRole',
  'PATCH /authorization/organizations/{organizationId}/roles/{slug}': 'updateOrganizationRole',
  'DELETE /authorization/organizations/{organizationId}/roles/{slug}': 'deleteOrganizationRole',
  'PUT /authorization/organizations/{organizationId}/roles/{slug}/permissions': 'setOrganizationRolePermissions',
  'POST /authorization/organizations/{organizationId}/roles/{slug}/permissions': 'addOrganizationRolePermission',
  'DELETE /authorization/organizations/{organizationId}/roles/{slug}/permissions/{permissionSlug}':
    'removeOrganizationRolePermission',
  'PUT /authorization/roles/{slug}/permissions': 'setEnvironmentRolePermissions',
  'POST /authorization/roles/{slug}/permissions': 'addEnvironmentRolePermission',
};

/** Resolve the SDK class name for a service, checking overlay for existing names. */
export function resolveClassName(service: Service, ctx: EmitterContext): string {
  if (service.name === 'portal') {
    return 'AdminPortal';
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

/** Resolve the type name for a model, checking overlay first. */
export function resolveTypeName(name: string, ctx: EmitterContext): string {
  const existing = ctx.overlayLookup?.interfaceByName?.get(name);
  if (existing) return existing;
  return toPascalCase(name);
}

// ─── Method name normalization ────────────────────────────────────────

function singularize(noun: string): string {
  if (noun.endsWith('ies')) return noun.slice(0, -3) + 'y';
  if (noun.endsWith('ses') || noun.endsWith('xes') || noun.endsWith('zes')) return noun.slice(0, -2);
  if (noun.endsWith('s') && !noun.endsWith('ss')) return noun.slice(0, -1);
  return noun;
}

function extractResourceNoun(op: Operation): string | null {
  const first = op.path.replace(/^\//, '').split('/')[0];
  if (!first) return null;
  return singularize(toCamelCase(first));
}

function normalizeMethodName(name: string, op: Operation): string {
  const method = op.httpMethod.toLowerCase();
  const hasIdParam = op.pathParams.some((p) => p.name === 'id' || p.name.endsWith('Id') || p.name.endsWith('_id'));

  if (name === 'find') return 'get';
  if (name.startsWith('find')) {
    const rest = name.slice(4);
    if (rest.length > 0 && rest[0] === rest[0].toUpperCase()) {
      return `get${rest}`;
    }
  }

  // For single-resource GET by ID, singularize a plural noun after "get"
  if (method === 'get' && hasIdParam && name.startsWith('get') && name.length > 3) {
    const noun = name.slice(3); // remove "get"
    const lower = noun[0].toLowerCase() + noun.slice(1);
    const singular = singularize(lower);
    if (singular !== lower) {
      return `get${singular[0].toUpperCase()}${singular.slice(1)}`;
    }
  }

  // Strip redundant noun suffix that duplicates the resource path segment
  const resourceNoun = extractResourceNoun(op);
  if (resourceNoun) {
    const verbs = ['create', 'update', 'delete', 'get', 'list'];
    for (const verb of verbs) {
      const expected = `${verb}${resourceNoun[0].toUpperCase()}${resourceNoun.slice(1)}`;
      if (name === expected) {
        return verb;
      }
    }
    // Also check the plural form (e.g., listOrganizations → list)
    const rawFirstSegment = op.path.replace(/^\//, '').split('/')[0];
    if (rawFirstSegment) {
      const pluralNoun = toCamelCase(rawFirstSegment);
      for (const verb of ['list']) {
        const expected = `${verb}${pluralNoun[0].toUpperCase()}${pluralNoun.slice(1)}`;
        if (name === expected) {
          return verb;
        }
      }
    }
  }

  return name;
}

// ─── Service grouping ─────────────────────────────────────────────────

/**
 * Group services by shared camelCase prefix for nested namespaces.
 */
export function groupServicesByNamespace(services: Service[], ctx: EmitterContext): NamespaceGrouping {
  const entries = services.map((service) => {
    const resolvedName = resolveClassName(service, ctx);
    return { service, prop: servicePropertyName(resolvedName), resolvedName };
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
