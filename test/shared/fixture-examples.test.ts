import { describe, it, expect } from 'vitest';
import type { Field, Model, TypeRef } from '@workos/oagen';
import { conformExample, type ExampleConformer } from '../../src/shared/fixture-examples.js';

const str: TypeRef = { kind: 'primitive', type: 'string' };
const field = (name: string, type: TypeRef = str): Field => ({ name, type, required: true });

const address: Model = { name: 'Address', fields: [field('city'), field('zip')] };
const account: Model = {
  name: 'Account',
  fields: [
    field('id'),
    field('client_id', { kind: 'nullable', inner: str }),
    field('address', { kind: 'model', name: 'Address' }),
    field('tags', { kind: 'array', items: { kind: 'model', name: 'Address' } }),
    field('created_at'),
    // A camelCase twin the builder collapses onto `created_at`.
    field('createdAt'),
  ],
};
const modelMap = new Map([address, account].map((m) => [m.name, m]));

/** Stands in for an emitter's builder: one generated value per kept field. */
const generated: Record<string, () => Record<string, unknown>> = {
  Address: () => ({ city: 'gen_city', zip: 'gen_zip' }),
  Account: () => ({
    id: 'gen_id',
    client_id: 'gen_client_id',
    address: generated.Address(),
    tags: [generated.Address()],
    created_at: 'gen_created_at',
  }),
};
const conformer: ExampleConformer = { modelMap, buildModel: (m) => generated[m.name]() };

