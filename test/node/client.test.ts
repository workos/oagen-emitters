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

  it('does not generate error handling in WorkOS client (lives in WorkOSBase)', () => {
    const files = generateClient(spec, ctx);
    const workosFile = files.find((f) => f.path === 'src/workos.ts')!;
    const content = workosFile.content;

    expect(content).not.toContain('handleHttpError');
    expect(content).not.toContain('UnauthorizedException');
    expect(content).not.toContain('NotFoundException');
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
});
