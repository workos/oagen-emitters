import type { OagenConfig, OperationHint } from '@workos/oagen';
import { toCamelCase } from '@workos/oagen';
import { nodeEmitter } from './src/node/index.js';
import { pythonEmitter } from './src/python/index.js';
import { phpEmitter } from './src/php/index.js';
import { goEmitter } from './src/go/index.js';
import { dotnetEmitter } from './src/dotnet/index.js';
import { kotlinEmitter } from './src/kotlin/index.js';
import { nodeExtractor } from './src/compat/extractors/node.js';
import { rubyExtractor } from './src/compat/extractors/ruby.js';
import { pythonExtractor } from './src/compat/extractors/python.js';
import { phpExtractor } from './src/compat/extractors/php.js';
import { goExtractor } from './src/compat/extractors/go.js';
import { rustExtractor } from './src/compat/extractors/rust.js';
import { kotlinExtractor } from './src/compat/extractors/kotlin.js';
import { dotnetExtractor } from './src/compat/extractors/dotnet.js';
import { elixirExtractor } from './src/compat/extractors/elixir.js';

/**
 * NestJS-style operationId transform. Strips "Controller" and extracts the
 * action after the first underscore: `FooController_bar` → `bar`.
 */
function nestjsOperationIdTransform(id: string): string {
  const stripped = id.replace(/Controller/g, '');
  const idx = stripped.indexOf('_');
  return idx !== -1 ? toCamelCase(stripped.slice(idx + 1)) : toCamelCase(stripped);
}

