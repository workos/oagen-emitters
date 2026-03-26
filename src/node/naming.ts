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

/**
 * Explicit method name overrides for operations where the spec's operationId
 * does not match the desired SDK method name and the spec cannot be changed.
 * Key: "HTTP_METHOD /path", Value: camelCase method name.
 */
const METHOD_NAME_OVERRIDES: Record<string, string> = {
  'POST /portal/generate_link': 'generatePortalLink',
};

/**
 * Explicit service directory overrides. Maps a resolved PascalCase service name
 * to a target directory (kebab-case). Use this when the spec's tag grouping
 * does not match the desired SDK directory layout and the spec cannot be changed.
 */
const SERVICE_DIR_OVERRIDES: Record<string, string> = {
  ApplicationClientSecrets: 'workos-connect',
  Applications: 'workos-connect',
  Connections: 'sso',
  Directories: 'directory-sync',
  DirectoryGroups: 'directory-sync',
  DirectoryUsers: 'directory-sync',
  FeatureFlagsTargets: 'feature-flags',
  MultiFactorAuth: 'mfa',
  MultiFactorAuthChallenges: 'mfa',
  OrganizationsApiKeys: 'organizations',
  WebhooksEndpoints: 'webhooks',
  UserManagementAuthentication: 'user-management',
  UserManagementCorsOrigins: 'user-management',
  UserManagementDataProviders: 'user-management',
  UserManagementInvitations: 'user-management',
  UserManagementJWTTemplate: 'user-management',
  UserManagementMagicAuth: 'user-management',
  UserManagementMultiFactorAuthentication: 'user-management',
  UserManagementOrganizationMembership: 'user-management',
  UserManagementRedirectUris: 'user-management',
  UserManagementSessionTokens: 'user-management',
  UserManagementUsers: 'user-management',
  UserManagementUsersAuthorizedApplications: 'user-management',
  WorkOSConnect: 'workos-connect',
};

/**
 * Maps a service (by PascalCase name) to the existing hand-written class that
 * already covers its endpoints. When a service appears here:
 *   - `resolveClassName` returns the target class (so generated code merges in)
 *   - `isServiceCoveredByExisting` returns true
 *   - `hasMethodsAbsentFromBaseline` checks the target class for missing methods,
 *     so new endpoints are added to the existing class rather than silently dropped
 */
export const SERVICE_COVERED_BY: Record<string, string> = {
  Connections: 'SSO',
  Directories: 'DirectorySync',
  DirectoryGroups: 'DirectorySync',
  DirectoryUsers: 'DirectorySync',
  FeatureFlagsTargets: 'FeatureFlags',
  MultiFactorAuth: 'Mfa',
  MultiFactorAuthChallenges: 'Mfa',
  OrganizationsApiKeys: 'Organizations',
  UserManagementAuthentication: 'UserManagement',
  UserManagementInvitations: 'UserManagement',
  UserManagementMagicAuth: 'UserManagement',
  UserManagementMultiFactorAuthentication: 'UserManagement',
  UserManagementOrganizationMembership: 'UserManagement',
  UserManagementUsers: 'UserManagement',
};

/**
 * Explicit class name overrides. Maps the default PascalCase service name
 * to the desired SDK class name when toPascalCase produces the wrong casing.
 */
const CLASS_NAME_OVERRIDES: Record<string, string> = {
  WorkosConnect: 'WorkOSConnect',
};

/**
 * Resolve the output directory for a service, checking overrides first.
 * Falls back to the standard kebab-case conversion.
 */
export function resolveServiceDir(resolvedServiceName: string): string {
  return SERVICE_DIR_OVERRIDES[resolvedServiceName] ?? serviceDirName(resolvedServiceName);
}

/** Resolve the SDK method name for an operation, checking overlay first. */
export function resolveMethodName(op: Operation, _service: Service, ctx: EmitterContext): string {
  const httpKey = `${op.httpMethod.toUpperCase()} ${op.path}`;
  const override = METHOD_NAME_OVERRIDES[httpKey];
  if (override) return override;
  const existing = ctx.overlayLookup?.methodByOperation?.get(httpKey);
  if (existing) {
    // Fix: when the path ends with a path parameter (single-resource operation)
    // and the overlay method name is plural, prefer the singular form.
    // E.g., getUsers → getUser when path is /user_management/users/{id}
    const isSingleResource = /\/\{[^}]+\}$/.test(op.path);
    if (isSingleResource && existing.methodName.endsWith('s') && !existing.methodName.endsWith('ss')) {
      const singular = existing.methodName.slice(0, -1);
      // Only singularize if it looks like a typical pluralization (ends in 's')
      // and the spec-derived name agrees it should be singular
      const specDerived = toCamelCase(op.name);
      if (specDerived === singular || specDerived.endsWith(singular.slice(singular.length - 4))) {
        return singular;
      }
    }
    return existing.methodName;
  }
  return toCamelCase(op.name);
}

/** Resolve the SDK class name for a service, checking overlay for existing names. */
export function resolveClassName(service: Service, ctx: EmitterContext): string {
  // Explicit coverage: this service's endpoints belong to an existing class
  const coveredBy = SERVICE_COVERED_BY[toPascalCase(service.name)];
  if (coveredBy) return coveredBy;

  // Check overlay's methodByOperation for any operation in this service
  // to find the existing class name
  if (ctx.overlayLookup?.methodByOperation) {
    for (const op of service.operations) {
      const httpKey = `${op.httpMethod.toUpperCase()} ${op.path}`;
      const existing = ctx.overlayLookup.methodByOperation.get(httpKey);
      if (existing) return CLASS_NAME_OVERRIDES[existing.className] ?? existing.className;
    }
  }
  const defaultName = toPascalCase(service.name);
  return CLASS_NAME_OVERRIDES[defaultName] ?? defaultName;
}

/** Resolve the interface name for a model, checking overlay first. */
export function resolveInterfaceName(name: string, ctx: EmitterContext): string {
  const existing = ctx.overlayLookup?.interfaceByName?.get(name);
  if (existing) return existing;
  return toPascalCase(name);
}