describe('shared/fixture-examples', () => {
  it('overlays declared keys, drops unknown ones, keeps generated values for missing fields, and recurses', () => {
    const result = conformExample(
      { kind: 'model', name: 'Account' },
      {
        id: 'acc_1',
        createdAt: '2024-01-16T14:20:00Z',
        bogus: 1,
        address: { city: 'Austin', junk: true },
        tags: [{ zip: '78701' }],
      },
      conformer,
    );

    expect(result).toEqual({
      id: 'acc_1',
      client_id: 'gen_client_id',
      address: { city: 'Austin', zip: 'gen_zip' },
      tags: [{ city: 'gen_city', zip: '78701' }],
      created_at: 'gen_created_at',
    });
  });

  it('leaves nulls, scalars, scalar arrays and non-object model examples alone', () => {
    expect(conformExample({ kind: 'nullable', inner: { kind: 'model', name: 'Account' } }, null, conformer)).toBeNull();
    expect(conformExample(str, 'plain', conformer)).toBe('plain');
    expect(conformExample({ kind: 'array', items: str }, ['a', 'b'], conformer)).toEqual(['a', 'b']);
    expect(conformExample({ kind: 'model', name: 'Account' }, 'not-an-object', conformer)).toBe('not-an-object');
    expect(conformExample({ kind: 'model', name: 'Unknown' }, { id: 'x' }, conformer)).toEqual({ id: 'x' });
  });

  it('conforms map values', () => {
    const result = conformExample(
      { kind: 'map', valueType: { kind: 'model', name: 'Address' } },
      { home: { city: 'Austin', junk: 1 } },
      conformer,
    );
    expect(result).toEqual({ home: { city: 'Austin', zip: 'gen_zip' } });
  });

  it("honors the builder's wire keys and leaf normalization", () => {
    const thing: Model = { name: 'Thing', fields: [field('id'), field('createdAt')] };
    const result = conformExample(
      { kind: 'model', name: 'Thing' },
      { id: 'x', created_at: 'y' },
      {
        modelMap: new Map([[thing.name, thing]]),
        wireKey: (name) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
        buildModel: () => ({ id: 'gen', created_at: 'gen' }),
        normalize: (_f, value) => (typeof value === 'string' ? value.toUpperCase() : value),
      },
    );
    expect(result).toEqual({ id: 'X', created_at: 'Y' });
  });

  it('ends recursion where a self-referential example ends instead of rebuilding the model forever', () => {
    // `Tree.child` is a `Tree` again and carries an object example. The
    // builder re-enters the conformer for every field with an example, so
    // without a guard: overlay → build → the same example → overlay → …
    const tree: Model = {
      name: 'Tree',
      fields: [
        field('label'),
        {
          name: 'child',
          type: { kind: 'nullable', inner: { kind: 'model', name: 'Tree' } },
          required: false,
          example: { label: 'leaf', child: null },
        },
      ],
    };
    const treeMap = new Map([[tree.name, tree]]);
    const reentrant: ExampleConformer = {
      modelMap: treeMap,
      buildModel: (m) =>
        Object.fromEntries(
          m.fields.map((f) => [
            f.name,
            f.example !== undefined ? conformExample(f.type, f.example, reentrant) : `gen_${f.name}`,
          ]),
        ),
    };

    const result = conformExample(
      { kind: 'model', name: 'Tree' },
      { label: 'root', child: { label: 'leaf', child: null } },
      reentrant,
    );

    expect(result).toEqual({ label: 'root', child: { label: 'leaf', child: null } });
  });

  it('still conforms finite children of a self-referential example, filling their missing fields', () => {
    // No field examples on `Tree` itself; the wrapper's example nests a child
    // that lacks the required `label`. The builder is depth-bounded like
    // Android's and iOS's. The child must be rebuilt and filled, not copied.
    const tree: Model = {
      name: 'Tree',
      fields: [field('label'), field('children', { kind: 'array', items: { kind: 'model', name: 'Tree' } })],
    };
    const treeMap = new Map([[tree.name, tree]]);
    const bounded = (m: Model, depth = 0): Record<string, unknown> =>
      Object.fromEntries(
        m.fields.map((f) => {
          if (f.example !== undefined) return [f.name, conformExample(f.type, f.example, reentrant)];
          if (f.type.kind === 'array') return [f.name, depth < 2 ? [bounded(m, depth + 1)] : []];
          return [f.name, `gen_${f.name}`];
        }),
      );
    const reentrant: ExampleConformer = { modelMap: treeMap, buildModel: (m) => bounded(m) };

    const result = conformExample(
      { kind: 'model', name: 'Tree' },
      { label: 'root', children: [{ children: [] }] },
      reentrant,
    );

    expect(result).toEqual({ label: 'root', children: [{ label: 'gen_label', children: [] }] });
  });

  it('never touches the pinned discriminator and overlays variant fields only where the builder kept them', () => {
    const oauth: Model = {
      name: 'OauthCredential',
      fields: [
        field('auth_method', { kind: 'literal', value: 'oauth' }),
        field('scopes', { kind: 'array', items: str }),
      ],
    };
    const apiKey: Model = {
      name: 'ApiKeyCredential',
      fields: [field('auth_method', { kind: 'literal', value: 'api_key' }), field('api_key_last_4')],
    };
    const credential: Model = {
      name: 'Credential',
      fields: [...oauth.fields, apiKey.fields[1]],
      discriminator: { property: 'auth_method', mapping: { oauth: 'OauthCredential', api_key: 'ApiKeyCredential' } },
    };
    const unionMap = new Map([oauth, apiKey, credential].map((m) => [m.name, m]));
    const example = { auth_method: 'api_key', api_key_last_4: 'cdef', scopes: ['repo'] };

    // A builder that emits the first variant alone (Python, Go).
    const variantOnly = conformExample({ kind: 'model', name: 'Credential' }, example, {
      modelMap: unionMap,
      buildModel: () => ({ auth_method: 'oauth', scopes: ['gen'] }),
    });
    expect(variantOnly).toEqual({ auth_method: 'oauth', scopes: ['repo'] });

    // A builder that folds every variant's fields in (Node, Android, iOS).
    const folded = conformExample({ kind: 'model', name: 'Credential' }, example, {
      modelMap: unionMap,
      buildModel: () => ({ auth_method: 'oauth', scopes: ['gen'], api_key_last_4: 'gen' }),
    });
    expect(folded).toEqual({ auth_method: 'oauth', scopes: ['repo'], api_key_last_4: 'cdef' });
  });
});
