import { afterEach, describe, expect, it } from 'vitest';
import type { EmitterContext } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { resolveInterfaceName, setAdoptedModelNames } from '../../src/node/naming.js';

const ctx: EmitterContext = {
  namespace: 'workos',
  namespacePascal: 'WorkOS',
  spec: {
    name: 'Test',
    version: '1.0.0',
    baseUrl: '',
    services: [],
    models: [],
    enums: [],
    sdk: defaultSdkBehavior(),
  },
};

afterEach(() => {
  setAdoptedModelNames(new Set());
});

describe('resolveInterfaceName', () => {
  it('normalizes structural matches that point at legacy Serialized* wire interfaces', () => {
    const result = resolveInterfaceName('OrganizationApiKey', {
      ...ctx,
      apiSurface: {
        language: 'node',
        extractedFrom: '/tmp/workos-node',
        extractedAt: '2026-05-12T00:00:00Z',
        classes: {},
        interfaces: {
          CreatedApiKey: {},
          SerializedCreatedApiKey: {},
        },
        typeAliases: {},
        enums: {},
        exports: {},
      } as any,
      overlayLookup: {
        methodByOperation: new Map(),
        interfaceByName: new Map(),
        modelNameByIR: new Map([['OrganizationApiKey', 'SerializedCreatedApiKey']]),
      } as any,
    });

    expect(result).toBe('CreatedApiKey');
  });

  it('does not apply unrelated structural matches to adopted-service models', () => {
    setAdoptedModelNames(new Set(['CreateM2MApplication']));

    const result = resolveInterfaceName('CreateM2MApplication', {
      ...ctx,
      apiSurface: {
        language: 'node',
        extractedFrom: '/tmp/workos-node',
        extractedAt: '2026-05-12T00:00:00Z',
        classes: {},
        interfaces: {
          CreateGroupOptions: {},
        },
        typeAliases: {},
        enums: {},
        exports: {},
      } as any,
      overlayLookup: {
        methodByOperation: new Map(),
        interfaceByName: new Map(),
        modelNameByIR: new Map([['CreateM2MApplication', 'CreateGroupOptions']]),
      } as any,
    });

    expect(result).toBe('CreateM2MApplication');
  });
});
