import { describe, it, expect } from 'vitest';
import { newtonsoftSnakeCase, stjSnakeCaseLower, wireNameRoundTrips } from '../../src/dotnet/wire-name.js';

describe('dotnet/wire-name', () => {
  it('matches Newtonsoft SnakeCaseNamingStrategy on representative names', () => {
    expect(newtonsoftSnakeCase('Id')).toBe('id');
    expect(newtonsoftSnakeCase('AuthkitAuthorizationCode')).toBe('authkit_authorization_code');
    expect(newtonsoftSnakeCase('SSOConnection')).toBe('sso_connection');
    expect(newtonsoftSnakeCase('EnableSSO')).toBe('enable_sso');
    expect(newtonsoftSnakeCase('JWTSigningKeyPair')).toBe('jwt_signing_key_pair');
    expect(newtonsoftSnakeCase('Sha256Fingerprint')).toBe('sha256_fingerprint');
    // The bug behind workos/workos-dotnet#319: acronym casing splits.
    expect(newtonsoftSnakeCase('OAuthTokens')).toBe('o_auth_tokens');
    expect(newtonsoftSnakeCase('OAuthResource')).toBe('o_auth_resource');
    // Adjacent acronyms collapse into one token.
    expect(newtonsoftSnakeCase('SAMLSSO')).toBe('samlsso');
    // Digits after an uppercase run get a separator in Newtonsoft only.
    expect(newtonsoftSnakeCase('ID2')).toBe('i_d2');
  });

  it('matches System.Text.Json SnakeCaseLower on representative names', () => {
    expect(stjSnakeCaseLower('Id')).toBe('id');
    expect(stjSnakeCaseLower('AuthkitAuthorizationCode')).toBe('authkit_authorization_code');
    expect(stjSnakeCaseLower('SSOConnection')).toBe('sso_connection');
    expect(stjSnakeCaseLower('EnableSSO')).toBe('enable_sso');
    expect(stjSnakeCaseLower('JWTSigningKeyPair')).toBe('jwt_signing_key_pair');
    expect(stjSnakeCaseLower('Sha256Fingerprint')).toBe('sha256_fingerprint');
    expect(stjSnakeCaseLower('OAuthTokens')).toBe('o_auth_tokens');
    expect(stjSnakeCaseLower('OAuthResource')).toBe('o_auth_resource');
    expect(stjSnakeCaseLower('SAMLSSO')).toBe('samlsso');
    // STJ keeps digits attached to the preceding uppercase run.
    expect(stjSnakeCaseLower('ID2')).toBe('id2');
  });

  it('reports whether convention-based naming recovers the wire key', () => {
    expect(wireNameRoundTrips('Id', 'id')).toBe(true);
    expect(wireNameRoundTrips('AccessToken', 'access_token')).toBe(true);
    expect(wireNameRoundTrips('SSOConnection', 'sso_connection')).toBe(true);
    expect(wireNameRoundTrips('JWTSigningKeyPair', 'jwt_signing_key_pair')).toBe(true);

    expect(wireNameRoundTrips('OAuthTokens', 'oauth_tokens')).toBe(false);
    expect(wireNameRoundTrips('OAuthResource', 'oauth_resource')).toBe(false);
    expect(wireNameRoundTrips('SAMLSSO', 'saml_sso')).toBe(false);
    // Renames the emitter already pins explicitly.
    expect(wireNameRoundTrips('ErrorValue', 'error')).toBe(false);
    expect(wireNameRoundTrips('Type', 'connection_type')).toBe(false);
    // Diverging serializers count as non-round-tripping.
    expect(wireNameRoundTrips('ID2', 'id2')).toBe(false);
  });
});
