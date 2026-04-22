import { describe, it, expect } from 'vitest';
import { modelHasNewFields } from '../../src/node/utils.js';
import type { EmitterContext, ApiSpec, Model } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';

const emptySpec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: '',
  services: [],
  models: [],
  enums: [],
  sdk: defaultSdkBehavior(),
};

const ctx: EmitterContext = {
  namespace: 'workos',
  namespacePascal: 'WorkOS',
  spec: emptySpec,
};

describe('modelHasNewFields', () => {
  const model: Model = {
    name: 'Organization',
    fields: [
      { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
      { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
    ],
  };

  it('returns true when no apiSurface exists (Scenario B)', () => {
    expect(modelHasNewFields(model, ctx)).toBe(true);
  });

  it('returns true when model has no baseline entry (new model)', () => {
    const ctxWithSurface: EmitterContext = {
      ...ctx,
      apiSurface: {
        language: 'node',
        extractedFrom: 'test',
        extractedAt: '2024-01-01',
        classes: {},
        interfaces: {},
        typeAliases: {},
        enums: {},
        exports: {},
      },
    };
    expect(modelHasNewFields(model, ctxWithSurface)).toBe(true);
  });

  it('returns false when all fields exist in baseline', () => {
    const ctxWithBaseline: EmitterContext = {
      ...ctx,
      apiSurface: {
        language: 'node',
        extractedFrom: 'test',
        extractedAt: '2024-01-01',
        classes: {},
        typeAliases: {},
        enums: {},
        exports: {},
        interfaces: {
          Organization: {
            name: 'Organization',
            fields: {
              id: { name: 'id', type: 'string', optional: false },
              name: { name: 'name', type: 'string', optional: false },
            },
            extends: [],
          },
        },
      },
    };
    expect(modelHasNewFields(model, ctxWithBaseline)).toBe(false);
  });

  it('returns true when model has one new field not in baseline', () => {
    const modelWithNewField: Model = {
      name: 'Organization',
      fields: [
        { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
        { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
        { name: 'slug', type: { kind: 'primitive', type: 'string' }, required: false },
      ],
    };
    const ctxWithBaseline: EmitterContext = {
      ...ctx,
      apiSurface: {
        language: 'node',
        extractedFrom: 'test',
        extractedAt: '2024-01-01',
        classes: {},
        typeAliases: {},
        enums: {},
        exports: {},
        interfaces: {
          Organization: {
            name: 'Organization',
            fields: {
              id: { name: 'id', type: 'string', optional: false },
              name: { name: 'name', type: 'string', optional: false },
            },
            extends: [],
          },
        },
      },
    };
    expect(modelHasNewFields(modelWithNewField, ctxWithBaseline)).toBe(true);
  });

  it('converts snake_case IR field names to camelCase for baseline comparison', () => {
    const snakeModel: Model = {
      name: 'Organization',
      fields: [{ name: 'organization_id', type: { kind: 'primitive', type: 'string' }, required: true }],
    };
    const ctxWithBaseline: EmitterContext = {
      ...ctx,
      apiSurface: {
        language: 'node',
        extractedFrom: 'test',
        extractedAt: '2024-01-01',
        classes: {},
        typeAliases: {},
        enums: {},
        exports: {},
        interfaces: {
          Organization: {
            name: 'Organization',
            fields: {
              organizationId: { name: 'organizationId', type: 'string', optional: false },
            },
            extends: [],
          },
        },
      },
    };
    expect(modelHasNewFields(snakeModel, ctxWithBaseline)).toBe(false);
  });
});
