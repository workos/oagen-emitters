import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Service } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateClient } from '../../src/node/client.js';
import { isServiceCoveredByExisting } from '../../src/node/utils.js';

const emptySpec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: 'https://api.workos.com',
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

describe('generateClient', () => {
  it('generates WorkOS client with resource accessors', () => {
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
            response: { kind: 'primitive', type: 'unknown' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const spec: ApiSpec = { ...emptySpec, services, models: [] };
    const ctxWithServices: EmitterContext = { ...ctx, spec };
    const result = generateClient(spec, ctxWithServices);

    const workosFile = result.find((f) => f.path === 'src/workos.ts');
    expect(workosFile).toBeDefined();
    expect(workosFile!.content).toContain('export class WorkOS');
    expect(workosFile!.content).toContain('readonly organizations = new Organizations(this)');
  });

  it('generates barrel exports', () => {
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
            response: { kind: 'primitive', type: 'unknown' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const spec: ApiSpec = { ...emptySpec, services, models: [] };
    const ctxWithServices: EmitterContext = { ...ctx, spec };
    const result = generateClient(spec, ctxWithServices);

    const barrel = result.find((f) => f.path === 'src/index.ts');
    expect(barrel).toBeDefined();
    expect(barrel!.content).toContain("export * from './common/exceptions';");
    expect(barrel!.content).toContain("export { AutoPaginatable } from './common/utils/pagination';");
    expect(barrel!.content).toContain("export { WorkOS } from './workos';");
  });

  it('does not generate package.json or tsconfig.json', () => {
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
            response: { kind: 'primitive', type: 'unknown' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const spec: ApiSpec = { ...emptySpec, services, models: [] };
    const ctxWithServices: EmitterContext = { ...ctx, spec };
    const result = generateClient(spec, ctxWithServices);

    expect(result.every((f) => !f.path.includes('package.json'))).toBe(true);
    expect(result.every((f) => !f.path.includes('tsconfig.json'))).toBe(true);
  });
});

describe('isServiceCoveredByExisting', () => {
  it('returns false when no overlay is provided', () => {
    const service: Service = {
      name: 'Organizations',
      operations: [
        {
          name: 'listOrganizations',
          httpMethod: 'get',
          path: '/organizations',
          pathParams: [],
          queryParams: [],
          headerParams: [],
          response: { kind: 'primitive', type: 'unknown' },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    };
    expect(isServiceCoveredByExisting(service, ctx)).toBe(false);
  });

  it('returns false when overlay is empty', () => {
    const service: Service = {
      name: 'Organizations',
      operations: [
        {
          name: 'listOrganizations',
          httpMethod: 'get',
          path: '/organizations',
          pathParams: [],
          queryParams: [],
          headerParams: [],
          response: { kind: 'primitive', type: 'unknown' },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    };
    const ctxWithOverlay: EmitterContext = {
      ...ctx,
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
    expect(isServiceCoveredByExisting(service, ctxWithOverlay)).toBe(false);
  });

  it('returns false for services with zero operations', () => {
    const service: Service = { name: 'Empty', operations: [] };
    expect(isServiceCoveredByExisting(service, ctx)).toBe(false);
  });

  it('returns false when no apiSurface is provided', () => {
    const service: Service = {
      name: 'Organizations',
      operations: [
        {
          name: 'listOrganizations',
          httpMethod: 'get',
          path: '/organizations',
          pathParams: [],
          queryParams: [],
          headerParams: [],
          response: { kind: 'primitive', type: 'unknown' },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    };
    const ctxWithOverlayNoSurface: EmitterContext = {
      ...ctx,
      overlayLookup: {
        methodByOperation: new Map([
          [
            'GET /organizations',
            {
              className: 'Organizations',
              methodName: 'listOrganizations',
              params: [],
              returnType: 'Promise<AutoPaginatable<Organization>>',
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
    expect(isServiceCoveredByExisting(service, ctxWithOverlayNoSurface)).toBe(false);
  });
});
