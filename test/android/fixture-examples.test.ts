import { describe, it, expect } from 'vitest';
import type { Enum, Model, TypeRef } from '@workos/oagen';
import { generateModelFixture } from '../../src/android/fixtures.js';

const str: TypeRef = { kind: 'primitive', type: 'string' };
const account: Model = {
  name: 'Account',
  fields: [
    { name: 'id', type: str, required: true },
    { name: 'client_id', type: { kind: 'nullable', inner: str }, required: false },
    { name: 'created_at', type: { kind: 'primitive', type: 'string', format: 'date-time' }, required: true },
  ],
};
const response: Model = {
  name: 'Response',
  fields: [
    {
      name: 'account',
      type: { kind: 'model', name: 'Account' },
      required: true,
      // Hand-written in the spec: a key the model never declares, and `client_id` missing.
      example: { id: 'acc_1', bogus: 1 },
    },
  ],
};

describe('android/fixtures: whole-object examples', () => {
  it('conforms a nested object example to the model instead of copying it verbatim', () => {
    const modelMap = new Map([account, response].map((m) => [m.name, m]));
    const enumMap = new Map<string, Enum>();
    const nested = generateModelFixture(response, modelMap, enumMap).account as Record<string, unknown>;

    expect(nested.id).toBe('acc_1');
    expect(nested).not.toHaveProperty('bogus');
    expect(nested).toHaveProperty('client_id');
    // Exactly the shape the model's own fixture has.
    expect(Object.keys(nested).sort()).toEqual(Object.keys(generateModelFixture(account, modelMap, enumMap)).sort());
  });
});

describe('android/fixtures: self-referential examples', () => {
  it('fills a nested child of a recursive example instead of copying it incomplete', () => {
    const tree: Model = {
      name: 'Tree',
      fields: [
        { name: 'label', type: str, required: true },
        { name: 'children', type: { kind: 'array', items: { kind: 'model', name: 'Tree' } }, required: true },
      ],
    };
    const wrapper: Model = {
      name: 'Wrapper',
      fields: [
        {
          name: 'root',
          type: { kind: 'model', name: 'Tree' },
          required: true,
          example: { label: 'root', children: [{ children: [] }] },
        },
      ],
    };
    const modelMap = new Map([tree, wrapper].map((m) => [m.name, m]));

    const root = generateModelFixture(wrapper, modelMap, new Map<string, Enum>()).root as {
      label: string;
      children: { label: string; children: unknown[] }[];
    };

    expect(root.label).toBe('root');
    expect(root.children).toHaveLength(1);
    expect(root.children[0].children).toEqual([]);
    expect(typeof root.children[0].label).toBe('string');
  });
});
