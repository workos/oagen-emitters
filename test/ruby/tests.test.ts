import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Service, Model, ResolvedOperation } from '@workos/oagen';
import { defaultSdkBehavior, toSnakeCase, toPascalCase } from '@workos/oagen';
import { generateTests } from '../../src/ruby/tests.js';

function makeSpec(services: Service[], models: Model[]): ApiSpec {
  return {
    name: 'Test',
    version: '1.0.0',
    baseUrl: 'https://api.workos.com',
    services,
    models,
    enums: [],
    sdk: defaultSdkBehavior(),
  };
}

function buildResolvedOps(services: Service[]): ResolvedOperation[] {
  const ops: ResolvedOperation[] = [];
  for (const service of services) {
    const mountOn = toPascalCase(service.name);
    for (const op of service.operations) {
      ops.push({
        operation: op,
        service,
        methodName: toSnakeCase(op.name),
        mountOn,
        defaults: {},
        inferFromClient: [],
        urlBuilder: false,
      });
    }
  }
  return ops;
}

const models: Model[] = [
  // In-scope: selected service's model.
  { name: 'Organization', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
  // On-disk: out-of-scope this run, but its file is recorded in the prior manifest.
  { name: 'Connection', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
  // Brand-new out-of-scope: out-of-scope AND not in the prior manifest.
  { name: 'Directory', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
];

const services: Service[] = [
  {
    name: 'Organizations',
    operations: [
      {
        name: 'listOrganizations',
        httpMethod: 'get',
        path: '/organizations',
        pathParams: [],
        queryParams: [],
        headerParams: [],
        response: { kind: 'model', name: 'Organization' },
        errors: [],
        injectIdempotencyKey: false,
      },
    ],
  },
];

const spec = makeSpec(services, models);

const LEGACY_ROUNDTRIP_PATH = 'test/workos/test_model_round_trip.rb';

// The per-dir round-trip files (test/workos/test_<dir>_model_round_trip.rb),
// excluding the pre-split monolith which also ends with _model_round_trip.rb.
function roundTripContent(files: { path: string; content: string }[]): string {
  return files
    .filter((f) => f.path !== LEGACY_ROUNDTRIP_PATH && f.path.endsWith('_model_round_trip.rb'))
    .map((f) => f.content)
    .join('\n');
}

describe('ruby/tests model round-trip per-service scoping', () => {
  it('full run: round-trips every model across per-dir files', () => {
    const ctx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec,
      resolvedOperations: buildResolvedOps(services),
    };
    const combined = roundTripContent(generateTests(spec, ctx));
    expect(combined).toContain('WorkOS::Organization.new');
    expect(combined).toContain('WorkOS::Connection.new');
    expect(combined).toContain('WorkOS::Directory.new');
  });

  it('scoped run: regenerates ONLY the selected service dir round-trip file', () => {
    const ctx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec,
      resolvedOperations: buildResolvedOps(services),
      scopedServices: new Set(['Organizations']),
      scopedModelNames: new Set(['Organization']),
    };

    const files = generateTests(spec, ctx);
    const combined = roundTripContent(files);
    // The selected service's model IS round-trip tested, in lockstep with its
    // regenerated per-model file.
    expect(combined).toContain('WorkOS::Organization.new');
    // Out-of-scope models get no round-trip test — their untouched on-disk
    // models are never asserted against with a fresh (possibly drifted) fixture.
    expect(combined).not.toContain('WorkOS::Connection.new');
    expect(combined).not.toContain('WorkOS::Directory.new');
    // The pre-split monolith is not resurrected when it isn't on disk.
    expect(files.some((f) => f.path === LEGACY_ROUNDTRIP_PATH)).toBe(false);
  });

  it('scoped run: RETAINS an out-of-scope on-disk model sharing a REGENERATED dir', () => {
    // Regression: a dir's aggregate round-trip file is regenerated because ONE
    // of its models (Organization) is in scope; it must NOT be overwritten with
    // only that in-scope subset. The dir's other models — out of scope this run
    // but still on disk (per-model `.rb` untouched, never pruned) — must keep
    // their round-trip coverage. A real batch scoped to user_management deleted
    // ~140 round-trip tests for on-disk models sharing regenerated dirs this way.
    const mkOp = (name: string, path: string, model: string) => ({
      name,
      httpMethod: 'get' as const,
      path,
      pathParams: [{ name: 'id', type: { kind: 'primitive' as const, type: 'string' as const }, required: true }],
      queryParams: [],
      headerParams: [],
      response: { kind: 'model' as const, name: model },
      errors: [],
      injectIdempotencyKey: false,
    });
    const localModels: Model[] = [
      { name: 'Organization', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
      // Out of scope this run, but its per-model file is on disk (prior manifest).
      {
        name: 'OrganizationDomain',
        fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
      // Out of scope AND brand-new (no file on disk) → nothing to test.
      {
        name: 'OrganizationBrandNew',
        fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ];
    const localServices: Service[] = [
      {
        name: 'Organizations',
        operations: [
          mkOp('getOrganization', '/organizations/{id}', 'Organization'),
          mkOp('getOrganizationDomain', '/organizations/domains/{id}', 'OrganizationDomain'),
          mkOp('getOrganizationBrandNew', '/organizations/brand-new/{id}', 'OrganizationBrandNew'),
        ],
      },
    ];
    const localSpec = makeSpec(localServices, localModels);

    // Discover the per-model dir the emitter uses (avoids hard-coding naming
    // internals): find the full-run round-trip file that covers the models.
    const fullFiles = generateTests(localSpec, {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec: localSpec,
      resolvedOperations: buildResolvedOps(localServices),
    } as EmitterContext);
    const rtFull = fullFiles.find(
      (f) => f.path.endsWith('_model_round_trip.rb') && f.content.includes('WorkOS::OrganizationDomain.new'),
    );
    expect(rtFull).toBeDefined();
    const dir = rtFull!.path.replace(/^test\/workos\/test_/, '').replace(/_model_round_trip\.rb$/, '');

    const ctx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec: localSpec,
      resolvedOperations: buildResolvedOps(localServices),
      scopedServices: new Set(['Organizations']),
      scopedModelNames: new Set(['Organization']),
      priorTargetManifestPaths: new Set([
        `lib/workos/${dir}/organization.rb`,
        `lib/workos/${dir}/organization_domain.rb`,
      ]),
    };
    const combined = roundTripContent(generateTests(localSpec, ctx));
    // In-scope model is covered.
    expect(combined).toContain('WorkOS::Organization.new');
    // Out-of-scope model still on disk → coverage retained (the regression).
    expect(combined).toContain('WorkOS::OrganizationDomain.new');
    // Out-of-scope model with no file on disk → no test (no dangling constant).
    expect(combined).not.toContain('WorkOS::OrganizationBrandNew.new');
  });

  it('scoped run: overwrites the pre-split monolith with an inert placeholder while it is on disk', () => {
    const ctx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec,
      resolvedOperations: buildResolvedOps(services),
      scopedServices: new Set(['Organizations']),
      scopedModelNames: new Set(['Organization']),
      priorTargetManifestPaths: new Set([LEGACY_ROUNDTRIP_PATH]),
    };
    const legacy = generateTests(spec, ctx).find((f) => f.path === LEGACY_ROUNDTRIP_PATH);
    expect(legacy).toBeDefined();
    expect(legacy!.content).toContain('moved to per-service');
    // Inert: no test class or methods, so it passes while awaiting pruning.
    expect(legacy!.content).not.toContain('def test_');
    expect(legacy!.content).not.toContain('Minitest::Test');
  });
});
