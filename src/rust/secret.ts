import type { Field, TypeRef } from '@workos/oagen';

/** Spec sensitivity markers take precedence over conservative fallback heuristics. */
const EXACT_NAMES = new Set<string>([
  'password',
  'new_password',
  'old_password',
  'password_hash',
  'secret',
  'client_secret',
  'signing_secret',
  'webhook_secret',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'session_token',
  'authentication_token',
  'pending_authentication_token',
  'invitation_token',
  'private_key',
  'pem_private_key',
  'data_key',
  'encrypted_keys',
  'encrypted_data_key',
  'shared_secret',
  'totp_secret',
  'jwt',
]);

/** True when the field name strongly implies it holds a secret value. */
export function isSensitiveFieldName(name: string): boolean {
  const norm = name.toLowerCase().replace(/-/g, '_');
  if (EXACT_NAMES.has(norm)) return true;
  // Common suffix forms: `*_token`, `*_secret`, `*_password`, `*_api_key`.
  if (/_password(_hash)?$/.test(norm)) return true;
  if (norm.endsWith('_secret')) return true;
  if (norm.endsWith('_token') && norm !== 'csrf_token' && norm !== 'request_token') return true;
  return false;
}

type SecretField = Pick<Field, 'name' | 'type' | 'description'>;

function hasPasswordFormat(type?: TypeRef): boolean {
  if (type?.kind === 'nullable') return hasPasswordFormat(type.inner);
  return type?.kind === 'primitive' && type.type === 'string' && type.format === 'password';
}

function holdsSecret(field: SecretField): boolean {
  if (hasPasswordFormat(field.type)) return true;
  if (isSensitiveFieldName(field.name)) return true;
  const description = field.description ?? '';
  // A mention of a secret is not enough: identifiers, hints, and provider
  // endpoints describe credentials without containing them.
  if (/error code|endpoint|obfuscat|last (?:four|few|\d)|hint|suffix/i.test(description)) return false;
  if (/^(?:value|credential)$/.test(field.name)) {
    return /plaintext|\b(?:access token|API key|secret)\b/i.test(description);
  }
  return (
    /(?:^|_)code$/.test(field.name) &&
    /one-time|authorization code|verification code|TOTP code|code used to verify/i.test(description)
  );
}

/** Redact string fields, including documented encoded forms of secret siblings. */
export function applySecretRedaction(
  rustType: string,
  fieldName: string,
  field?: SecretField,
  siblings: readonly SecretField[] = [],
): string {
  let sensitive = field ? holdsSecret(field) : isSensitiveFieldName(fieldName);
  if (!sensitive && field && /(?:^|_)(?:(?:uri|url)(?:_complete)?|qr_code)$/.test(field.name)) {
    const description = field.description ?? '';
    // Match documented sibling references such as "user code" to user_code.
    // This normalization is only for classification, never for emitted names.
    const words = (text: string) =>
      ` ${text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()} `;
    sensitive =
      !/endpoint/i.test(description) &&
      /contain|encod|includ|deriv/i.test(description) &&
      siblings.some(
        (sibling) =>
          sibling.name !== field.name &&
          holdsSecret(sibling) &&
          (words(description).includes(words(sibling.name)) || /\b(?:secret|token|seed)\b/i.test(description)),
      );
  }
  if (!sensitive) return rustType;
  if (rustType === 'String') return 'crate::SecretString';
  if (rustType === 'Option<String>') return 'Option<crate::SecretString>';
  return rustType;
}
