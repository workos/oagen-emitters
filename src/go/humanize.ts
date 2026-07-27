/** Known acronyms to preserve as single tokens during humanization. */
const HUMANIZE_ACRONYMS: [RegExp, string][] = [
  [/OAuth/g, 'OAUTH_ACRN'],
  [/URN/g, 'URN_ACRN'],
  [/IETF/g, 'IETF_ACRN'],
  [/API/g, 'API_ACRN'],
  [/SSO/g, 'SSO_ACRN'],
  [/PKCE/g, 'PKCE_ACRN'],
  [/JWT/g, 'JWT_ACRN'],
  [/MFA/g, 'MFA_ACRN'],
  [/TOTP/g, 'TOTP_ACRN'],
  [/SAML/g, 'SAML_ACRN'],
  [/SCIM/g, 'SCIM_ACRN'],
  [/OIDC/g, 'OIDC_ACRN'],
  [/CORS/g, 'CORS_ACRN'],
  [/RBAC/g, 'RBAC_ACRN'],
];

const HUMANIZE_RESTORE: [RegExp, string][] = [
  [/oauth_acrn/g, 'OAuth'],
  [/urn_acrn/g, 'URN'],
  [/ietf_acrn/g, 'IETF'],
  [/api_acrn/g, 'API'],
  [/sso_acrn/g, 'SSO'],
  [/pkce_acrn/g, 'PKCE'],
  [/jwt_acrn/g, 'JWT'],
  [/mfa_acrn/g, 'MFA'],
  [/totp_acrn/g, 'TOTP'],
  [/saml_acrn/g, 'SAML'],
  [/scim_acrn/g, 'SCIM'],
  [/oidc_acrn/g, 'OIDC'],
  [/cors_acrn/g, 'CORS'],
  [/rbac_acrn/g, 'RBAC'],
];

/** Split a PascalCase IR name into lowercase doc prose, preserving known acronyms. */
export function humanize(name: string): string {
  // Replace known acronyms with placeholders before splitting
  let s = name;
  for (const [pattern, replacement] of HUMANIZE_ACRONYMS) {
    s = s.replace(pattern, replacement);
  }
  // Split camelCase/PascalCase into words
  let result = s.replace(/([a-z])([A-Z])/g, '$1 $2');
  result = result.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  result = result.toLowerCase();
  // Restore acronyms
  for (const [pattern, replacement] of HUMANIZE_RESTORE) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
