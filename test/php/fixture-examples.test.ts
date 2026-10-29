import { describe, it, expect } from 'vitest';
import type { Enum, Model, TypeRef } from '@workos/oagen';
import { generateModelFixture } from '../../src/php/fixtures.js';

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

describe('php/fixtures: whole-object examples', () => {
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
