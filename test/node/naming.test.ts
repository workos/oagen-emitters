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

// ---------------------------------------------------------------------------
// Structural name resolution must be INJECTIVE: a live-surface name may be
// claimed by at most one IR model per run. Reconstructs the workos-node
// AuditLogs incident: the spec has two near-identical models
// (AuditLogEventActor / AuditLogEventTarget) and the live SDK declares a
// hand-written AuditLogActor with the same shape. The structural fallback
// mapped BOTH IR models onto AuditLogActor, so
// audit-log-event-target.interface.ts was emitted declaring
// `export interface AuditLogActor` (file stem and declaration disagree),
// with duplicate imports/describe blocks and two serializeAuditLogActor
// definitions downstream.
// ---------------------------------------------------------------------------
describe('resolveInterfaceName structural injectivity', () => {
  const field = (name: string, required = false) => ({
    name,
    type: { kind: 'primitive', type: 'string' },
    required,
  });

  // Shape ~ { id?, name, type?, metadata? } — matches the live AuditLogActor.
  const eventShape = (extra: string) => [
    field('id'),
    field('name', true),
    field('type'),
    field('metadata'),
    field(extra),
  ];

  const liveActorFields = {
    id: { type: 'string', optional: true },
    name: { type: 'string', optional: false },
    type: { type: 'string', optional: true },
    metadata: { type: 'string', optional: true },
  };

  function auditCtx(opts: {
    models?: { name: string; fields: unknown[] }[];
    modelNameByIR: [string, string][];
    interfaceByName?: [string, string][];
    extraInterfaces?: Record<string, unknown>;
  }): EmitterContext {
    const models = opts.models ?? [
      { name: 'AuditLogEventActor', fields: eventShape('ip_address') },
      { name: 'AuditLogEventTarget', fields: eventShape('domain') },
    ];
    return {
      ...ctx,
      spec: { ...ctx.spec, models },
      apiSurface: {
        language: 'node',
        extractedFrom: '/tmp/workos-node',
        extractedAt: '2026-06-10T00:00:00Z',
        classes: {},
        interfaces: {
          AuditLogActor: { fields: liveActorFields },
          ...(opts.extraInterfaces ?? {}),
        },
        typeAliases: {},
        enums: {},
        exports: {},
      },
      overlayLookup: {
        methodByOperation: new Map(),
        interfaceByName: new Map(opts.interfaceByName ?? []),
        modelNameByIR: new Map(opts.modelNameByIR),
      },
    } as unknown as EmitterContext;
  }

  it('never lets two IR models collapse onto one live name', () => {
    const c = auditCtx({
      modelNameByIR: [
        ['AuditLogEventActor', 'AuditLogActor'],
        ['AuditLogEventTarget', 'AuditLogActor'],
      ],
    });

    const actor = resolveInterfaceName('AuditLogEventActor', c);
    const target = resolveInterfaceName('AuditLogEventTarget', c);

    // The closer name wins the contested live name; the loser keeps its
    // canonical IR-derived name — it must NEVER unify onto AuditLogActor.
    expect(actor).toBe('AuditLogActor');
    expect(target).toBe('AuditLogEventTarget');
    expect(actor).not.toBe(target);
  });

  it('awards a contested name independently of overlay insertion order', () => {
    const c = auditCtx({
      models: [
        { name: 'AuditLogEventTarget', fields: eventShape('domain') },
        { name: 'AuditLogEventActor', fields: eventShape('ip_address') },
      ],
      modelNameByIR: [
        ['AuditLogEventTarget', 'AuditLogActor'],
        ['AuditLogEventActor', 'AuditLogActor'],
      ],
    });

    expect(resolveInterfaceName('AuditLogEventActor', c)).toBe('AuditLogActor');
    expect(resolveInterfaceName('AuditLogEventTarget', c)).toBe('AuditLogEventTarget');
  });

  it('stays injective when Serialized* normalization collapses two distinct raw matches', () => {
    // The engine overlay itself is injective on raw names (actor →
    // AuditLogActor, target → SerializedAuditLogActor), but the resolver
    // normalizes Serialized* down to the bare name — that post-processing
    // must not re-introduce a collision.
    const c = auditCtx({
      modelNameByIR: [
        ['AuditLogEventActor', 'AuditLogActor'],
        ['AuditLogEventTarget', 'SerializedAuditLogActor'],
      ],
      extraInterfaces: { SerializedAuditLogActor: { fields: liveActorFields } },
    });

    expect(resolveInterfaceName('AuditLogEventActor', c)).toBe('AuditLogActor');
    expect(resolveInterfaceName('AuditLogEventTarget', c)).toBe('AuditLogEventTarget');
  });

  it('prefers the structurally closer claimant over the closer name', () => {
    // Target matches the live shape exactly; actor only shares two fields.
    // Similarity outranks name distance, so target wins even though
    // "AuditLogEventActor" is the closer name.
    const c = auditCtx({
      models: [
        { name: 'AuditLogEventActor', fields: [field('id'), field('name', true), field('ip'), field('agent')] },
        { name: 'AuditLogEventTarget', fields: [field('id'), field('name', true), field('type'), field('metadata')] },
      ],
      modelNameByIR: [
        ['AuditLogEventActor', 'AuditLogActor'],
        ['AuditLogEventTarget', 'AuditLogActor'],
      ],
    });

    expect(resolveInterfaceName('AuditLogEventTarget', c)).toBe('AuditLogActor');
    expect(resolveInterfaceName('AuditLogEventActor', c)).toBe('AuditLogEventActor');
  });

  it('blocks structural claims on names already claimed by an exact-name override', () => {
    const c = auditCtx({
      interfaceByName: [['AuditLogEventActor', 'AuditLogActor']],
      modelNameByIR: [['AuditLogEventTarget', 'AuditLogActor']],
    });

    expect(resolveInterfaceName('AuditLogEventActor', c)).toBe('AuditLogActor');
    expect(resolveInterfaceName('AuditLogEventTarget', c)).toBe('AuditLogEventTarget');
  });

  it('still applies a single-model structural rename (the legitimate overlay case)', () => {
    const c = auditCtx({
      models: [{ name: 'AuditLogEventActor', fields: eventShape('ip_address') }],
      modelNameByIR: [['AuditLogEventActor', 'AuditLogActor']],
    });

    expect(resolveInterfaceName('AuditLogEventActor', c)).toBe('AuditLogActor');
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