// ---------------------------------------------------------------------------
// Operation hints — per-operation overrides for the operation resolver.
// Keyed by "METHOD /path". Only operations that need overrides are listed;
// the algorithm handles the rest.
// ---------------------------------------------------------------------------
const operationHints: Record<string, OperationHint> = {
  // ── Radar ────────────────────────────────────────────────────────────────
  'POST /radar/lists/{type}/{action}': { name: 'add_list_entry' },
  'DELETE /radar/lists/{type}/{action}': { name: 'remove_list_entry' },

  // ── SSO ──────────────────────────────────────────────────────────────────
  'GET /sso/authorize': {
    name: 'get_authorization_url',
    defaults: { response_type: 'code' },
    inferFromClient: ['client_id'],
  },
  'GET /sso/logout': { name: 'get_logout_url' },
  'GET /sso/profile': { name: 'get_profile' },
  'POST /sso/token': {
    name: 'get_profile_and_token',
    defaults: { grant_type: 'authorization_code' },
    inferFromClient: ['client_id', 'client_secret'],
  },

  // ── SSO / JWKS (mounted on UserManagement via mountRules) ────────────────
  'GET /sso/jwks/{clientId}': { name: 'get_jwks' },

  // ── User Management — auth ──────────────────────────────────────────────
  'GET /user_management/authorize': {
    name: 'get_authorization_url',
    defaults: { response_type: 'code' },
    inferFromClient: ['client_id'],
  },
  'GET /user_management/sessions/logout': { name: 'get_logout_url' },

  // ── User Management — org membership actions ────────────────────────────
  'PUT /user_management/organization_memberships/{id}/deactivate': {
    name: 'deactivate_organization_membership',
  },
  'PUT /user_management/organization_memberships/{id}/reactivate': {
    name: 'reactivate_organization_membership',
  },

  // ── Admin Portal ────────────────────────────────────────────────────────
  'POST /portal/generate_link': { name: 'generate_link' },

  // ── Feature Flags — disambiguate co-mounted list operations ─────────────
  'GET /organizations/{organizationId}/feature-flags': { name: 'list_organization_feature_flags' },
  'GET /user_management/users/{userId}/feature-flags': { name: 'list_user_feature_flags' },

  // ── External ID lookups (not derivable from path) ──────────────────────
  'GET /organizations/external_id/{external_id}': { name: 'get_organization_by_external_id' },
  'GET /user_management/users/external_id/{external_id}': { name: 'get_user_by_external_id' },

  // ── Authorization — environment-scoped roles ─────────────────────────────
  'GET /authorization/roles': { name: 'list_environment_roles' },
  'POST /authorization/roles': { name: 'create_environment_role' },
  'GET /authorization/roles/{slug}': { name: 'get_environment_role' },
  'PATCH /authorization/roles/{slug}': { name: 'update_environment_role' },
  'PUT /authorization/roles/{slug}/permissions': {
    name: 'set_environment_role_permissions',
  },
  'POST /authorization/roles/{slug}/permissions': {
    name: 'add_environment_role_permission',
  },

  // ── Authorization — singularized/shortened names ────────────────────────
  'POST /authorization/permissions': { name: 'create_permission' },
  'POST /authorization/resources': { name: 'create_resource' },
  'POST /authorization/organization_memberships/{organization_membership_id}/check': {
    name: 'check',
  },
  'POST /authorization/organization_memberships/{organization_membership_id}/role_assignments': {
    name: 'assign_role',
  },
  'DELETE /authorization/organization_memberships/{organization_membership_id}/role_assignments': {
    name: 'remove_role',
  },
  'POST /authorization/organizations/{organizationId}/roles': {
    name: 'create_organization_role',
  },

  // ── Authorization — env-scoped resource memberships ────────────────────
  'GET /authorization/resources/{resource_id}/organization_memberships': { name: 'list_memberships_for_resource' },

  // ── User Management — singularized/shortened names ─────────────────────
  'POST /user_management/users': { name: 'create_user' },
  'POST /user_management/organization_memberships': {
    name: 'create_organization_membership',
  },
  'POST /user_management/invitations': { name: 'send_invitation' },
  'GET /user_management/invitations/by_token/{token}': {
    name: 'find_invitation_by_token',
  },
  'POST /user_management/users/{id}/email_verification/send': {
    name: 'send_verification_email',
  },
  'POST /user_management/users/{id}/email_verification/confirm': {
    name: 'verify_email',
  },
  'POST /user_management/password_reset': { name: 'reset_password' },
  'POST /user_management/password_reset/confirm': {
    name: 'confirm_password_reset',
  },
  'GET /user_management/users/{id}/sessions': { name: 'list_sessions' },
  'GET /user_management/users/{id}/identities': { name: 'get_user_identities' },
  'POST /user_management/cors_origins': { name: 'create_cors_origin' },
  'POST /user_management/redirect_uris': { name: 'create_redirect_uri' },

  // ── Organizations — singularized names ─────────────────────────────────
  'POST /organizations': { name: 'create_organization' },

  // ── Directory Sync — shortened names ───────────────────────────────────
  'GET /directory_groups': { name: 'list_groups' },
  'GET /directory_groups/{id}': { name: 'get_group' },
  'GET /directory_users': { name: 'list_users' },
  'GET /directory_users/{id}': { name: 'get_user' },

  // ── Audit Logs — singularized names ────────────────────────────────────
  'POST /audit_logs/events': { name: 'create_event' },
  'POST /audit_logs/exports': { name: 'create_export' },
  'POST /audit_logs/actions/{actionName}/schemas': { name: 'create_schema' },

  // ── Feature Flags — match SDK conventions ──────────────────────────────
  'POST /feature-flags/{slug}/targets/{resourceId}': { name: 'add_flag_target' },
  'DELETE /feature-flags/{slug}/targets/{resourceId}': {
    name: 'remove_flag_target',
  },

  // ── Organizations — audit log config (singular fetch, not a list) ───────
  'GET /organizations/{id}/audit_log_configuration': {
    name: 'get_audit_log_configuration',
  },

  // ── Organizations — audit logs retention (mounted on AuditLogs) ─────────
  'GET /organizations/{id}/audit_logs_retention': {
    name: 'get_organization_audit_logs_retention',
    mountOn: 'AuditLogs',
  },
  'PUT /organizations/{id}/audit_logs_retention': { mountOn: 'AuditLogs' },

  // ── Union split: POST /user_management/authenticate (8 variants) ────────
  // Common optional fields appended to every variant's exposedParams so the
  // generated wrappers cover the full spec body shape (fraud/audit context the
  // server consumes when present).
  'POST /user_management/authenticate': {
    split: [
      {
        name: 'authenticate_with_password',
        targetVariant: 'PasswordSessionAuthenticateRequest',
        defaults: { grant_type: 'password' },
        inferFromClient: ['client_id', 'client_secret'],
        exposedParams: ['email', 'password', 'invitation_token', 'ip_address', 'device_id', 'user_agent'],
        optionalParams: ['invitation_token', 'ip_address', 'device_id', 'user_agent'],
      },
      {
        name: 'authenticate_with_code',
        targetVariant: 'CodeSessionAuthenticateRequest',
        defaults: { grant_type: 'authorization_code' },
        inferFromClient: ['client_id', 'client_secret'],
        exposedParams: ['code', 'ip_address', 'device_id', 'user_agent'],
        optionalParams: ['ip_address', 'device_id', 'user_agent'],
      },
      {
        name: 'authenticate_with_refresh_token',
        targetVariant: 'RefreshTokenSessionAuthenticateRequest',
        defaults: { grant_type: 'refresh_token' },
        inferFromClient: ['client_id', 'client_secret'],
        exposedParams: ['refresh_token', 'organization_id', 'ip_address', 'device_id', 'user_agent'],
        optionalParams: ['organization_id', 'ip_address', 'device_id', 'user_agent'],
      },
      {
        name: 'authenticate_with_magic_auth',
        targetVariant: 'MagicAuthSessionAuthenticateRequest',
        defaults: { grant_type: 'urn:workos:oauth:grant-type:magic-auth:code' },
        inferFromClient: ['client_id', 'client_secret'],
        exposedParams: ['code', 'email', 'invitation_token', 'ip_address', 'device_id', 'user_agent'],
        optionalParams: ['invitation_token', 'ip_address', 'device_id', 'user_agent'],
      },
      {
        name: 'authenticate_with_email_verification',
        targetVariant: 'EmailVerificationSessionAuthenticateRequest',
        defaults: { grant_type: 'urn:workos:oauth:grant-type:email-verification:code' },
        inferFromClient: ['client_id', 'client_secret'],
        exposedParams: ['code', 'pending_authentication_token', 'ip_address', 'device_id', 'user_agent'],
        optionalParams: ['pending_authentication_token', 'ip_address', 'device_id', 'user_agent'],
      },
      {
        name: 'authenticate_with_totp',
        targetVariant: 'TotpSessionAuthenticateRequest',
        defaults: { grant_type: 'urn:workos:oauth:grant-type:mfa-totp' },
        inferFromClient: ['client_id', 'client_secret'],
        exposedParams: [
          'code',
          'pending_authentication_token',
          'authentication_challenge_id',
          'ip_address',
          'device_id',
          'user_agent',
        ],
        optionalParams: ['ip_address', 'device_id', 'user_agent'],
      },
      {
        name: 'authenticate_with_organization_selection',
        targetVariant: 'OrganizationSelectionSessionAuthenticateRequest',
        defaults: { grant_type: 'urn:workos:oauth:grant-type:organization-selection' },
        inferFromClient: ['client_id', 'client_secret'],
        exposedParams: ['pending_authentication_token', 'organization_id', 'ip_address', 'device_id', 'user_agent'],
        optionalParams: ['ip_address', 'device_id', 'user_agent'],
      },
      {
        name: 'authenticate_with_device_code',
        targetVariant: 'DeviceCodeSessionAuthenticateRequest',
        defaults: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code' },
        inferFromClient: ['client_id'],
        exposedParams: ['device_code', 'ip_address', 'device_id', 'user_agent'],
        optionalParams: ['ip_address', 'device_id', 'user_agent'],
      },
    ],
  },

  // ── Union split: POST /connect/applications (2 variants) ────────────────
  'POST /connect/applications': {
    split: [
      {
        name: 'create_oauth_application',
        targetVariant: 'CreateOAuthApplication',
        defaults: { application_type: 'oauth' },
        exposedParams: [
          'name',
          'is_first_party',
          'description',
          'scopes',
          'redirect_uris',
          'uses_pkce',
          'organization_id',
        ],
      },
      {
        name: 'create_m2m_application',
        targetVariant: 'CreateM2MApplication',
        defaults: { application_type: 'm2m' },
        exposedParams: ['name', 'organization_id', 'description', 'scopes'],
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Mount rules — service-level remounting. Maps IR service name → target
// service/namespace (PascalCase). All operations in the source service are
// mounted on the target unless overridden per-operation in operationHints.
// ---------------------------------------------------------------------------
const mountRules: Record<string, string> = {
  // MFA sub-services → MultiFactorAuth
  MultiFactorAuthChallenges: 'MultiFactorAuth',

  // RBAC permissions → Authorization
  Permissions: 'Authorization',

  // Connect sub-services → Connect
  WorkosConnect: 'Connect',
  Applications: 'Connect',
  ApplicationClientSecrets: 'Connect',

  // SSO connections → SSO
  Connections: 'SSO',

  // Directory Sync sub-services → DirectorySync
  Directories: 'DirectorySync',
  DirectoryGroups: 'DirectorySync',
  DirectoryUsers: 'DirectorySync',

  // Feature flag sub-services → FeatureFlags
  FeatureFlagsTargets: 'FeatureFlags',
  OrganizationsFeatureFlags: 'FeatureFlags',
  UserManagementUsersFeatureFlags: 'FeatureFlags',

  // Org API keys → ApiKeys
  OrganizationsApiKeys: 'ApiKeys',

  // User Management sub-services → UserManagement
  UserManagementSessionTokens: 'UserManagement',
  UserManagementAuthentication: 'UserManagement',
  UserManagementCorsOrigins: 'UserManagement',
  UserManagementUsers: 'UserManagement',
  UserManagementInvitations: 'UserManagement',
  UserManagementJWTTemplate: 'UserManagement',
  UserManagementMagicAuth: 'UserManagement',
  UserManagementOrganizationMembership: 'UserManagement',
  UserManagementRedirectUris: 'UserManagement',
  UserManagementUsersAuthorizedApplications: 'UserManagement',

  // Pipes / Data Providers → Pipes
  UserManagementDataProviders: 'Pipes',

  // User Management MFA → MultiFactorAuth
  UserManagementMultiFactorAuthentication: 'MultiFactorAuth',
};

const config: OagenConfig = {
  emitters: [nodeEmitter, pythonEmitter, phpEmitter, goEmitter, dotnetEmitter, kotlinEmitter],
  extractors: [
    nodeExtractor,
    rubyExtractor,
    pythonExtractor,
    phpExtractor,
    goExtractor,
    rustExtractor,
    kotlinExtractor,
    dotnetExtractor,
    elixirExtractor,
  ],
  smokeRunners: {
    node: './smoke/sdk-node.ts',
    ruby: './smoke/sdk-ruby.ts',
    python: './smoke/sdk-python.ts',
    php: './smoke/sdk-php.ts',
    go: './smoke/sdk-go.ts',
    rust: './smoke/sdk-rust.ts',
    elixir: './smoke/sdk-elixir.ts',
    kotlin: './smoke/sdk-kotlin.ts',
    dotnet: './smoke/sdk-dotnet.ts',
  },
  docUrl: 'https://workos.com/docs',
  operationIdTransform: nestjsOperationIdTransform,
  schemaNameTransform: (name: string) => {
    // Explicit renames for Dto models that collide with response models
    const COLLISION_RENAMES: Record<string, string> = {
      OrganizationDto: 'OrganizationInput',
      RedirectUriDto: 'RedirectUriInput',
      // Generic list-derived names that need domain-specific identifiers
      ListData: 'Role',
      ListModel: 'RoleList',
      // Double-List naming artifact
      EventListListMetadata: 'EventListMetadata',
    };
    if (COLLISION_RENAMES[name]) return COLLISION_RENAMES[name];
    return name
      .replace(/Dto/g, '')
      .replace(/DTO/g, '')
      .replace(/^Urn(?:IetfParams|Workos)O[Aa]uthGrantType/, '');
  },
  operationHints,
  mountRules,
};
export default config;
