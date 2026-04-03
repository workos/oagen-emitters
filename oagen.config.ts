import type { OagenConfig, OperationHint } from '@workos/oagen';
import { toCamelCase } from '@workos/oagen';
import { nodeEmitter } from './src/node/index.js';
import { pythonEmitter } from './src/python/index.js';
import { phpEmitter } from './src/php/index.js';
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
  'GET /sso/authorize': { name: 'get_authorization_url' },
  'GET /sso/logout': { name: 'get_logout_url' },
  'GET /sso/profile': { name: 'get_profile' },
  'POST /sso/token': { name: 'get_profile_and_token' },

  // ── SSO / JWKS (mounted on UserManagement via mountRules) ────────────────
  'GET /sso/jwks/{clientId}': { name: 'get_jwks' },

  // ── User Management — auth ──────────────────────────────────────────────
  'GET /user_management/authorize': { name: 'get_authorization_url' },
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

  // ── Organizations — audit logs retention (mounted on AuditLogs) ─────────
  'GET /organizations/{id}/audit_logs_retention': { mountOn: 'AuditLogs' },
  'PUT /organizations/{id}/audit_logs_retention': { mountOn: 'AuditLogs' },

  // ── Union split: POST /user_management/authenticate (8 variants) ────────
  'POST /user_management/authenticate': {
    split: [
      {
        name: 'authenticate_with_password',
        targetVariant: 'PasswordSessionAuthenticateRequest',
        defaults: { grant_type: 'password' },
        inferFromClient: ['client_id', 'client_secret'],
        exposedParams: ['email', 'password', 'invitation_token'],
      },
      {
        name: 'authenticate_with_code',
        targetVariant: 'CodeSessionAuthenticateRequest',
        defaults: { grant_type: 'authorization_code' },
        inferFromClient: ['client_id', 'client_secret'],
        exposedParams: ['code'],
      },
      {
        name: 'authenticate_with_refresh_token',
        targetVariant: 'RefreshTokenSessionAuthenticateRequest',
        defaults: { grant_type: 'refresh_token' },
        inferFromClient: ['client_id', 'client_secret'],
        exposedParams: ['refresh_token', 'organization_id'],
      },
      {
        name: 'authenticate_with_magic_auth',
        targetVariant: 'MagicAuthSessionAuthenticateRequest',
        defaults: { grant_type: 'urn:workos:oauth:grant-type:magic-auth:code' },
        inferFromClient: ['client_id', 'client_secret'],
        exposedParams: ['code', 'email', 'invitation_token'],
      },
      {
        name: 'authenticate_with_email_verification',
        targetVariant: 'EmailVerificationSessionAuthenticateRequest',
        defaults: { grant_type: 'urn:workos:oauth:grant-type:email-verification:code' },
        inferFromClient: ['client_id', 'client_secret'],
        exposedParams: ['code', 'pending_authentication_token'],
      },
      {
        name: 'authenticate_with_totp',
        targetVariant: 'TotpSessionAuthenticateRequest',
        defaults: { grant_type: 'urn:workos:oauth:grant-type:mfa-totp' },
        inferFromClient: ['client_id', 'client_secret'],
        exposedParams: ['code', 'pending_authentication_token', 'authentication_challenge_id'],
      },
      {
        name: 'authenticate_with_organization_selection',
        targetVariant: 'OrganizationSelectionSessionAuthenticateRequest',
        defaults: { grant_type: 'urn:workos:oauth:grant-type:organization-selection' },
        inferFromClient: ['client_id', 'client_secret'],
        exposedParams: ['pending_authentication_token', 'organization_id'],
      },
      {
        name: 'authenticate_with_device_code',
        targetVariant: 'DeviceCodeSessionAuthenticateRequest',
        defaults: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code' },
        inferFromClient: ['client_id'],
        exposedParams: ['device_code'],
      },
    ],
  },

  // ── Union split: POST /connect/applications (2 variants) ────────────────
  'POST /connect/applications': {
    split: [
      {
        name: 'create_oauth_application',
        targetVariant: 'OAuthApplicationCreateRequest',
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
        targetVariant: 'M2MApplicationCreateRequest',
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
  emitters: [nodeEmitter, pythonEmitter, phpEmitter],
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
  operationHints,
  mountRules,
};
export default config;
