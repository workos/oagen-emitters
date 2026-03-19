import { describe, it, expect } from 'vitest';
import { generateClient } from '../../src/node/client.js';
import type { EmitterContext, ApiSpec, Service, Model } from '@workos/oagen';

const service: Service = {
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
  ],
};

const model: Model = {
  name: 'Organization',
  fields: [
    { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
    { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
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
  irVersion: 6,
};

describe('generateClient', () => {
  it('generates WorkOS client with resource accessors', () => {
    const files = generateClient(spec, ctx);
    const workosFile = files.find((f) => f.path === 'src/workos.ts');
    expect(workosFile).toBeDefined();

    const content = workosFile!.content;
    expect(content).toContain('export class WorkOS {');
    expect(content).toContain('readonly organizations = new Organizations(this);');
    expect(content).toContain('async get<Result');
    expect(content).toContain('async post<Result');
    expect(content).toContain('async delete(');
  });

  it('generates barrel exports', () => {
    const files = generateClient(spec, ctx);
    const barrel = files.find((f) => f.path === 'src/index.ts');
    expect(barrel).toBeDefined();

    const content = barrel!.content;
    expect(content).toContain("export * from './common/exceptions';");
    expect(content).toContain("export { AutoPaginatable } from './common/utils/pagination';");
    expect(content).toContain("export { WorkOS } from './workos';");
    expect(content).toContain('export type { Organization, OrganizationResponse }');
    expect(content).toContain("export { Organizations } from './organizations/organizations';");
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
      name: 'MultiFactorAuth',
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
      fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
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
      irVersion: 6,
      overlayLookup: {
        methodByOperation: new Map([
          [
            'POST /auth/factors/enroll',
            { className: 'Mfa', methodName: 'enrollFactor', params: [], returnType: 'void' },
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
    // Barrel export uses resolved name
    expect(barrel!.content).toContain("from './mfa/mfa'");
  });

  it('generates error handling in WorkOS client', () => {
    const files = generateClient(spec, ctx);
    const workosFile = files.find((f) => f.path === 'src/workos.ts')!;
    const content = workosFile.content;

    expect(content).toContain('case 401: throw new UnauthorizedException');
    expect(content).toContain('case 404: throw new NotFoundException');
    expect(content).toContain('case 422: throw new UnprocessableEntityException');
    expect(content).toContain('case 429:');
    expect(content).toContain('throw new RateLimitExceededException');
  });
});
