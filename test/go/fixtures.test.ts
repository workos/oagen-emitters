import { describe, it, expect } from 'vitest';
import type { ApiSpec, Model } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateFixtures } from '../../src/go/fixtures.js';

function spec(models: Model[]): ApiSpec {
  return { name: 'Test', version: '1.0.0', baseUrl: '', services: [], models, enums: [], sdk: defaultSdkBehavior() };
}

describe('go/fixtures', () => {
  it('builds a discriminated-union fixture from the first variant alone', () => {
    // oagen 0.32 gives a discriminated union the merged superset of its
    // variants' fields: `metadata` below is declared only by `client_credentials`.
    const union = {
      name: 'Credential',
      fields: [
        { name: 'auth_method', type: { kind: 'literal', value: 'oauth' }, required: false },
        { name: 'value', type: { kind: 'primitive', type: 'string' }, required: false },
        { name: 'metadata', type: { kind: 'map', valueType: { kind: 'primitive', type: 'unknown' } }, required: false },
      ],
      discriminator: {
        property: 'auth_method',
        mapping: { oauth: 'OAuthCredential', client_credentials: 'ClientCredentialsCredential' },
      },
    } as Model;
    const unionModels: Model[] = [
      union,
      {
        name: 'OAuthCredential',
        fields: [
          { name: 'auth_method', type: { kind: 'literal', value: 'oauth' }, required: true },
          { name: 'value', type: { kind: 'primitive', type: 'string' }, required: true },
        ],
      },
      {
        name: 'ClientCredentialsCredential',
        fields: [
          { name: 'auth_method', type: { kind: 'literal', value: 'client_credentials' }, required: true },
          { name: 'value', type: { kind: 'primitive', type: 'string' }, required: true },
          {
            name: 'metadata',
            type: { kind: 'map', valueType: { kind: 'primitive', type: 'unknown' } },
            required: true,
          },
        ],
      },
      {
        name: 'CredentialsResponse',
        fields: [{ name: 'credential', type: { kind: 'model', name: 'Credential' }, required: true }],
      },
    ];
    const { files } = generateFixtures(spec(unionModels));
    const fixture = JSON.parse(files.find((f) => f.path === 'testdata/credentials_response.json')!.content);
    expect(Object.keys(fixture.credential).sort()).toEqual(['auth_method', 'value']);
    expect(fixture.credential.auth_method).toBe('oauth');
  });
});
