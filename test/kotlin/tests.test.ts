import { describe, it, expect } from 'vitest';
import { generateTests } from '../../src/kotlin/tests.js';
import { generateEnums } from '../../src/kotlin/enums.js';
import type { EmitterContext, ApiSpec, Service, Model, ResolvedOperation } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';

const models: Model[] = [
  {
    name: 'Organization',
    fields: [
      { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
      { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
    ],
  },
];

const services: Service[] = [
  {
    name: 'Organizations',
    operations: [
      {
        name: 'getOrganization',
        httpMethod: 'get',
        path: '/organizations/{id}',
        pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
        queryParams: [],
        headerParams: [],
        response: { kind: 'model', name: 'Organization' },
        errors: [],
        injectIdempotencyKey: false,
      },
      {
        name: 'deleteOrganization',
        httpMethod: 'delete',
        path: '/organizations/{id}',
        pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
        queryParams: [],
        headerParams: [],
        response: { kind: 'primitive', type: 'unknown' },
        errors: [],
        injectIdempotencyKey: false,
      },
    ],
  },
];

const spec: ApiSpec = {
  name: 'TestAPI',
  version: '1.0.0',
  baseUrl: 'https://api.workos.com',
  services,
  models,
  enums: [],
  sdk: defaultSdkBehavior(),
};

function buildResolvedOps(services: Service[]): ResolvedOperation[] {
  return services.flatMap((svc) =>
    svc.operations.map((op) => ({
      service: svc,
      operation: op,
      methodName: op.name,
      mountOn: svc.name,
    })),
  ) as ResolvedOperation[];
}

const ctx: EmitterContext = {
  namespace: 'workos',
  namespacePascal: 'WorkOS',
  spec,
  resolvedOperations: buildResolvedOps(services),
};

describe('kotlin/tests', () => {
  it('generates per-mount-group test files', () => {
    generateEnums([], ctx);
    const files = generateTests(spec, ctx);
    const testFile = files.find((f) => f.path.includes('OrganizationsTest.kt'));
    expect(testFile).toBeDefined();

    const content = testFile!.content;
    expect(content).toContain('class OrganizationsTest');
    expect(content).toContain('TestBase');
    expect(content).toContain('@Test');
  });

  it('generates happy-path test for void/delete methods', () => {
    generateEnums([], ctx);
    const files = generateTests(spec, ctx);
    const testFile = files.find((f) => f.path.includes('OrganizationsTest.kt'))!;
    const content = testFile.content;

    // Delete method should have an active test, not a @Disabled placeholder.
    // Method name is trimmed from deleteOrganization -> delete by resolveMethodName.
    expect(content).toContain('delete completes without throwing');
    expect(content).not.toContain('@Disabled("generator: could not synthesize required arguments for delete")');
  });

  it('generates field-value assertions for non-void responses', () => {
    generateEnums([], ctx);
    const files = generateTests(spec, ctx);
    const testFile = files.find((f) => f.path.includes('OrganizationsTest.kt'))!;
    const content = testFile.content;

    // GET method returning Organization should assert field values
    expect(content).toContain('assertEquals("sample", result.id)');
    expect(content).toContain('assertEquals("sample", result.name)');
  });

  it('generates error-mapping tests', () => {
    generateEnums([], ctx);
    const files = generateTests(spec, ctx);
    const testFile = files.find((f) => f.path.includes('OrganizationsTest.kt'))!;
    const content = testFile.content;

    expect(content).toContain('UnauthorizedException');
    expect(content).toContain('NotFoundException');
    expect(content).toContain('RateLimitException');
    expect(content).toContain('GenericServerException');
  });

  it('generates round-trip test using synthJson for broader coverage', () => {
    generateEnums([], ctx);
    const files = generateTests(spec, ctx);
    const roundTrip = files.find((f) => f.path.includes('GeneratedModelRoundTripTest.kt'));
    expect(roundTrip).toBeDefined();

    const content = roundTrip!.content;
    expect(content).toContain('Organization round-trips through Jackson');
    expect(content).toContain('assertEquals(tree1, tree2)');
  });

  it('generates forward-compat test with OffsetDateTime round-trip', () => {
    generateEnums([], ctx);
    const files = generateTests(spec, ctx);
    const fwdCompat = files.find((f) => f.path.includes('GeneratedForwardCompatTest.kt'));
    expect(fwdCompat).toBeDefined();

    const content = fwdCompat!.content;
    expect(content).toContain('OffsetDateTime round-trips');
    expect(content).toContain('assertEquals(parsed.toInstant(), reparsed.toInstant())');
  });

  it('scoped run: round-trip test omits brand-new out-of-scope models, retains on-disk ones', () => {
    const roundTripModel = (name: string): Model => ({
      name,
      fields: [
        { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
        { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
      ],
    });
    const scopedModels: Model[] = [
      roundTripModel('Organization'), // in scope
      roundTripModel('PipesPipe'), // brand-new, out of scope, NOT on disk
      roundTripModel('Directory'), // out of scope but ON disk
    ];
    const scopedSpec: ApiSpec = { ...spec, models: scopedModels };
    const scopedCtx: EmitterContext = {
      ...ctx,
      spec: scopedSpec,
      resolvedOperations: buildResolvedOps(services),
      scopedServices: new Set(['Organizations']),
      scopedModelNames: new Set(['Organization']),
      priorTargetManifestPaths: new Set(['src/main/kotlin/com/workos/models/Directory.kt']),
    };

    generateEnums([], scopedCtx);
    const files = generateTests(scopedSpec, scopedCtx);
    const roundTrip = files.find((f) => f.path.includes('GeneratedModelRoundTripTest.kt'))!;
    const content = roundTrip.content;

    expect(content).toContain('Organization round-trips through Jackson');
    expect(content).toContain('Directory round-trips through Jackson'); // retained (on disk)
    expect(content).not.toContain('PipesPipe round-trips through Jackson'); // omitted (brand-new)
  });

  it('emits valid ISO-8601 for date-time fields in round-trip fixtures', () => {
    const dtModels: Model[] = [
      {
        name: 'Event',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          {
            name: 'created_at',
            type: { kind: 'primitive', type: 'string', format: 'date-time' },
            required: true,
          },
        ],
      },
    ];
    const dtSpec: ApiSpec = { ...spec, models: dtModels };
    const dtCtx: EmitterContext = {
      ...ctx,
      spec: dtSpec,
      resolvedOperations: buildResolvedOps(services),
    };

    generateEnums([], dtCtx);
    const files = generateTests(dtSpec, dtCtx);
    const roundTrip = files.find((f) => f.path.includes('GeneratedModelRoundTripTest.kt'));
    expect(roundTrip).toBeDefined();

    const content = roundTrip!.content;
    // Should use ISO-8601 timestamp, not "sample"
    expect(content).toContain('2024-01-01T00:00:00Z');
    expect(content).not.toMatch(/created_at.*"sample"/);
  });
});
