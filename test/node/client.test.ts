import { describe, it, expect } from 'vitest';
import { generateClient } from '../../src/node/client.js';
import { isServiceCoveredByExisting } from '../../src/node/utils.js';
import type { EmitterContext, ApiSpec, Service, Model, Enum } from '@workos/oagen';
import type { ApiSurface } from '@workos/oagen/compat';

const service: Service = {
  name: 'Organizations',
  operations: [
    {
      name: 'getOrganization',
      httpMethod: 'get',
      path: '/organizations/{id}',
      pathParams: [
        {
          name: 'id',
          type: { kind: 'primitive', type: 'string' },
          required: true,
        },
      ],
      queryParams: [],
      headerParams: [],
      response: { kind: 'model', name: 'Organization' },
      errors: [],
      injectIdempotencyKey: false,
    },
  ],
};

const model: Model = {
  name: 'Organization',
  fields: [
    { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
    {
      name: 'name',
      type: { kind: 'primitive', type: 'string' },
      required: true,
    },
  ],
};

const spec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: 'https://api.example.com',
  services: [service],
  models: [model],
  enums: [],
};

const ctx: EmitterContext = {
  namespace: 'workos',
  namespacePascal: 'WorkOS',
  spec,
};

describe('generateClient', () => {
  it('generates WorkOS client with resource accessors', () => {
    const files = generateClient(spec, ctx);
    const workosFile = files.find((f) => f.path === 'src/workos.ts');
    expect(workosFile).toBeDefined();

    const content = workosFile!.content;
    expect(content).toContain('export class WorkOS extends WorkOSBase {');
    expect(content).toContain('readonly organizations = new Organizations(this);');
    expect(content).toContain("import { WorkOSBase } from './common/workos-base';");
  });

  it('allows workos.ts to participate in integration (no integrateTarget: false)', () => {
    const files = generateClient(spec, ctx);
    const workosFile = files.find((f) => f.path === 'src/workos.ts');
    expect(workosFile).toBeDefined();
    expect(workosFile!.integrateTarget).not.toBe(false);
  });

  it('generates barrel exports', () => {
    const files = generateClient(spec, ctx);
    const barrel = files.find((f) => f.path === 'src/index.ts');
    expect(barrel).toBeDefined();

    const content = barrel!.content;
    expect(content).toContain("export * from './common/exceptions';");
    expect(content).toContain("export { AutoPaginatable } from './common/utils/pagination';");
    expect(content).toContain("export { WorkOS } from './workos';");
    // Service types are now re-exported via the service barrel
    expect(content).toContain("export * from './organizations/interfaces';");
    expect(content).not.toContain('export type { Organization, OrganizationResponse }');
    expect(content).toContain("export { Organizations } from './organizations/organizations';");
  });

  it('generates per-service barrel files', () => {
    const files = generateClient(spec, ctx);
    const serviceBarrel = files.find((f) => f.path === 'src/organizations/interfaces/index.ts');
    expect(serviceBarrel).toBeDefined();

    const content = serviceBarrel!.content;
    expect(content).toContain("export * from './organization.interface';");
    expect(serviceBarrel!.skipIfExists).toBe(true);
  });

  it('generates package.json and tsconfig.json', () => {
    const files = generateClient(spec, ctx);
    const pkg = files.find((f) => f.path === 'package.json');
    const tsconfig = files.find((f) => f.path === 'tsconfig.json');

    expect(pkg).toBeDefined();
    expect(pkg!.skipIfExists).toBe(true);

    expect(tsconfig).toBeDefined();
    expect(tsconfig!.skipIfExists).toBe(true);
  });

  it('uses overlay-resolved names for imports and accessors', () => {
    const mfaService: Service = {
      name: 'Billing',
      operations: [
        {
          name: 'enrollFactor',
          httpMethod: 'post',
          path: '/auth/factors/enroll',
          pathParams: [],
          queryParams: [],
          headerParams: [],
          response: { kind: 'model', name: 'AuthenticationFactor' },
          errors: [],
          injectIdempotencyKey: true,
        },
      ],
    };

    const mfaModel: Model = {
      name: 'AuthenticationFactor',
      fields: [
        {
          name: 'id',
          type: { kind: 'primitive', type: 'string' },
          required: true,
        },
      ],
    };

    const overlaySpec: ApiSpec = {
      name: 'Test',
      version: '1.0.0',
      baseUrl: 'https://api.example.com',
      services: [mfaService],
      models: [mfaModel],
      enums: [],
    };

    const overlayCtx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec: overlaySpec,
      overlayLookup: {
        methodByOperation: new Map([
          [
            'POST /auth/factors/enroll',
            {
              className: 'Mfa',
              methodName: 'enrollFactor',
              params: [],
              returnType: 'void',
            },
          ],
        ]),
        httpKeyByMethod: new Map(),
        interfaceByName: new Map(),
        typeAliasByName: new Map(),
        requiredExports: new Map(),
        modelNameByIR: new Map(),
        fileBySymbol: new Map(),
      },
    };

    const files = generateClient(overlaySpec, overlayCtx);
    const workosFile = files.find((f) => f.path === 'src/workos.ts');
    expect(workosFile).toBeDefined();

    const content = workosFile!.content;
    // Import path uses resolved name
    expect(content).toContain("from './mfa/mfa'");
    // Property uses resolved name
    expect(content).toContain('readonly mfa = new Mfa(this);');

    const barrel = files.find((f) => f.path === 'src/index.ts');
    expect(barrel).toBeDefined();
    // Barrel export uses resolved name for resource class
    expect(barrel!.content).toContain("from './mfa/mfa'");
    // Service barrel uses resolved directory name
    expect(barrel!.content).toContain("export * from './mfa/interfaces'");

    // Per-service barrel is generated with resolved directory
    const serviceBarrel = files.find((f) => f.path === 'src/mfa/interfaces/index.ts');
    expect(serviceBarrel).toBeDefined();
    expect(serviceBarrel!.content).toContain("export * from './authentication-factor.interface';");
  });

  it('does not generate error handling in WorkOS client (lives in WorkOSBase)', () => {
    const files = generateClient(spec, ctx);
    const workosFile = files.find((f) => f.path === 'src/workos.ts')!;
    const content = workosFile.content;

    expect(content).not.toContain('handleHttpError');
    expect(content).not.toContain('UnauthorizedException');
    expect(content).not.toContain('NotFoundException');
  });

  it('skips explicit model export when name is already in apiSurface.exports', () => {
    // Simulates the Event shadowing bug: the existing SDK already exports "Event"
    // via a wildcard re-export (e.g., a hand-written 60+ member discriminated union).
    // The barrel must not emit an explicit `export type { Event }` that would shadow it.
    const eventService: Service = {
      name: 'Events',
      operations: [
        {
          name: 'listEvents',
          httpMethod: 'get',
          path: '/events',
          pathParams: [],
          queryParams: [],
          headerParams: [],
          response: { kind: 'model', name: 'Event' },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    };

    const eventModel: Model = {
      name: 'Event',
      fields: [
        {
          name: 'id',
          type: { kind: 'primitive', type: 'string' },
          required: true,
        },
        {
          name: 'event',
          type: { kind: 'primitive', type: 'string' },
          required: true,
        },
      ],
    };

    const otherModel: Model = {
      name: 'EventCursor',
      fields: [
        {
          name: 'cursor',
          type: { kind: 'primitive', type: 'string' },
          required: true,
        },
      ],
    };

    const eventSpec: ApiSpec = {
      name: 'Test',
      version: '1.0.0',
      baseUrl: 'https://api.example.com',
      services: [eventService],
      models: [eventModel, otherModel],
      enums: [],
    };

    const surface: ApiSurface = {
      language: 'node',
      extractedFrom: '/tmp/test-sdk',
      extractedAt: '2025-01-01T00:00:00Z',
      classes: {},
      interfaces: {
        Event: {
          name: 'Event',
          sourceFile: 'src/common/interfaces/event.interface.ts',
          fields: {},
          extends: [],
        },
      },
      typeAliases: {},
      enums: {},
      // The existing SDK's barrel re-exports "Event" via a wildcard chain
      exports: {
        'src/common/interfaces/event.interface.ts': ['Event'],
        'src/index.ts': ['Event', 'WorkOS', 'Events'],
      },
    };

    const eventCtx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec: eventSpec,
      apiSurface: surface,
    };

    const files = generateClient(eventSpec, eventCtx);
    const barrel = files.find((f) => f.path === 'src/index.ts')!;
    const content = barrel.content;

    // Event must NOT appear as an explicit named export — it would shadow the wildcard
    expect(content).not.toContain('export type { Event,');
    expect(content).not.toContain('export type { Event }');

    // EventCursor is NOT in apiSurface.exports, so it should still be exported
    // (via common barrel wildcard since it's unassigned to any service)
    expect(content).toContain("export * from './common/interfaces'");

    // The resource class export should still be present
    expect(content).toContain("export { Events } from './events/events'");
  });

  it('skips explicit enum export when name is already in apiSurface.exports', () => {
    const enumSpec: ApiSpec = {
      name: 'Test',
      version: '1.0.0',
      baseUrl: 'https://api.example.com',
      services: [service],
      models: [model],
      enums: [
        {
          name: 'EventType',
          values: [
            { name: 'CONNECTION_ACTIVATED', value: 'connection.activated' },
            { name: 'CONNECTION_DELETED', value: 'connection.deleted' },
          ],
        },
      ],
    };

    const surface: ApiSurface = {
      language: 'node',
      extractedFrom: '/tmp/test-sdk',
      extractedAt: '2025-01-01T00:00:00Z',
      classes: {},
      interfaces: {},
      typeAliases: {},
      enums: {},
      exports: {
        'src/common/interfaces/event-type.interface.ts': ['EventType'],
      },
    };

    const enumCtx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec: enumSpec,
      apiSurface: surface,
    };

    const files = generateClient(enumSpec, enumCtx);
    const barrel = files.find((f) => f.path === 'src/index.ts')!;

    // EventType should NOT appear as an explicit export — already covered by wildcard
    expect(barrel.content).not.toContain('export type { EventType }');
  });

  it('emits model exports normally when no apiSurface is present', () => {
    // Without apiSurface, all models should be exported via service barrel
    const files = generateClient(spec, ctx);
    const barrel = files.find((f) => f.path === 'src/index.ts')!;
    expect(barrel.content).toContain("export * from './organizations/interfaces'");
  });

  it('renders spec.description as JSDoc on WorkOS class', () => {
    const specWithDesc: ApiSpec = {
      ...spec,
      description: 'The WorkOS API provides a unified interface for enterprise features.',
    };

    const descCtx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec: specWithDesc,
    };

    const files = generateClient(specWithDesc, descCtx);
    const workosFile = files.find((f) => f.path === 'src/workos.ts')!;
    const content = workosFile.content;

    expect(content).toContain('/** The WorkOS API provides a unified interface for enterprise features. */');
    expect(content).toContain('export class WorkOS extends WorkOSBase {');
  });

  it('uses value export for baseline TS enums and type export for type aliases', () => {
    const enumDef: Enum = {
      name: 'ConnectionType',
      values: [
        { name: 'ADFSSAML', value: 'ADFSSAML' },
        { name: 'GoogleOAuth', value: 'GoogleOAuth' },
      ],
    };
    const aliasEnumDef: Enum = {
      name: 'DirectoryState',
      values: [
        { name: 'active', value: 'active' },
        { name: 'inactive', value: 'inactive' },
      ],
    };
    const enumService: Service = {
      name: 'Payments',
      operations: [
        {
          name: 'listPayments',
          httpMethod: 'get',
          path: '/payments',
          pathParams: [],
          queryParams: [
            {
              name: 'type',
              type: {
                kind: 'enum',
                name: 'ConnectionType',
                values: ['ADFSSAML', 'GoogleOAuth'],
              },
              required: false,
            },
          ],
          headerParams: [],
          response: { kind: 'model', name: 'Organization' },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    };
    const dirService: Service = {
      name: 'Invoices',
      operations: [
        {
          name: 'listInvoices',
          httpMethod: 'get',
          path: '/invoices',
          pathParams: [],
          queryParams: [
            {
              name: 'state',
              type: {
                kind: 'enum',
                name: 'DirectoryState',
                values: ['active', 'inactive'],
              },
              required: false,
            },
          ],
          headerParams: [],
          response: { kind: 'model', name: 'Organization' },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    };
    const enumSpec: ApiSpec = {
      name: 'Test',
      version: '1.0.0',
      baseUrl: 'https://api.example.com',
      services: [service, enumService, dirService],
      models: [model],
      enums: [enumDef, aliasEnumDef],
    };
    const enumCtx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec: enumSpec,
      apiSurface: {
        language: 'node',
        extractedFrom: 'test',
        extractedAt: '2024-01-01',
        interfaces: {},
        classes: {},
        enums: {
          ConnectionType: {
            name: 'ConnectionType',
            members: { ADFSSAML: 'ADFSSAML', GoogleOAuth: 'GoogleOAuth' },
          },
        },
        typeAliases: {},
        exports: {},
      },
    };

    const files = generateClient(enumSpec, enumCtx);
    const barrel = files.find((f) => f.path === 'src/index.ts');
    expect(barrel).toBeDefined();

    const content = barrel!.content;
    // Both enums are now re-exported via per-service barrel wildcards
    expect(content).toContain("export * from './payments/interfaces'");
    expect(content).toContain("export * from './invoices/interfaces'");
    // Individual enum exports should NOT appear (covered by wildcard)
    expect(content).not.toContain('export { ConnectionType }');
    expect(content).not.toContain('export type { InvoiceState }');
  });

  it('skips services whose endpoints are fully covered by existing hand-written services', () => {
    const connectionsService: Service = {
      name: 'Payments',
      operations: [
        {
          name: 'listPayments',
          httpMethod: 'get',
          path: '/payments',
          pathParams: [],
          queryParams: [],
          headerParams: [],
          response: { kind: 'model', name: 'ConnectionList' },
          errors: [],
          injectIdempotencyKey: false,
        },
        {
          name: 'getConnection',
          httpMethod: 'get',
          path: '/payments/{id}',
          pathParams: [
            {
              name: 'id',
              type: { kind: 'primitive', type: 'string' },
              required: true,
            },
          ],
          queryParams: [],
          headerParams: [],
          response: { kind: 'model', name: 'Connection' },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    };

    const connectionModel: Model = {
      name: 'Connection',
      fields: [
        {
          name: 'id',
          type: { kind: 'primitive', type: 'string' },
          required: true,
        },
        {
          name: 'name',
          type: { kind: 'primitive', type: 'string' },
          required: true,
        },
      ],
    };

    const radarService: Service = {
      name: 'Radar',
      operations: [
        {
          name: 'assess',
          httpMethod: 'post',
          path: '/radar/assess',
          pathParams: [],
          queryParams: [],
          headerParams: [],
          response: { kind: 'model', name: 'RadarResult' },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    };

    const radarModel: Model = {
      name: 'RadarResult',
      fields: [
        {
          name: 'score',
          type: { kind: 'primitive', type: 'number' },
          required: true,
        },
      ],
    };

    const coveredSpec: ApiSpec = {
      name: 'Test',
      version: '1.0.0',
      baseUrl: 'https://api.example.com',
      services: [connectionsService, radarService],
      models: [connectionModel, radarModel],
      enums: [],
    };

    const coveredCtx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec: coveredSpec,
      apiSurface: {
        language: 'node',
        extractedFrom: 'test',
        extractedAt: '2024-01-01',
        interfaces: {},
        classes: {
          Sso: {
            name: 'Sso',
            methods: {
              listConnections: [
                {
                  name: 'listConnections',
                  params: [],
                  returnType: 'Promise<AutoPaginatable<Connection>>',
                  async: true,
                },
              ],
              getConnection: [
                {
                  name: 'getConnection',
                  params: [{ name: 'id', type: 'string', optional: false }],
                  returnType: 'Promise<Connection>',
                  async: true,
                },
              ],
            },
            properties: {},
            constructorParams: [],
          },
        },
        enums: {},
        typeAliases: {},
        exports: {},
      },
      overlayLookup: {
        methodByOperation: new Map([
          [
            'GET /connections',
            {
              className: 'Sso',
              methodName: 'listConnections',
              params: [],
              returnType: 'Promise<AutoPaginatable<Connection>>',
            },
          ],
          [
            'GET /connections/{id}',
            {
              className: 'Sso',
              methodName: 'getConnection',
              params: [{ name: 'id', type: 'string', optional: false }],
              returnType: 'Promise<Connection>',
            },
          ],
        ]),
        httpKeyByMethod: new Map(),
        interfaceByName: new Map(),
        typeAliasByName: new Map(),
        requiredExports: new Map(),
        modelNameByIR: new Map(),
        fileBySymbol: new Map(),
      },
    };

    const files = generateClient(coveredSpec, coveredCtx);
    const workosFile = files.find((f) => f.path === 'src/workos.ts')!;
    const content = workosFile.content;

    // Connections service should NOT appear (fully covered by Sso in baseline)
    expect(content).not.toContain('Connections');
    expect(content).not.toContain("from './sso/sso'");

    // Radar service should still appear (not covered)
    expect(content).toContain('readonly radar = new Radar(this);');
    expect(content).toContain("import { Radar } from './radar/radar';");

    // Barrel should also skip the Connections resource class export
    const barrel = files.find((f) => f.path === 'src/index.ts')!;
    const barrelContent = barrel.content;
    expect(barrelContent).not.toContain('export { Sso }');
    expect(barrelContent).not.toContain('export { Connections }');

    // Covered services don't generate barrel exports — their types are
    // already exported by the hand-written service's own barrel.
    expect(barrelContent).not.toContain("export * from './sso/interfaces'");
  });

  it('does not skip services when only some operations are covered', () => {
    const partialService: Service = {
      name: 'Invoices',
      operations: [
        {
          name: 'listInvoices',
          httpMethod: 'get',
          path: '/invoices',
          pathParams: [],
          queryParams: [],
          headerParams: [],
          response: { kind: 'model', name: 'DirectoryList' },
          errors: [],
          injectIdempotencyKey: false,
        },
        {
          name: 'createInvoice',
          httpMethod: 'post',
          path: '/invoices',
          pathParams: [],
          queryParams: [],
          headerParams: [],
          response: { kind: 'model', name: 'Invoice' },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    };

    const dirModel: Model = {
      name: 'Invoice',
      fields: [
        {
          name: 'id',
          type: { kind: 'primitive', type: 'string' },
          required: true,
        },
      ],
    };

    const partialSpec: ApiSpec = {
      name: 'Test',
      version: '1.0.0',
      baseUrl: 'https://api.example.com',
      services: [partialService],
      models: [dirModel],
      enums: [],
    };

    const partialCtx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec: partialSpec,
      apiSurface: {
        language: 'node',
        extractedFrom: 'test',
        extractedAt: '2024-01-01',
        interfaces: {},
        classes: {
          Billing: {
            name: 'Billing',
            methods: {
              listInvoices: [
                {
                  name: 'listInvoices',
                  params: [],
                  returnType: 'Promise<AutoPaginatable<Invoice>>',
                  async: true,
                },
              ],
            },
            properties: {},
            constructorParams: [],
          },
        },
        enums: {},
        typeAliases: {},
        exports: {},
      },
      overlayLookup: {
        methodByOperation: new Map([
          [
            'GET /invoices',
            {
              className: 'Billing',
              methodName: 'listInvoices',
              params: [],
              returnType: 'Promise<AutoPaginatable<Invoice>>',
            },
          ],
        ]),
        httpKeyByMethod: new Map(),
        interfaceByName: new Map(),
        typeAliasByName: new Map(),
        requiredExports: new Map(),
        modelNameByIR: new Map(),
        fileBySymbol: new Map(),
      },
    };

    const files = generateClient(partialSpec, partialCtx);
    const workosFile = files.find((f) => f.path === 'src/workos.ts')!;
    const content = workosFile.content;

    // Service should still be generated because it has an uncovered operation
    expect(content).toContain('Billing');
  });

  it('does not skip services when no overlay is provided', () => {
    const files = generateClient(spec, ctx);
    const workosFile = files.find((f) => f.path === 'src/workos.ts')!;
    expect(workosFile.content).toContain('readonly organizations = new Organizations(this);');
  });

  it('does not skip services when overlay exists but no apiSurface baseline', () => {
    const mfaService: Service = {
      name: 'Analytics',
      operations: [
        {
          name: 'enrollFactor',
          httpMethod: 'post',
          path: '/auth/factors/enroll',
          pathParams: [],
          queryParams: [],
          headerParams: [],
          response: { kind: 'model', name: 'AuthenticationFactor' },
          errors: [],
          injectIdempotencyKey: true,
        },
      ],
    };

    const mfaModel: Model = {
      name: 'AuthenticationFactor',
      fields: [
        {
          name: 'id',
          type: { kind: 'primitive', type: 'string' },
          required: true,
        },
      ],
    };

    const mfaSpec: ApiSpec = {
      name: 'Test',
      version: '1.0.0',
      baseUrl: 'https://api.example.com',
      services: [mfaService],
      models: [mfaModel],
      enums: [],
    };

    const namingOnlyCtx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec: mfaSpec,
      overlayLookup: {
        methodByOperation: new Map([
          [
            'POST /auth/factors/enroll',
            {
              className: 'Analytics',
              methodName: 'enrollFactor',
              params: [],
              returnType: 'void',
            },
          ],
        ]),
        httpKeyByMethod: new Map(),
        interfaceByName: new Map(),
        typeAliasByName: new Map(),
        requiredExports: new Map(),
        modelNameByIR: new Map(),
        fileBySymbol: new Map(),
      },
    };

    const files = generateClient(mfaSpec, namingOnlyCtx);
    const workosFile = files.find((f) => f.path === 'src/workos.ts')!;
    expect(workosFile.content).toContain('readonly analytics = new Analytics(this);');
  });
});

describe('isServiceCoveredByExisting', () => {
  const emptySpec: ApiSpec = {
    name: 'Test',
    version: '1.0.0',
    baseUrl: '',
    services: [],
    models: [],
    enums: [],
  };

  it('returns false when no overlay is provided', () => {
    const svc: Service = {
      name: 'Payments',
      operations: [
        {
          name: 'listPayments',
          httpMethod: 'get',
          path: '/payments',
          pathParams: [],
          queryParams: [],
          headerParams: [],
          response: { kind: 'model', name: 'ConnectionList' },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    };
    const noOverlayCtx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec: emptySpec,
    };
    expect(isServiceCoveredByExisting(svc, noOverlayCtx)).toBe(false);
  });

  it('returns false when overlay is empty', () => {
    const svc: Service = {
      name: 'Payments',
      operations: [
        {
          name: 'listPayments',
          httpMethod: 'get',
          path: '/payments',
          pathParams: [],
          queryParams: [],
          headerParams: [],
          response: { kind: 'model', name: 'ConnectionList' },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    };
    const emptyOverlayCtx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec: emptySpec,
      overlayLookup: {
        methodByOperation: new Map(),
        httpKeyByMethod: new Map(),
        interfaceByName: new Map(),
        typeAliasByName: new Map(),
        requiredExports: new Map(),
        modelNameByIR: new Map(),
        fileBySymbol: new Map(),
      },
    };
    expect(isServiceCoveredByExisting(svc, emptyOverlayCtx)).toBe(false);
  });

  it('returns true when all operations are covered by overlay and class exists in baseline', () => {
    const svc: Service = {
      name: 'Connections',
      operations: [
        {
          name: 'listConnections',
          httpMethod: 'get',
          path: '/connections',
          pathParams: [],
          queryParams: [],
          headerParams: [],
          response: { kind: 'model', name: 'ConnectionList' },
          errors: [],
          injectIdempotencyKey: false,
        },
        {
          name: 'getConnection',
          httpMethod: 'get',
          path: '/connections/{id}',
          pathParams: [
            {
              name: 'id',
              type: { kind: 'primitive', type: 'string' },
              required: true,
            },
          ],
          queryParams: [],
          headerParams: [],
          response: { kind: 'model', name: 'Connection' },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    };
    const fullCoverageCtx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec: emptySpec,
      apiSurface: {
        language: 'node',
        extractedFrom: 'test',
        extractedAt: '2024-01-01',
        interfaces: {},
        classes: {
          Sso: {
            name: 'Sso',
            methods: {},
            properties: {},
            constructorParams: [],
          },
        },
        enums: {},
        typeAliases: {},
        exports: {},
      },
      overlayLookup: {
        methodByOperation: new Map([
          [
            'GET /connections',
            {
              className: 'Sso',
              methodName: 'listConnections',
              params: [],
              returnType: 'Promise<AutoPaginatable<Connection>>',
            },
          ],
          [
            'GET /connections/{id}',
            {
              className: 'Sso',
              methodName: 'getConnection',
              params: [{ name: 'id', type: 'string', optional: false }],
              returnType: 'Promise<Connection>',
            },
          ],
        ]),
        httpKeyByMethod: new Map(),
        interfaceByName: new Map(),
        typeAliasByName: new Map(),
        requiredExports: new Map(),
        modelNameByIR: new Map(),
        fileBySymbol: new Map(),
      },
    };
    expect(isServiceCoveredByExisting(svc, fullCoverageCtx)).toBe(true);
  });

  it('returns false when only some operations are covered', () => {
    const svc: Service = {
      name: 'Invoices',
      operations: [
        {
          name: 'listInvoices',
          httpMethod: 'get',
          path: '/invoices',
          pathParams: [],
          queryParams: [],
          headerParams: [],
          response: { kind: 'model', name: 'DirectoryList' },
          errors: [],
          injectIdempotencyKey: false,
        },
        {
          name: 'createInvoice',
          httpMethod: 'post',
          path: '/invoices',
          pathParams: [],
          queryParams: [],
          headerParams: [],
          response: { kind: 'model', name: 'Invoice' },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    };
    const partialCtx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec: emptySpec,
      apiSurface: {
        language: 'node',
        extractedFrom: 'test',
        extractedAt: '2024-01-01',
        interfaces: {},
        classes: {
          Billing: {
            name: 'Billing',
            methods: {},
            properties: {},
            constructorParams: [],
          },
        },
        enums: {},
        typeAliases: {},
        exports: {},
      },
      overlayLookup: {
        methodByOperation: new Map([
          [
            'GET /invoices',
            {
              className: 'Billing',
              methodName: 'listInvoices',
              params: [],
              returnType: 'Promise<AutoPaginatable<Directory>>',
            },
          ],
        ]),
        httpKeyByMethod: new Map(),
        interfaceByName: new Map(),
        typeAliasByName: new Map(),
        requiredExports: new Map(),
        modelNameByIR: new Map(),
        fileBySymbol: new Map(),
      },
    };
    expect(isServiceCoveredByExisting(svc, partialCtx)).toBe(false);
  });

  it('returns false for services with zero operations', () => {
    const emptySvc: Service = {
      name: 'Empty',
      operations: [],
    };
    const overlayCtx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec: emptySpec,
      apiSurface: {
        language: 'node',
        extractedFrom: 'test',
        extractedAt: '2024-01-01',
        interfaces: {},
        classes: {
          Other: {
            name: 'Other',
            methods: {},
            properties: {},
            constructorParams: [],
          },
        },
        enums: {},
        typeAliases: {},
        exports: {},
      },
      overlayLookup: {
        methodByOperation: new Map([
          [
            'GET /something',
            {
              className: 'Other',
              methodName: 'doSomething',
              params: [],
              returnType: 'void',
            },
          ],
        ]),
        httpKeyByMethod: new Map(),
        interfaceByName: new Map(),
        typeAliasByName: new Map(),
        requiredExports: new Map(),
        modelNameByIR: new Map(),
        fileBySymbol: new Map(),
      },
    };
    expect(isServiceCoveredByExisting(emptySvc, overlayCtx)).toBe(false);
  });

  it('returns false when overlay covers operations but target class is not in baseline', () => {
    const svc: Service = {
      name: 'Payments',
      operations: [
        {
          name: 'listPayments',
          httpMethod: 'get',
          path: '/payments',
          pathParams: [],
          queryParams: [],
          headerParams: [],
          response: { kind: 'model', name: 'ConnectionList' },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    };
    const missingClassCtx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec: emptySpec,
      apiSurface: {
        language: 'node',
        extractedFrom: 'test',
        extractedAt: '2024-01-01',
        interfaces: {},
        classes: {},
        enums: {},
        typeAliases: {},
        exports: {},
      },
      overlayLookup: {
        methodByOperation: new Map([
          [
            'GET /payments',
            {
              className: 'Sso',
              methodName: 'listPayments',
              params: [],
              returnType: 'Promise<AutoPaginatable<Connection>>',
            },
          ],
        ]),
        httpKeyByMethod: new Map(),
        interfaceByName: new Map(),
        typeAliasByName: new Map(),
        requiredExports: new Map(),
        modelNameByIR: new Map(),
        fileBySymbol: new Map(),
      },
    };
    expect(isServiceCoveredByExisting(svc, missingClassCtx)).toBe(false);
  });

  it('returns false when no apiSurface is provided', () => {
    const svc: Service = {
      name: 'Payments',
      operations: [
        {
          name: 'listPayments',
          httpMethod: 'get',
          path: '/payments',
          pathParams: [],
          queryParams: [],
          headerParams: [],
          response: { kind: 'model', name: 'ConnectionList' },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    };
    const noSurfaceCtx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec: emptySpec,
      overlayLookup: {
        methodByOperation: new Map([
          [
            'GET /payments',
            {
              className: 'Sso',
              methodName: 'listPayments',
              params: [],
              returnType: 'Promise<AutoPaginatable<Connection>>',
            },
          ],
        ]),
        httpKeyByMethod: new Map(),
        interfaceByName: new Map(),
        typeAliasByName: new Map(),
        requiredExports: new Map(),
        modelNameByIR: new Map(),
        fileBySymbol: new Map(),
      },
    };
    expect(isServiceCoveredByExisting(svc, noSurfaceCtx)).toBe(false);
  });
});
