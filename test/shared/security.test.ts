import { describe, it, expect } from 'vitest';
import type { Operation } from '@workos/oagen';
import { bearerOverrideScheme } from '../../src/shared/security.js';

/** An operation with the given `security`, in whichever shape the test wants to feed in. */
function op(security: unknown): Operation {
  return {
    name: 'getProfile',
    httpMethod: 'get',
    path: '/sso/profile',
    pathParams: [],
    queryParams: [],
    headerParams: [],
    response: { kind: 'model', name: 'Profile' },
    errors: [],
    injectIdempotencyKey: false,
    security: security as Operation['security'],
  };
}

describe('bearerOverrideScheme', () => {
  it('returns null when the operation declares nothing or declares no authentication', () => {
    expect(bearerOverrideScheme(op(undefined))).toBeNull();
    expect(bearerOverrideScheme(op([]))).toBeNull();
  });

  it('returns null when every alternative is the default bearer scheme', () => {
    expect(bearerOverrideScheme(op([[{ schemeName: 'bearerAuth', scopes: [] }]]))).toBeNull();
  });

  it('finds the override across alternatives and inside a set', () => {
    // Either `bearerAuth` or `access_token` is accepted.
    expect(
      bearerOverrideScheme(
        op([[{ schemeName: 'bearerAuth', scopes: [] }], [{ schemeName: 'access_token', scopes: [] }]]),
      ),
    ).toBe('access_token');
    // Both `bearerAuth` and `partnerKey` are required together.
    expect(
      bearerOverrideScheme(
        op([
          [
            { schemeName: 'bearerAuth', scopes: [] },
            { schemeName: 'partnerKey', scopes: [] },
          ],
        ]),
      ),
    ).toBe('partnerKey');
  });

  it('reads the flat list @workos/oagen 0.30 produced the same way', () => {
    expect(bearerOverrideScheme(op([{ schemeName: 'access_token', scopes: [] }]))).toBe('access_token');
    expect(bearerOverrideScheme(op([{ schemeName: 'bearerAuth', scopes: [] }]))).toBeNull();
  });
});
