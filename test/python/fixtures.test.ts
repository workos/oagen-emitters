import { describe, it, expect } from 'vitest';
import type { Model, Enum, TypeRef } from '@workos/oagen';
import { generateModelFixture } from '../../src/python/fixtures.js';

const str: TypeRef = { kind: 'primitive', type: 'string' };
const dateTime: TypeRef = { kind: 'primitive', type: 'string', format: 'date-time' };
const nullable = (inner: TypeRef): TypeRef => ({ kind: 'nullable', inner });
const model = (name: string): TypeRef => ({ kind: 'model', name });
const field = (name: string, type: TypeRef, extra: Partial<Model['fields'][number]> = {}): Model['fields'][number] => ({
  name,
  type,
  required: true,
  ...extra,
});

const account: Model = {
  name: 'Account',
  fields: [
    field('id', str),
    field('client_id', nullable(str), { required: false }),
    field('created_at', dateTime),
    // A camelCase duplicate the Python model collapses onto `created_at`.
    field('createdAt', dateTime),
  ],
};
const modelMap = (...extra: Model[]) => new Map([account, ...extra].map((m) => [m.name, m]));
const enumMap = new Map<string, Enum>();

describe('python/fixtures: whole-object examples', () => {
  it('overlays an object example onto the nested model fixture, dropping keys the model cannot carry', () => {
    const response: Model = {
      name: 'Response',
      fields: [
        field('account', model('Account'), {
          example: {
            id: 'acc_1',
            created_at: '2024-01-16T14:20:00Z',
            createdAt: '2024-01-16T14:20:00Z',
            bogus: 1,
          },
        }),
      ],
    };

    const fixture = generateModelFixture(response, modelMap(response), enumMap);

    expect(fixture.account).toEqual({
      id: 'acc_1',
      // Missing from the example, so it keeps the generated value instead of vanishing.
      client_id: expect.any(String),
      created_at: '2024-01-16T14:20:00.000Z',
    });
    // Exactly the keys the nested model's own fixture has.
    expect(Object.keys(fixture.account)).toEqual(Object.keys(generateModelFixture(account, modelMap(), enumMap)));
  });

  it('keeps a null example for a nullable model field and scalar examples as they are', () => {
    const response: Model = {
      name: 'Response',
      fields: [
        field('account', nullable(model('Account')), { example: null }),
        field('name', str, { example: 'Acme' }),
      ],
    };

    const fixture = generateModelFixture(response, modelMap(response), enumMap);

    expect(fixture.account).toBeNull();
    expect(fixture.name).toBe('Acme');
  });

  it('conforms each item of an array example', () => {
    const response: Model = {
      name: 'Response',
      fields: [
        field('accounts', { kind: 'array', items: model('Account') }, { example: [{ id: 'acc_1', junk: true }] }),
      ],
    };

    const fixture = generateModelFixture(response, modelMap(response), enumMap);

    expect(fixture.accounts).toHaveLength(1);
    expect(fixture.accounts[0]).toMatchObject({ id: 'acc_1' });
    expect(fixture.accounts[0]).toHaveProperty('client_id');
    expect(fixture.accounts[0]).not.toHaveProperty('junk');
  });

  it('overlays a discriminated union through its first mapped variant and keeps the pinned discriminator', () => {
    const oauth: Model = {
      name: 'OauthCredential',
      fields: [
        field('auth_method', { kind: 'literal', value: 'oauth' }),
        field('scopes', { kind: 'array', items: str }),
      ],
    };
    const apiKey: Model = {
      name: 'ApiKeyCredential',
      fields: [field('auth_method', { kind: 'literal', value: 'api_key' }), field('api_key_last_4', str)],
    };
    const credential: Model = {
      name: 'Credential',
      fields: [...oauth.fields, apiKey.fields[1]],
      discriminator: { property: 'auth_method', mapping: { oauth: 'OauthCredential', api_key: 'ApiKeyCredential' } },
    };
    const response: Model = {
      name: 'Response',
      fields: [
        field('credential', model('Credential'), {
          example: { auth_method: 'api_key', api_key_last_4: 'cdef', scopes: ['repo'] },
        }),
      ],
    };

    const fixture = generateModelFixture(
      response,
      new Map([oauth, apiKey, credential, response].map((m) => [m.name, m])),
      enumMap,
    );

    expect(fixture.credential).toEqual({ auth_method: 'oauth', scopes: ['repo'] });
  });
});

describe('python/fixtures: self-referential examples', () => {
  it('terminates when a recursive field carries an object example', () => {
    const tree: Model = {
      name: 'Tree',
      fields: [
        field('label', str),
        field('child', nullable(model('Tree')), { required: false, example: { label: 'leaf', child: null } }),
      ],
    };

    const fixture = generateModelFixture(tree, modelMap(tree), enumMap);

    expect(fixture.child).toEqual({ label: 'leaf', child: null });
  });
});
