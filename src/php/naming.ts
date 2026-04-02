import type { Operation, Service, EmitterContext, Enum } from '@workos/oagen';
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
    // Overlay names come from the baseline SDK — use them as-is without normalization
    return toCamelCase(existing.methodName);
  }
  return normalizeMethodName(toCamelCase(op.name), op);
}

const SPECIAL_METHOD_NAMES: Record<string, string> = {
  // Portal
  'POST /portal/generate_link': 'generateLink',
  // Audit logs
  'GET /audit_logs/actions': 'listActions',
  'POST /audit_logs/events': 'createEvent',
  'POST /audit_logs/exports': 'createExport',
  'GET /audit_logs/exports/{auditLogExportId}': 'getExport',
  'POST /audit_logs/actions/{actionName}/schemas': 'createSchema',
  // Organizations
  'GET /organizations': 'listOrganizations',
  'POST /organizations': 'createOrganization',
  'GET /organizations/{id}': 'getOrganization',
  'GET /organizations/external_id/{external_id}': 'getOrganizationByExternalId',
  // SSO
  'GET /sso/authorize': 'getAuthorizationUrl',
  'POST /sso/token': 'getProfileAndToken',
  // User management
  'GET /user_management/users': 'listUsers',
  'POST /user_management/users': 'createUser',
  'GET /user_management/users/{id}': 'getUser',
  'PUT /user_management/users/{id}': 'updateUser',
  'DELETE /user_management/users/{id}': 'deleteUser',
  'GET /user_management/users/external_id/{external_id}': 'getUserByExternalId',
  'POST /user_management/authenticate': 'authenticateWithCode',
  'GET /user_management/invitations': 'listInvitations',
  'POST /user_management/invitations': 'sendInvitation',
  'GET /user_management/invitations/{id}': 'getInvitation',
  'GET /user_management/invitations/by_token/{token}': 'findInvitationByToken',
  'POST /user_management/invitations/{id}/accept': 'acceptInvitation',
  'POST /user_management/invitations/{id}/resend': 'resendInvitation',
  'POST /user_management/invitations/{id}/revoke': 'revokeInvitation',
  'GET /user_management/organization_memberships': 'listOrganizationMemberships',
  'POST /user_management/organization_memberships': 'createOrganizationMembership',
  'GET /user_management/organization_memberships/{id}': 'getOrganizationMembership',
  'PUT /user_management/organization_memberships/{id}': 'updateOrganizationMembership',
  'DELETE /user_management/organization_memberships/{id}': 'deleteOrganizationMembership',
  'PUT /user_management/organization_memberships/{id}/deactivate': 'deactivateOrganizationMembership',
  'PUT /user_management/organization_memberships/{id}/reactivate': 'reactivateOrganizationMembership',
  'POST /user_management/magic_auth/send_code': 'sendMagicAuthCode',
  'GET /user_management/magic_auth/{id}': 'getMagicAuth',
  'POST /user_management/magic_auth': 'createMagicAuth',
  'GET /user_management/email_verification/{id}': 'getEmailVerification',
  'POST /user_management/users/{id}/email_verification/send': 'sendVerificationEmail',
  'POST /user_management/users/{id}/email_verification/confirm': 'verifyEmail',
  'POST /user_management/password_reset': 'createPasswordReset',
  'GET /user_management/password_reset/{id}': 'getPasswordReset',
  'POST /user_management/password_reset/confirm': 'resetPassword',
  'POST /user_management/users/{id}/password/reset': 'sendPasswordResetEmail',
  'POST /user_management/users/{id}/auth_factors': 'enrollAuthFactor',
  'GET /user_management/users/{id}/auth_factors': 'listAuthFactors',
  'GET /user_management/sessions': 'listSessions',
  'POST /user_management/sessions/{id}/revoke': 'revokeSession',
  // Widgets
  'POST /widgets/token': 'getToken',
  // Connections (from baseline SSO class)
  'GET /connections': 'listConnections',
  'GET /connections/{id}': 'getConnection',
  'DELETE /connections/{id}': 'deleteConnection',
  // Directories (from baseline DirectorySync class)
  'GET /directories': 'listDirectories',
  'GET /directories/{id}': 'getDirectory',
  'DELETE /directories/{id}': 'deleteDirectory',
  'GET /directory_groups': 'listGroups',
  'GET /directory_groups/{id}': 'getGroup',
  'GET /directory_users': 'listUsers',
  'GET /directory_users/{id}': 'getUser',
  // Authorization / RBAC
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
  'GET /authorization/roles': 'listEnvironmentRoles',
  'POST /authorization/roles': 'createEnvironmentRole',
  'GET /authorization/roles/{slug}': 'getEnvironmentRole',
  'PATCH /authorization/roles/{slug}': 'updateEnvironmentRole',
  'GET /authorization/permissions': 'listPermissions',
  'POST /authorization/permissions': 'createPermission',
  'GET /authorization/permissions/{slug}': 'getPermission',
  'PUT /authorization/permissions/{slug}': 'updatePermission',
  'DELETE /authorization/permissions/{slug}': 'deletePermission',
  // MFA
  'POST /auth/factors/enroll': 'enrollFactor',
  'POST /auth/factors/{authenticationFactorId}/challenge': 'challengeFactor',
  'POST /auth/challenge/{authenticationChallengeId}/verify': 'verifyChallenge',
  'GET /auth/factors/{authenticationFactorId}': 'getFactor',
  'DELETE /auth/factors/{authenticationFactorId}': 'deleteFactor',
  // Organization feature flags
  'GET /organizations/{organization_id}/feature-flags': 'listOrganizationFeatureFlags',
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

function normalizeMethodName(name: string, _op: Operation): string {
  // For PHP backward compatibility, preserve the full method name including
  // the resource noun (e.g., keep "listOrganizations" instead of stripping to "list").
  // This ensures the generated SDK matches the naming conventions of the existing SDK.
  if (name === 'find') return 'get';
  if (name.startsWith('find')) {
    const rest = name.slice(4);
    if (rest.length > 0 && rest[0] === rest[0].toUpperCase()) {
      return `get${rest}`;
    }
  }

  return name;
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
