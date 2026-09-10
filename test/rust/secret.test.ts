import { describe, expect, it } from 'vitest';
import type { Field } from '@workos/oagen';
import { applySecretRedaction } from '../../src/rust/secret.js';

const field = (name: string, description?: string, format?: string): Field => ({
  name,
  description,
  type: { kind: 'primitive', type: 'string', format },
  required: true,
});

const redact = (f: Field, type = 'String', siblings: Field[] = []) => applySecretRedaction(type, f.name, f, siblings);

describe('rust secret classification', () => {
  it('honors password format even for generic names and nullable strings', () => {
    const marked = field('value', undefined, 'password');
    expect(redact(marked)).toBe('crate::SecretString');
    expect(redact({ ...marked, type: { kind: 'nullable', inner: marked.type } }, 'Option<String>')).toBe(
      'Option<crate::SecretString>',
    );
    expect(redact(marked, 'Vec<String>')).toBe('Vec<String>');
    expect(redact(field('value', 'A public hint.', 'password'))).toBe('crate::SecretString');
  });

  it.each([
    ['value', 'The OAuth access token.'],
    ['value', 'The full API Key value. Only returned once at creation time.'],
    ['value', 'Decrypted plaintext value.'],
    ['credential', 'The credential value to validate: the API key value.'],
    ['code', 'The one-time code for the challenge.'],
    ['authkit_authorization_code', 'An authorization code that can be exchanged for tokens.'],
  ])('redacts semantic secret %s: %s', (name, description) => {
    expect(redact(field(name, description))).toBe('crate::SecretString');
  });

  it.each([
    ['code', 'The error code identifying the type of error.'],
    ['token_url', "The provider's OAuth token endpoint."],
    ['refresh_token_url', 'The endpoint used to refresh tokens.'],
    ['value', 'An obfuscated representation of the API Key value.'],
    ['value', 'A hint showing the last few characters of the secret value.'],
    ['id', 'The unique ID of the client secret.'],
    ['value', 'The PEM-encoded public X.509 certificate.'],
    ['code', 'A public classification code.'],
  ])('preserves non-secret %s: %s', (name, description) => {
    expect(redact(field(name, description))).toBe('String');
  });

  it.each(['uri', 'qr_code', 'reset_url'])('redacts documented secret-derived %s siblings', (name) => {
    const derived = field(name, 'Encoded form containing the secret.');
    expect(redact(derived, 'String', [field('secret')])).toBe('crate::SecretString');
    expect(redact(derived)).toBe('String');
    expect(redact(field(name, 'Public endpoint containing the token.'), 'String', [field('token')])).toBe('String');
  });

  it.each(['user code', '`user_code`', 'USER CODE'])(
    'redacts complete URIs referencing %s without losing URI format',
    (reference) => {
      const uri = field('verification_uri_complete', `Verification URI that includes the ${reference}.`, 'uri');
      const userCode = field('user_code', 'The end-user verification code.', 'password');
      expect(redact(uri, 'String', [userCode])).toBe('crate::SecretString');
      expect(redact(uri, 'Option<String>', [userCode])).toBe('Option<crate::SecretString>');
      expect(uri.name).toBe('verification_uri_complete');
      expect(uri.type).toEqual({ kind: 'primitive', type: 'string', format: 'uri' });
      expect(redact(uri)).toBe('String');
      expect(redact(uri, 'String', [field('user_code', 'A public display code.')])).toBe('String');
      expect(redact(field('verification_uri', 'The end-user verification URI.', 'uri'), 'String', [userCode])).toBe(
        'String',
      );
      expect(
        redact(field('token_url', `Provider endpoint including the ${reference}.`, 'uri'), 'String', [userCode]),
      ).toBe('String');
      expect(
        redact(field('verification_uri_complete', 'URI including the superuser code.', 'uri'), 'String', [userCode]),
      ).toBe('String');
    },
  );

  it('retains existing name-based redaction', () => {
    expect(applySecretRedaction('Option<String>', 'access_token')).toBe('Option<crate::SecretString>');
  });
});
