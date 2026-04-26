import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Model } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { modelHasNewFields } from '../../src/node/utils.js';

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
  it('returns true when no apiSurface (Scenario B)', () => {
    const model: Model = {
      name: 'Organization',
      fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
    };
    expect(modelHasNewFields(model, ctx)).toBe(true);
  });

  it('returns true when model not in baseline', () => {
    const model: Model = {
      name: 'NewModel',
      fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
    };
    const ctxWithSurface: EmitterContext = {
      ...ctx,
      apiSurface: { interfaces: { Organization: { fields: {} } } } as any,
    };
    expect(modelHasNewFields(model, ctxWithSurface)).toBe(true);
  });

  it('returns false when all fields in baseline', () => {
    const model: Model = {
      name: 'Organization',
      fields: [
        { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
        { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
      ],
    };
    const ctxWithSurface: EmitterContext = {
      ...ctx,
      apiSurface: {
        interfaces: {
          Organization: {
            fields: {
              id: { type: 'string', optional: false },
              name: { type: 'string', optional: false },
            },
          },
        },
      } as any,
    };
    expect(modelHasNewFields(model, ctxWithSurface)).toBe(false);
  });

  it('returns true when new field added', () => {
    const model: Model = {
      name: 'Organization',
      fields: [
        { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
        { name: 'new_field', type: { kind: 'primitive', type: 'string' }, required: false },
      ],
    };
    const ctxWithSurface: EmitterContext = {
      ...ctx,
      apiSurface: {
        interfaces: {
          Organization: {
            fields: {
              id: { type: 'string', optional: false },
            },
          },
        },
      } as any,
    };
    expect(modelHasNewFields(model, ctxWithSurface)).toBe(true);
  });
});
