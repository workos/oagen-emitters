import { describe, expect, it } from 'vitest';
import type { Model, TypeRef, UnionType } from '@workos/oagen';
import { flattenDiscriminatedUnionFields } from '../../src/shared/union-flatten.js';

/** The `ApiKey.owner` discriminated-union shape from the WorkOS spec. */
function ownerUnion(): UnionType {
  return {
    kind: 'union',
    compositionKind: 'oneOf',
    discriminator: { property: 'type', mapping: { organization: 'ApiKeyOwner', user: 'UserApiKeyOwner' } },
    variants: [
      { kind: 'model', name: 'ApiKeyOwner' },
      { kind: 'model', name: 'UserApiKeyOwner' },
    ],
  };
}

function baseModels(ownerType: TypeRef): Model[] {
  return [
    {
      name: 'ApiKey',
      fields: [{ name: 'owner', type: ownerType, required: true }],
    },
    {
      name: 'ApiKeyOwner',
      fields: [
        { name: 'type', type: { kind: 'literal', value: 'organization' }, required: true },
        { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
      ],
    },
    {
      name: 'UserApiKeyOwner',
      fields: [
        { name: 'type', type: { kind: 'literal', value: 'user' }, required: true },
        { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
        { name: 'organization_id', type: { kind: 'primitive', type: 'string' }, required: true },
      ],
    },
  ];
}

describe('flattenDiscriminatedUnionFields', () => {
  it('rewrites a discriminated-union field to a ref to the first variant', () => {
    const out = flattenDiscriminatedUnionFields(baseModels(ownerUnion()));
    const apiKey = out.find((m) => m.name === 'ApiKey')!;
    expect(apiKey.fields[0].type).toEqual({ kind: 'model', name: 'ApiKeyOwner' });
  });

  it('merges later-variant fields into the canonical model as optional', () => {
    const out = flattenDiscriminatedUnionFields(baseModels(ownerUnion()));
    const canonical = out.find((m) => m.name === 'ApiKeyOwner')!;
    const orgId = canonical.fields.find((f) => f.name === 'organization_id');
    expect(orgId).toBeDefined();
    expect(orgId!.required).toBe(false);
    // Fields shared (and required) by every variant stay required.
    expect(canonical.fields.find((f) => f.name === 'id')!.required).toBe(true);
  });

  it('widens the discriminator property to a union of its literal values', () => {
    const out = flattenDiscriminatedUnionFields(baseModels(ownerUnion()));
    const canonical = out.find((m) => m.name === 'ApiKeyOwner')!;
    const typeField = canonical.fields.find((f) => f.name === 'type')!;
    expect(typeField.type).toEqual({
      kind: 'union',
      variants: [
        { kind: 'literal', value: 'organization' },
        { kind: 'literal', value: 'user' },
      ],
    });
  });

  it('flattens the union when wrapped in nullable', () => {
    const out = flattenDiscriminatedUnionFields(baseModels({ kind: 'nullable', inner: ownerUnion() }));
    const apiKey = out.find((m) => m.name === 'ApiKey')!;
    expect(apiKey.fields[0].type).toEqual({ kind: 'nullable', inner: { kind: 'model', name: 'ApiKeyOwner' } });
  });

  it('leaves a non-discriminated (untagged) primitive union untouched', () => {
    // AuditLogEvent actor metadata: string | number | boolean — no discriminator.
    const union: TypeRef = {
      kind: 'union',
      compositionKind: 'anyOf',
      variants: [
        { kind: 'primitive', type: 'string' },
        { kind: 'primitive', type: 'number' },
        { kind: 'primitive', type: 'boolean' },
      ],
    };
    const models: Model[] = [{ name: 'Meta', fields: [{ name: 'value', type: union, required: false }] }];
    expect(flattenDiscriminatedUnionFields(models)).toBe(models);
  });

  it('skips a union whose variants are dispatcher (discriminated) models', () => {
    // Event-style union: each variant is itself a discriminated base. Must not flatten.
    const union: UnionType = {
      kind: 'union',
      discriminator: { property: 'event', mapping: { a: 'EventA', b: 'EventB' } },
      variants: [
        { kind: 'model', name: 'EventA' },
        { kind: 'model', name: 'EventB' },
      ],
    };
    const models: Model[] = [
      { name: 'Envelope', fields: [{ name: 'data', type: union, required: true }] },
      { name: 'EventA', fields: [], discriminator: { property: 'x', mapping: {} } },
      { name: 'EventB', fields: [], discriminator: { property: 'x', mapping: {} } },
    ];
    const out = flattenDiscriminatedUnionFields(models);
    expect(out.find((m) => m.name === 'Envelope')!.fields[0].type).toBe(union);
  });

  it('does not mutate the input models', () => {
    const models = baseModels(ownerUnion());
    const canonicalBefore = models.find((m) => m.name === 'ApiKeyOwner')!;
    const fieldCountBefore = canonicalBefore.fields.length;
    flattenDiscriminatedUnionFields(models);
    expect(canonicalBefore.fields.length).toBe(fieldCountBefore);
    expect(models.find((m) => m.name === 'ApiKey')!.fields[0].type).toEqual(ownerUnion());
  });
});
