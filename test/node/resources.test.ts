import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { EmitterContext, ApiSpec, Service, Model } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { nodeEmitter } from '../../src/node/index.js';
import {
  generateResources,
  resolveResourceClassName,
  resolveResourceDir,
  hasCompatibleConstructor,
} from '../../src/node/resources.js';

const emptySpec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: '',
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

function createTrackedSdkRoot(): string {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'node-adopt-surface-'));
  fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'src', 'workos.ts'), '// @oagen-ignore-file\nexport class WorkOS {}\n');
  fs.writeFileSync(
    path.join(tmpRoot, 'src', 'index.ts'),
    '// @oagen-ignore-file\nexport { WorkOS } from "./workos";\n',
  );
  execFileSync('git', ['init'], { cwd: tmpRoot, stdio: 'ignore' });
  execFileSync('git', ['add', 'src'], { cwd: tmpRoot, stdio: 'ignore' });
  return tmpRoot;
}

const connectService: Service = {
  name: 'Connect',
  operations: [
    {
      name: 'getConnect',
      httpMethod: 'get',
      path: '/connect',
      pathParams: [],
      queryParams: [],
      headerParams: [],
      response: { kind: 'primitive', type: 'unknown' },
      errors: [],
      injectIdempotencyKey: false,
    },
  ],
};

