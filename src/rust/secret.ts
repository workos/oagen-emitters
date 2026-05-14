/**
 * Heuristics for spotting fields that hold secrets. The Rust emitter wraps
 * such fields in `crate::SecretString` so their `Debug` representation does
 * not accidentally leak the value.
 *
 * The list is intentionally conservative — only fields whose names strongly
 * imply a credential or token are redacted. Generic names like `value` are
 * skipped; the cost of a leaked secret is high enough that we'd rather miss
 * the occasional secret than redact non-secret data and surprise users.
 */
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

/**
 * If `rustType` is `String` or `Option<String>` and `fieldName` looks
 * sensitive, return the redacted equivalent (`crate::SecretString` or
 * `Option<crate::SecretString>`). Otherwise return `rustType` unchanged.
 */
export function applySecretRedaction(rustType: string, fieldName: string): string {
  if (!isSensitiveFieldName(fieldName)) return rustType;
  if (rustType === 'String') return 'crate::SecretString';
  if (rustType === 'Option<String>') return 'Option<crate::SecretString>';
  return rustType;
}
