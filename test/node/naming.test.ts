import { afterEach, describe, expect, it } from 'vitest';
import type { EmitterContext } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import {
  resolveInterfaceName,
  setAdoptedModelNames,
  setBaselineInterfaceNames,
  setStructurallyRenamedDomainNames,
  wireInterfaceName,
} from '../../src/node/naming.js';

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
  setBaselineInterfaceNames(new Set());
  setStructurallyRenamedDomainNames(new Set());
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

describe('wireInterfaceName', () => {
  it('emits *Wire for a fresh `*Response`-named IR model with an empty baseline', () => {
    expect(wireInterfaceName('CreateDataKeyResponse')).toBe('CreateDataKeyResponseWire');
  });

  it('returns *Wire even when a prior buggy regen poisoned the baseline with the bare name', () => {
    // Reproduces the vault regression: `CreateDataKeyResponse` is its own IR
    // name (no structural rename), so the resolver does not flag it. A prior
    // broken emission wrote `export interface CreateDataKeyResponse { ... }`
    // twice into the file, and the baseline now contains the bare name.
    // Without the rename signal, `wireInterfaceName` must still pick `*Wire`
    // — otherwise the duplicate emission perpetuates across regens.
    setBaselineInterfaceNames(new Set(['CreateDataKeyResponse']));
    expect(wireInterfaceName('CreateDataKeyResponse')).toBe('CreateDataKeyResponseWire');
  });

  it('uses *Wire when baseline already has a separate `*Wire` companion', () => {
    setBaselineInterfaceNames(new Set(['DecryptResponse', 'DecryptResponseWire']));
    expect(wireInterfaceName('DecryptResponse')).toBe('DecryptResponseWire');
  });

  it('returns the bare name when a structural rename mapped a differently-named IR model onto a baseline `*Response`', () => {
    // The legitimate single-form case the heuristic was designed for:
    // `AuditLogSchemaJson` → `AuditLogSchemaResponse` via structural match,
    // and the baseline owns just the one `AuditLogSchemaResponse` interface
    // representing the wire shape.
    setBaselineInterfaceNames(new Set(['AuditLogSchemaResponse']));
    setStructurallyRenamedDomainNames(new Set(['AuditLogSchemaResponse']));
    expect(wireInterfaceName('AuditLogSchemaResponse')).toBe('AuditLogSchemaResponse');
  });

  it('falls back to `${name}Response` for non-`*Response` IR names', () => {
    expect(wireInterfaceName('Organization')).toBe('OrganizationResponse');
  });
});