describe('generateResources', () => {
  it('returns empty for no services', () => {
    expect(generateResources([], ctx)).toEqual([]);
  });

  it('generates a resource class with GET method', () => {
    const orgModel: Model = {
      name: 'Organization',
      fields: [
        { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
        { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
      ],
    };

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
        ],
      },
    ];

    const spec: ApiSpec = { ...emptySpec, services, models: [orgModel] };
    const ctxWithSpec: EmitterContext = { ...ctx, spec };
    const result = generateResources(services, ctxWithSpec);

    expect(result.length).toBeGreaterThan(0);
    const resourceFile = result.find((f) => f.path.includes('organizations.ts'));
    expect(resourceFile).toBeDefined();
    expect(resourceFile!.content).toContain('export class Organizations');
    expect(resourceFile!.content).toContain('constructor(private readonly workos: WorkOS)');
    expect(resourceFile!.content).toContain(
      'async getOrganization(options: GetOrganizationOptions): Promise<Organization>',
    );
    expect(resourceFile!.content).toContain('deserializeOrganization(data)');
  });

  it('generates DELETE method returning void', () => {
    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [
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

    const spec: ApiSpec = { ...emptySpec, services };
    const ctxWithSpec: EmitterContext = { ...ctx, spec };
    const result = generateResources(services, ctxWithSpec);

    const resourceFile = result.find((f) => f.path.includes('organizations.ts'));
    expect(resourceFile).toBeDefined();
    expect(resourceFile!.content).toContain('Promise<void>');
  });

  it('applies Node-only operation overrides without global operation hints', () => {
    const operation = {
      name: 'listOrganizationMembershipGroups',
      httpMethod: 'get' as const,
      path: '/user_management/organization_memberships/{omId}/groups',
      pathParams: [{ name: 'omId', type: { kind: 'primitive' as const, type: 'string' as const }, required: true }],
      queryParams: [],
      headerParams: [],
      response: { kind: 'primitive' as const, type: 'unknown' as const },
      errors: [],
      injectIdempotencyKey: false,
    };
    const service: Service = {
      name: 'UserManagementOrganizationMembershipGroups',
      operations: [operation],
    };
    const spec: ApiSpec = { ...emptySpec, services: [service] };
    const ctxWithResolved: EmitterContext = {
      ...ctx,
      spec,
      emitterOptions: {
        operationOverrides: {
          'GET /user_management/organization_memberships/{omId}/groups': {
            methodName: 'list_groups_for_organization_membership',
            mountOn: 'UserManagement',
          },
        },
      },
      resolvedOperations: [
        {
          operation,
          service,
          methodName: 'list_organization_membership_groups',
          mountOn: 'UserManagementOrganizationMembershipGroups',
          defaults: {},
          inferFromClient: [],
          urlBuilder: false,
        },
      ],
    };

    const result = nodeEmitter.generateResources(spec.services, ctxWithResolved);

    expect(result.some((f) => f.path.includes('user-management-organization-membership-groups'))).toBe(false);
    const resourceFile = result.find((f) => f.path === 'src/user-management/user-management.ts');
    expect(resourceFile).toBeDefined();
    expect(resourceFile!.content).toContain('export class UserManagement');
    expect(resourceFile!.content).toContain('async listGroupsForOrganizationMembership');
  });

  it('options-object: URL template binds to the SDK field name, not the spec path-param name', () => {
    // When the spec uses `omId` as a path-param name but the baseline options
    // interface exposes `organizationMembershipId`, both the destructure and
    // the URL template should reference `organizationMembershipId` directly —
    // no `organizationMembershipId: omId` rename indirection in the body.
    const operation = {
      name: 'removeOrganizationMembership',
      httpMethod: 'delete' as const,
      path: '/organizations/{organizationId}/groups/{groupId}/organization-memberships/{omId}',
      pathParams: [
        { name: 'organizationId', type: { kind: 'primitive' as const, type: 'string' as const }, required: true },
        { name: 'groupId', type: { kind: 'primitive' as const, type: 'string' as const }, required: true },
        { name: 'omId', type: { kind: 'primitive' as const, type: 'string' as const }, required: true },
      ],
      queryParams: [],
      headerParams: [],
      response: { kind: 'primitive' as const, type: 'unknown' as const },
      errors: [],
      injectIdempotencyKey: false,
    };
    const service: Service = { name: 'Groups', operations: [operation] };
    const spec: ApiSpec = { ...emptySpec, services: [service] };
    const ctxWithBaseline: EmitterContext = {
      ...ctx,
      spec,
      emitterOptions: { ownedServices: ['Groups'] },
      apiSurface: {
        classes: {
          Groups: {
            constructorParams: [{ name: 'workos', type: 'WorkOS' }],
            methods: {
              removeOrganizationMembership: [
                {
                  name: 'removeOrganizationMembership',
                  params: [
                    {
                      name: 'options',
                      type: 'RemoveGroupOrganizationMembershipOptions',
                      passingStyle: 'options_object',
                    },
                  ],
                  returnType: 'Promise<void>',
                  async: true,
                },
              ],
            },
          },
        },
        interfaces: {
          RemoveGroupOrganizationMembershipOptions: {
            fields: {
              organizationId: { type: 'string', required: true },
              groupId: { type: 'string', required: true },
              organizationMembershipId: { type: 'string', required: true },
            },
          },
        },
      } as any,
    };

    const result = generateResources([service], ctxWithBaseline);
    const resourceFile = result.find((f) => f.path === 'src/groups/groups.ts');
    expect(resourceFile).toBeDefined();
    const content = resourceFile!.content;
    expect(content).toContain('const { organizationId, groupId, organizationMembershipId } = options;');
    expect(content).toContain('${encodeURIComponent(organizationMembershipId)}');
    expect(content).not.toContain('organizationMembershipId: omId');
    expect(content).not.toContain('encodeURIComponent(omId)');
  });

  it('drops brand-new service paths in an existing SDK by default', () => {
    const tmpRoot = createTrackedSdkRoot();
    try {
      const spec: ApiSpec = { ...emptySpec, services: [connectService] };
      const result = nodeEmitter.generateResources(spec.services, { ...ctx, spec, outputDir: tmpRoot });

      expect(result.some((f) => f.path === 'src/connect/connect.ts')).toBe(false);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('adopts brand-new service paths when configured', () => {
    const tmpRoot = createTrackedSdkRoot();
    try {
      const spec: ApiSpec = { ...emptySpec, services: [connectService] };
      const result = nodeEmitter.generateResources(spec.services, {
        ...ctx,
        spec,
        outputDir: tmpRoot,
        emitterOptions: { adoptMissingServices: true },
      } as EmitterContext);

      const resourceFile = result.find((f) => f.path === 'src/connect/connect.ts');
      expect(resourceFile).toBeDefined();
      expect(resourceFile!.content).toContain('export class Connect');
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('overwrites tracked files for explicitly owned services', () => {
    const tmpRoot = createTrackedSdkRoot();
    try {
      fs.mkdirSync(path.join(tmpRoot, 'src', 'groups'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, 'src', 'groups', 'groups.ts'),
        'export class Groups { async createGroup() {} }\n',
      );
      execFileSync('git', ['add', 'src/groups/groups.ts'], { cwd: tmpRoot, stdio: 'ignore' });

      const groupService: Service = {
        name: 'Groups',
        operations: [
          {
            name: 'createGroup',
            httpMethod: 'post',
            path: '/organizations/{organizationId}/groups',
            pathParams: [{ name: 'organizationId', type: { kind: 'primitive', type: 'string' }, required: true }],
            queryParams: [],
            headerParams: [],
            response: { kind: 'primitive', type: 'unknown' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      };
      const spec: ApiSpec = { ...emptySpec, services: [groupService] };
      const result = nodeEmitter.generateResources(spec.services, {
        ...ctx,
        spec,
        outputDir: tmpRoot,
        emitterOptions: { ownedServices: ['Groups'] },
        apiSurface: {
          classes: {
            Groups: {
              methods: {
                createGroup: [{ name: 'createGroup', params: [], returnType: 'Promise<void>', async: true }],
              },
            },
          },
        } as any,
      } as EmitterContext);

      const resourceFile = result.find((f) => f.path === 'src/groups/groups.ts');
      expect(resourceFile).toBeDefined();
      expect(resourceFile!.overwriteExisting).toBe(true);
      expect(resourceFile!.skipIfExists).toBe(false);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('does not overwrite protected files for explicitly owned services', () => {
    const tmpRoot = createTrackedSdkRoot();
    try {
      fs.mkdirSync(path.join(tmpRoot, 'src', 'groups'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, 'src', 'groups', 'groups.ts'),
        '// @oagen-ignore-file\nexport class Groups {}\n',
      );
      execFileSync('git', ['add', 'src/groups/groups.ts'], { cwd: tmpRoot, stdio: 'ignore' });

      const groupService: Service = {
        name: 'Groups',
        operations: [
          {
            name: 'createGroup',
            httpMethod: 'post',
            path: '/organizations/{organizationId}/groups',
            pathParams: [{ name: 'organizationId', type: { kind: 'primitive', type: 'string' }, required: true }],
            queryParams: [],
            headerParams: [],
            response: { kind: 'primitive', type: 'unknown' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      };
      const spec: ApiSpec = { ...emptySpec, services: [groupService] };
      const result = nodeEmitter.generateResources(spec.services, {
        ...ctx,
        spec,
        outputDir: tmpRoot,
        emitterOptions: { ownedServices: ['Groups'] },
      } as EmitterContext);

      expect(result.some((f) => f.path === 'src/groups/groups.ts')).toBe(false);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('treats prior-manifest generated files as managed before they are git-tracked', () => {
    const tmpRoot = createTrackedSdkRoot();
    try {
      fs.mkdirSync(path.join(tmpRoot, 'src', 'connect'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, 'src', 'connect', 'connect.ts'),
        ['// This file is auto-generated by oagen. Do not edit.', '', 'export class Connect {}'].join('\n'),
      );

      const spec: ApiSpec = { ...emptySpec, services: [connectService] };
      const result = nodeEmitter.generateResources(spec.services, {
        ...ctx,
        spec,
        outputDir: tmpRoot,
        emitterOptions: { adoptMissingServices: true },
        priorTargetManifestPaths: new Set(['src/connect/connect.ts']),
      } as EmitterContext);

      const resourceFile = result.find((f) => f.path === 'src/connect/connect.ts');
      expect(resourceFile).toBeDefined();
      expect(resourceFile!.overwriteExisting).toBe(true);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('harvests serializer exports from prior-manifest generated files before they are git-tracked', () => {
    const tmpRoot = createTrackedSdkRoot();
    try {
      fs.mkdirSync(path.join(tmpRoot, 'src', 'connect', 'serializers'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, 'src', 'connect', 'serializers', 'create-m2m-application.serializer.ts'),
        [
          '// This file is auto-generated by oagen. Do not edit.',
          '',
          'export const serializeCreateM2MApplication = (payload: unknown): unknown => payload;',
        ].join('\n'),
      );

      const service: Service = {
        name: 'Connect',
        operations: [
          {
            name: 'createApplication',
            httpMethod: 'post',
            path: '/connect/applications',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            requestBody: { kind: 'model', name: 'CreateM2MApplication' },
            response: { kind: 'primitive', type: 'unknown' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      };
      const spec: ApiSpec = {
        ...emptySpec,
        services: [service],
        models: [
          {
            name: 'CreateM2MApplication',
            fields: [{ name: 'name', type: { kind: 'primitive', type: 'string' }, required: true }],
          },
        ],
      };
      const result = nodeEmitter.generateResources(spec.services, {
        ...ctx,
        spec,
        outputDir: tmpRoot,
        emitterOptions: { adoptMissingServices: true },
        priorTargetManifestPaths: new Set([
          'src/connect/connect.ts',
          'src/connect/serializers/create-m2m-application.serializer.ts',
        ]),
      } as EmitterContext);

      const resourceFile = result.find((f) => f.path === 'src/connect/connect.ts');
      expect(resourceFile?.content).toContain(
        "import { serializeCreateM2MApplication } from './serializers/create-m2m-application.serializer';",
      );
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('body-less POST/PUT operations', () => {
  // The WorkOS client's `post(path, entity, options?)` and `put(path, entity, options?)`
  // REQUIRE the entity argument. Operations with no request body must still pass `{}`
  // or the generated call fails with TS2554 "Expected 2-3 arguments, but got 1".
  const domainModel: Model = {
    name: 'OrganizationDomain',
    fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
  };

  it('passes an empty object body for a body-less POST with a response model', () => {
    const services: Service[] = [
      {
        name: 'OrganizationDomains',
        operations: [
          {
            name: 'verifyOrganizationDomain',
            httpMethod: 'post',
            path: '/organization_domains/{id}/verify',
            pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model', name: 'OrganizationDomain' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const spec: ApiSpec = { ...emptySpec, services, models: [domainModel] };
    const result = generateResources(services, { ...ctx, spec });
    const resourceFile = result.find((f) => f.path.includes('organization-domains.ts'));
    expect(resourceFile).toBeDefined();
    // The post() call must pass `{}` as the required entity argument.
    expect(resourceFile!.content).toMatch(/await this\.workos\.post<[^>]+>\(`[^`]+`, \{\}\);/);
    expect(resourceFile!.content).not.toMatch(/await this\.workos\.post<[^>]+>\(`[^`]+`\);/);
  });

  it('passes an empty object body for a body-less PUT with a response model', () => {
    const flagModel: Model = {
      name: 'FeatureFlag',
      fields: [{ name: 'slug', type: { kind: 'primitive', type: 'string' }, required: true }],
    };
    const services: Service[] = [
      {
        name: 'FeatureFlags',
        operations: [
          {
            name: 'enableFeatureFlag',
            httpMethod: 'put',
            path: '/feature_flags/{slug}/enable',
            pathParams: [{ name: 'slug', type: { kind: 'primitive', type: 'string' }, required: true }],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model', name: 'FeatureFlag' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const spec: ApiSpec = { ...emptySpec, services, models: [flagModel] };
    const result = generateResources(services, { ...ctx, spec });
    const resourceFile = result.find((f) => f.path.includes('feature-flags.ts'));
    expect(resourceFile).toBeDefined();
    expect(resourceFile!.content).toMatch(/await this\.workos\.put<[^>]+>\(`[^`]+`, \{\}\);/);
    expect(resourceFile!.content).not.toMatch(/await this\.workos\.put<[^>]+>\(`[^`]+`\);/);
  });

  it('does not add a body argument to body-less GET calls', () => {
    const services: Service[] = [
      {
        name: 'OrganizationDomains',
        operations: [
          {
            name: 'getOrganizationDomain',
            httpMethod: 'get',
            path: '/organization_domains/{id}',
            pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model', name: 'OrganizationDomain' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const spec: ApiSpec = { ...emptySpec, services, models: [domainModel] };
    const result = generateResources(services, { ...ctx, spec });
    const resourceFile = result.find((f) => f.path.includes('organization-domains.ts'));
    expect(resourceFile).toBeDefined();
    expect(resourceFile!.content).toMatch(/await this\.workos\.get<[^>]+>\(`[^`]+`\);/);
  });
});

describe('resolveResourceClassName', () => {
  it('uses overlay name when baseline has compatible constructor', () => {
    const service: Service = { name: 'Organizations', operations: [] };
    const ctxWithBaseline: EmitterContext = {
      ...ctx,
      apiSurface: {
        classes: {
          Organizations: {
            constructorParams: [{ name: 'workos', type: 'WorkOS' }],
          },
        },
      } as any,
    };
    expect(resolveResourceClassName(service, ctxWithBaseline)).toBe('Organizations');
  });

  it('appends Endpoints suffix when IR name collides with overlay name', () => {
    const service: Service = {
      name: 'Webhooks',
      operations: [
        {
          name: 'listWebhooks',
          httpMethod: 'get',
          path: '/webhooks',
          pathParams: [],
          queryParams: [],
          headerParams: [],
          response: { kind: 'primitive', type: 'unknown' },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    };
    const ctxWithIncompat: EmitterContext = {
      ...ctx,
      apiSurface: {
        classes: {
          Webhooks: {
            constructorParams: [{ name: 'crypto', type: 'CryptoProvider' }],
          },
        },
      } as any,
      resolvedOperations: [
        {
          operation: service.operations[0],
          service,
          methodName: 'list_webhooks',
          mountOn: 'Webhooks',
          defaults: {},
          inferFromClient: [],
          urlBuilder: false,
        },
      ],
    };
    expect(resolveResourceClassName(service, ctxWithIncompat)).toBe('WebhooksEndpoints');
    expect(resolveResourceDir(service, ctxWithIncompat)).toBe('webhooks');

    const result = generateResources([service], { ...ctxWithIncompat, spec: { ...emptySpec, services: [service] } });
    expect(result.some((f) => f.path === 'src/webhooks/webhooks-endpoints.ts')).toBe(true);
    expect(result.some((f) => f.path === 'src/webhooks-endpoints/webhooks-endpoints.ts')).toBe(false);
  });
});

describe('hasCompatibleConstructor', () => {
  it('returns true when no baseline exists', () => {
    expect(hasCompatibleConstructor('NewService', ctx)).toBe(true);
  });

  it('returns true when baseline has workos: WorkOS param', () => {
    const ctxWithBaseline: EmitterContext = {
      ...ctx,
      apiSurface: {
        classes: {
          Organizations: {
            constructorParams: [{ name: 'workos', type: 'WorkOS' }],
          },
        },
      } as any,
    };
    expect(hasCompatibleConstructor('Organizations', ctxWithBaseline)).toBe(true);
  });

  it('returns false when baseline has incompatible constructor', () => {
    const ctxWithIncompat: EmitterContext = {
      ...ctx,
      apiSurface: {
        classes: {
          Webhooks: {
            constructorParams: [{ name: 'crypto', type: 'CryptoProvider' }],
          },
        },
      } as any,
    };
    expect(hasCompatibleConstructor('Webhooks', ctxWithIncompat)).toBe(false);
  });

  it('returns true when baseline has no constructor params', () => {
    const ctxWithEmptyCtor: EmitterContext = {
      ...ctx,
      apiSurface: {
        classes: {
          Utils: {
            constructorParams: [],
          },
        },
      } as any,
    };
    expect(hasCompatibleConstructor('Utils', ctxWithEmptyCtor)).toBe(true);
  });
});
