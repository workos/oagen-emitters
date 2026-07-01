import { describe, it, expect, beforeEach } from 'vitest';
import { dotnetEmitter } from '../../src/dotnet/index.js';
import { generateTests } from '../../src/dotnet/tests.js';
import { discriminatedUnions } from '../../src/dotnet/type-map.js';
import { primeEnumAliases } from '../../src/dotnet/enums.js';
import type { EmitterContext, ApiSpec, Model, Service } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';

/**
 * Scoped (`--services`) runs emit per-model `Entities/*.cs` only for in-scope
 * models, but the polymorphic-dispatch aggregates (discriminated-union JSON
 * converters, per-model test fixtures) were previously built from the FULL
 * spec. A brand-new out-of-scope variant would then be referenced by a
 * converter whose `.cs` file is never emitted (CS0246). These tests assert the
 * `fileExistsAfterRun` gate excludes brand-new out-of-scope items while
 * retaining renamed/removed-but-still-on-disk ones.
 */
const emptySpec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: '',
  services: [],
  models: [],
  enums: [],
  sdk: defaultSdkBehavior(),
};

describe('dotnet/scoped aggregates', () => {
  beforeEach(() => {
    // discriminatedUnions is module-global and accumulates across mapTypeRef
    // calls; clear it so each test sees only the unions it registers.
    discriminatedUnions.clear();
    primeEnumAliases([]);
  });

  it('gates the discriminated-union converter to variants whose .cs exists after a scoped run', () => {
    // Parent model has a field typed as a discriminated union over three
    // event-payload variants:
    //   - UserCreated:             in-scope this run (emitted now)
    //   - OrganizationDomainStandAlone: NOT in scope, but on disk (prior run) → retained
    //   - SessionReauthenticated:  brand-new, NOT in scope, NOT on disk → excluded
    const models: Model[] = [
      {
        name: 'WebhookEnvelope',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          {
            name: 'payload',
            type: {
              kind: 'union',
              variants: [
                { kind: 'model', name: 'UserCreated' },
                { kind: 'model', name: 'OrganizationDomainStandAlone' },
                { kind: 'model', name: 'SessionReauthenticated' },
              ],
              discriminator: {
                property: 'event',
                mapping: {
                  'user.created': 'UserCreated',
                  'organization_domain.verified': 'OrganizationDomainStandAlone',
                  'session.reauthenticated': 'SessionReauthenticated',
                },
              },
            },
            required: true,
          },
        ],
      },
      {
        name: 'UserCreated',
        fields: [{ name: 'user_id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
      {
        name: 'OrganizationDomainStandAlone',
        fields: [{ name: 'domain', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
      {
        name: 'SessionReauthenticated',
        fields: [{ name: 'session_id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ];

    const ctx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec: { ...emptySpec, models },
      // Scoped to the WebhookEnvelope + UserCreated surface only.
      scopedServices: new Set(['Webhooks']),
      scopedModelNames: new Set(['WebhookEnvelope', 'UserCreated']),
      // OrganizationDomainStandAlone exists on disk from a prior full run; the
      // brand-new SessionReauthenticated does not.
      priorTargetManifestPaths: new Set([
        'src/WorkOS.net/Entities/WebhookEnvelope.cs',
        'src/WorkOS.net/Entities/UserCreated.cs',
        'src/WorkOS.net/Entities/OrganizationDomainStandAlone.cs',
      ]),
    };

    const files = dotnetEmitter.generateModels!(models, ctx);
    const converter = files.find((f) => f.path.includes('DiscriminatorConverter.cs'));
    expect(converter).toBeDefined();
    const content = converter!.content;

    // In-scope variant is dispatched.
    expect(content).toContain('case "user.created": return jObject.ToObject<UserCreated>(serializer);');
    // Renamed/removed-but-on-disk variant is retained.
    expect(content).toContain(
      'case "organization_domain.verified": return jObject.ToObject<OrganizationDomainStandAlone>(serializer);',
    );
    // Brand-new out-of-scope variant is EXCLUDED (its .cs is never emitted → CS0246).
    expect(content).not.toContain('SessionReauthenticated');
    expect(content).not.toContain('session.reauthenticated');
  });

  it('emits all converter variants on a full (unscoped) run', () => {
    const models: Model[] = [
      {
        name: 'WebhookEnvelope',
        fields: [
          {
            name: 'payload',
            type: {
              kind: 'union',
              variants: [
                { kind: 'model', name: 'UserCreated' },
                { kind: 'model', name: 'SessionReauthenticated' },
              ],
              discriminator: {
                property: 'event',
                mapping: {
                  'user.created': 'UserCreated',
                  'session.reauthenticated': 'SessionReauthenticated',
                },
              },
            },
            required: true,
          },
        ],
      },
      {
        name: 'UserCreated',
        fields: [{ name: 'user_id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
      {
        name: 'SessionReauthenticated',
        fields: [{ name: 'session_id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ];

    // No scopedServices → full run; every variant is dispatched.
    const ctx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec: { ...emptySpec, models },
    };

    const files = dotnetEmitter.generateModels!(models, ctx);
    const converter = files.find((f) => f.path.includes('DiscriminatorConverter.cs'))!;
    expect(converter.content).toContain('ToObject<UserCreated>');
    expect(converter.content).toContain('ToObject<SessionReauthenticated>');
  });

  it('gates per-model fixtures to SELECTED (in-scope) models only under a scoped run', () => {
    // Minimal scoped generation: a scoped `--services X` run must regenerate
    // ONLY the selected service's fixtures and leave every other service's
    // fixtures byte-for-byte untouched on disk. The fixture gate is therefore
    // SELECTED-only (`isModelInScope`), NOT the SURFACE `fileExistsAfterRun`
    // gate — even an out-of-scope fixture that already sits on disk from a
    // prior full run must be left alone (never re-emitted), so the run cannot
    // rewrite/drift files outside the requested scope.
    const models: Model[] = [
      {
        name: 'OrganizationMembership',
        fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
      {
        name: 'OrganizationDomainStandAlone',
        fields: [{ name: 'domain', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
      {
        name: 'SessionReauthenticated',
        fields: [{ name: 'session_id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ];

    const services: Service[] = [
      {
        name: 'OrganizationMemberships',
        operations: [
          {
            name: 'getOrganizationMembership',
            httpMethod: 'get',
            path: '/organization_memberships/{id}',
            pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model', name: 'OrganizationMembership' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const spec: ApiSpec = { ...emptySpec, services, models };
    const ctx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec,
      scopedServices: new Set(['OrganizationMemberships']),
      scopedModelNames: new Set(['OrganizationMembership']),
      // OrganizationDomainStandAlone already sits on disk from a prior full
      // run, but it is OUT OF SCOPE this run — a minimal scoped run must NOT
      // re-emit it.
      priorTargetManifestPaths: new Set([
        'test/WorkOSTests/testdata/organization_membership.json',
        'test/WorkOSTests/testdata/organization_domain_stand_alone.json',
      ]),
    };

    const files = generateTests(spec, ctx);
    const paths = files.map((f) => f.path);

    // In-scope (SELECTED) model fixture is emitted.
    expect(paths).toContain('testdata/organization_membership.json');
    // Out-of-scope fixture already on disk is LEFT UNTOUCHED (not re-emitted).
    expect(paths.some((p) => p.includes('organization_domain_stand_alone'))).toBe(false);
    // Brand-new out-of-scope fixture is EXCLUDED (never in scope).
    expect(paths.some((p) => p.includes('session_reauthenticated'))).toBe(false);
  });

  it('does not emit a monolithic model round-trip test under a scoped run', () => {
    // Unlike some emitters (e.g. Ruby's GeneratedModelRoundTrip aggregate),
    // the .NET emitter has no wholesale model-round-trip test file: round-trip
    // coverage is inlined into each per-service `Tests/*Test.cs` file, which is
    // already scoped via `scopedMountGroups`. So a scoped run must emit ONLY
    // the selected service's test file and no cross-service aggregate.
    const models: Model[] = [
      {
        name: 'OrganizationMembership',
        fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
      {
        name: 'SessionReauthenticated',
        fields: [{ name: 'session_id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ];

    const services: Service[] = [
      {
        name: 'OrganizationMemberships',
        operations: [
          {
            name: 'getOrganizationMembership',
            httpMethod: 'get',
            path: '/organization_memberships/{id}',
            pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model', name: 'OrganizationMembership' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const spec: ApiSpec = { ...emptySpec, services, models };
    const ctx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec,
      scopedServices: new Set(['OrganizationMemberships']),
      scopedModelNames: new Set(['OrganizationMembership']),
      // Minimal resolvedOperations table so scopedMountGroups can group the
      // selected service by mount target.
      resolvedOperations: services.flatMap((service) =>
        service.operations.map((operation) => ({
          service,
          operation,
          methodName: operation.name,
          mountOn: service.name,
          defaults: {},
          inferFromClient: [],
          urlBuilder: false,
        })),
      ),
    };

    const files = generateTests(spec, ctx);
    const csTestFiles = files.filter((f) => f.path.startsWith('Tests/') && f.path.endsWith('.cs'));

    // Only the selected service's test file is emitted...
    expect(csTestFiles.map((f) => f.path)).toEqual(['Tests/OrganizationMembershipsServiceTest.cs']);
    // ...and there is no aggregate/wholesale round-trip test file.
    expect(files.some((f) => /RoundTrip/i.test(f.path))).toBe(false);
  });

  it('emits all per-model fixtures on a full (unscoped) run', () => {
    const models: Model[] = [
      {
        name: 'OrganizationMembership',
        fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
      {
        name: 'SessionReauthenticated',
        fields: [{ name: 'session_id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ];
    const spec: ApiSpec = { ...emptySpec, models };
    const ctx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec,
    };

    const files = generateTests(spec, ctx);
    const paths = files.map((f) => f.path);
    expect(paths).toContain('testdata/organization_membership.json');
    expect(paths.some((p) => p.includes('session_reauthenticated'))).toBe(true);
  });
});
