import { describe, it, expect } from 'vitest';
import { generateClient } from '../../src/node/client.js';
import type { EmitterContext, ApiSpec, Service, Model, Enum } from '@workos/oagen';

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
      name: 'Connections',
      operations: [
        {
          name: 'listConnections',
          httpMethod: 'get',
          path: '/connections',
          pathParams: [],
          queryParams: [
            {
              name: 'type',
              type: { kind: 'enum', name: 'ConnectionType', values: ['ADFSSAML', 'GoogleOAuth'] },
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
      name: 'Directories',
      operations: [
        {
          name: 'listDirectories',
          httpMethod: 'get',
          path: '/directories',
          pathParams: [],
          queryParams: [
            {
              name: 'state',
              type: { kind: 'enum', name: 'DirectoryState', values: ['active', 'inactive'] },
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
    // TS enum should use value export (no 'type' keyword)
    expect(content).toContain("export { ConnectionType } from './connections/interfaces/connection-type.interface';");
    // Type alias enum should use type-only export
    expect(content).toContain(
      "export type { DirectoryState } from './directories/interfaces/directory-state.interface';",
    );
  });
});
