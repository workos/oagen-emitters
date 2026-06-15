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

  it('urlBuilder: emits a synchronous string method that builds the URL via toQueryString', () => {
    // Operations marked `urlBuilder` (e.g. GET /sso/authorize) are client-side
    // URL constructors: the generated method must return a string synchronously,
    // serialize visible query params + defaults + inferred client fields via
    // toQueryString, and concatenate onto the client base URL — no HTTP call.
    const operation = {
      name: 'getAuthorizationUrl',
      httpMethod: 'get' as const,
      path: '/sso/authorize',
      pathParams: [],
      queryParams: [
        { name: 'connection', type: { kind: 'primitive' as const, type: 'string' as const }, required: false },
        { name: 'organization', type: { kind: 'primitive' as const, type: 'string' as const }, required: false },
      ],
      headerParams: [],
      response: { kind: 'primitive' as const, type: 'unknown' as const },
      errors: [],
      injectIdempotencyKey: false,
    };
    const service: Service = { name: 'Sso', operations: [operation] };
    const spec: ApiSpec = { ...emptySpec, services: [service] };
    const ctxWithResolved: EmitterContext = {
      ...ctx,
      spec,
      emitterOptions: { ownedServices: ['Sso'] },
      resolvedOperations: [
        {
          operation,
          service,
          methodName: 'get_authorization_url',
          mountOn: 'Sso',
          defaults: { response_type: 'code' },
          inferFromClient: ['client_id'],
          urlBuilder: true,
        },
      ],
    };

    const result = nodeEmitter.generateResources(spec.services, ctxWithResolved);
    const resourceFile = result.find((f) => f.path === 'src/sso/sso.ts');
    expect(resourceFile).toBeDefined();
    const content = resourceFile!.content;

    // Synchronous, string-returning — not an async HTTP wrapper.
    expect(content).toMatch(/getAuthorizationUrl\(options\??: [^)]*\): string \{/);
    expect(content).not.toContain('async getAuthorizationUrl');
    expect(content).not.toContain('this.workos.get(');
    // Query assembled client-side: visible params + constant default + inferred field.
    expect(content).toContain('const query = toQueryString(');
    expect(content).toContain("response_type: 'code'");
    expect(content).toContain('client_id: this.workos.options.clientId');
    // URL is base URL + path + query.
    expect(content).toContain('return `${this.workos.baseURL}/sso/authorize?${query}`;');
    // The serializer helper is imported.
    expect(content).toContain("import { toQueryString } from '../common/utils/query-string';");
  });

  it('urlBuilder: positional convention emits a no-arg method when only injected fields supply the query', () => {
    // A url builder with no path params and no visible query params takes the
    // positional branch (operationHasOptionsInput is false), so the signature
    // is argument-less; the query is assembled purely from inferFromClient
    // (and defaults) rather than a options object.
    const operation = {
      name: 'getLogoutUrl',
      httpMethod: 'get' as const,
      path: '/sso/logout',
      pathParams: [],
      queryParams: [],
      headerParams: [],
      response: { kind: 'primitive' as const, type: 'unknown' as const },
      errors: [],
      injectIdempotencyKey: false,
    };
    const service: Service = { name: 'Sso', operations: [operation] };
    const spec: ApiSpec = { ...emptySpec, services: [service] };
    const ctxWithResolved: EmitterContext = {
      ...ctx,
      spec,
      emitterOptions: { ownedServices: ['Sso'] },
      resolvedOperations: [
        {
          operation,
          service,
          methodName: 'get_logout_url',
          mountOn: 'Sso',
          defaults: {},
          inferFromClient: ['client_id'],
          urlBuilder: true,
        },
      ],
    };

    const result = nodeEmitter.generateResources(spec.services, ctxWithResolved);
    const content = result.find((f) => f.path === 'src/sso/sso.ts')!.content;

    // No options object and no path params: the signature takes no arguments.
    expect(content).toMatch(/getLogoutUrl\(\): string \{/);
    expect(content).not.toContain('async getLogoutUrl');
    // Query built entirely from the injected client field.
    expect(content).toContain('const query = toQueryString(');
    expect(content).toContain('client_id: this.workos.options.clientId');
    expect(content).toContain('return `${this.workos.baseURL}/sso/logout?${query}`;');
  });

  it('urlBuilder: with no query at all returns the bare base URL + path and skips the toQueryString import', () => {
    // hasQuery is false (no visible params, defaults, or inferFromClient), so
    // the method returns base URL + path with no `?${query}` segment, and the
    // serializer import must not appear when nothing in the service uses it.
    const operation = {
      name: 'getJwksUrl',
      httpMethod: 'get' as const,
      path: '/sso/jwks',
      pathParams: [],
      queryParams: [],
      headerParams: [],
      response: { kind: 'primitive' as const, type: 'unknown' as const },
      errors: [],
      injectIdempotencyKey: false,
    };
    const service: Service = { name: 'Sso', operations: [operation] };
    const spec: ApiSpec = { ...emptySpec, services: [service] };
    const ctxWithResolved: EmitterContext = {
      ...ctx,
      spec,
      emitterOptions: { ownedServices: ['Sso'] },
      resolvedOperations: [
        {
          operation,
          service,
          methodName: 'get_jwks_url',
          mountOn: 'Sso',
          defaults: {},
          inferFromClient: [],
          urlBuilder: true,
        },
      ],
    };

    const result = nodeEmitter.generateResources(spec.services, ctxWithResolved);
    const content = result.find((f) => f.path === 'src/sso/sso.ts')!.content;

    expect(content).toMatch(/getJwksUrl\(\): string \{/);
    expect(content).toContain('return `${this.workos.baseURL}/sso/jwks`;');
    expect(content).not.toContain('toQueryString');
    expect(content).not.toContain("import { toQueryString } from '../common/utils/query-string';");
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

describe('paginated list methods and path params (AutoPaginatable typing)', () => {
  // List methods with PATH parameters destructure those params out of the
  // options object (`const { actionName, ...paginationOptions } = options;`)
  // and pass the REST object to AutoPaginatable/fetchAndDeserialize. The
  // declared second type argument must therefore be the rest type
  // (Omit<FullOptions, pathFields>) — declaring the full options interface
  // fails TS2322 because the rest object lacks the required path-param fields.
  const schemaModel: Model = {
    name: 'AuditLogSchema',
    fields: [{ name: 'version', type: { kind: 'primitive', type: 'number' }, required: true }],
  };

  const paginationQueryParams = [
    { name: 'limit', type: { kind: 'primitive' as const, type: 'number' as const }, required: false },
    { name: 'after', type: { kind: 'primitive' as const, type: 'string' as const }, required: false },
  ];

  const cursorPagination = {
    strategy: 'cursor' as const,
    param: 'after',
    itemType: { kind: 'model' as const, name: 'AuditLogSchema' },
  };

  it('types AutoPaginatable over the rest options when one path param is destructured', () => {
    const services: Service[] = [
      {
        name: 'AuditLogs',
        operations: [
          {
            name: 'listActionSchemas',
            httpMethod: 'get',
            path: '/audit_logs/actions/{actionName}/schemas',
            pathParams: [{ name: 'actionName', type: { kind: 'primitive', type: 'string' }, required: true }],
            queryParams: paginationQueryParams,
            headerParams: [],
            response: { kind: 'array', items: { kind: 'model', name: 'AuditLogSchema' } },
            pagination: cursorPagination,
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const spec: ApiSpec = { ...emptySpec, services, models: [schemaModel] };
    const result = generateResources(services, { ...ctx, spec });
    const resourceFile = result.find((f) => f.path.includes('audit-logs.ts'));
    expect(resourceFile).toBeDefined();
    const content = resourceFile!.content;

    // The declaration, the constructed value, and the re-fetch lambda must all
    // agree on the rest type actually passed (paginationOptions).
    const expectedMethod = [
      "  async listActionSchemas(options: ListActionSchemasOptions): Promise<AutoPaginatable<AuditLogSchema, Omit<ListActionSchemasOptions, 'actionName'>>> {",
      '    const { actionName, ...paginationOptions } = options;',
      '    return new AutoPaginatable(',
      '      await fetchAndDeserialize<AuditLogSchemaResponse, AuditLogSchema>(',
      '        this.workos,',
      '        `/audit_logs/actions/${encodeURIComponent(actionName)}/schemas`,',
      '        deserializeAuditLogSchema,',
      '        paginationOptions,',
      '      ),',
      '      (params) =>',
      '        fetchAndDeserialize<AuditLogSchemaResponse, AuditLogSchema>(',
      '          this.workos,',
      '          `/audit_logs/actions/${encodeURIComponent(actionName)}/schemas`,',
      '          deserializeAuditLogSchema,',
      '          params,',
      '        ),',
      '      paginationOptions,',
      '    );',
      '  }',
    ].join('\n');
    expect(content).toContain(expectedMethod);
    // The full options interface (which requires actionName) must never be the
    // second AutoPaginatable type argument — that is the TS2322 shape.
    expect(content).not.toContain('AutoPaginatable<AuditLogSchema, ListActionSchemasOptions>');
  });

  it('keeps the full options type when no path params are destructured (regression)', () => {
    const services: Service[] = [
      {
        name: 'AuditLogs',
        operations: [
          {
            name: 'listActions',
            httpMethod: 'get',
            path: '/audit_logs/actions',
            pathParams: [],
            queryParams: paginationQueryParams,
            headerParams: [],
            response: { kind: 'array', items: { kind: 'model', name: 'AuditLogSchema' } },
            pagination: cursorPagination,
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const spec: ApiSpec = { ...emptySpec, services, models: [schemaModel] };
    const result = generateResources(services, { ...ctx, spec });
    const resourceFile = result.find((f) => f.path.includes('audit-logs.ts'));
    expect(resourceFile).toBeDefined();

    // Byte-identical to the pre-fix output: no Omit, no path destructure.
    const expectedMethod = [
      '  async listActions(options?: ListActionsOptions): Promise<AutoPaginatable<AuditLogSchema, ListActionsOptions>> {',
      '    const paginationOptions = options;',
      '    return new AutoPaginatable(',
      '      await fetchAndDeserialize<AuditLogSchemaResponse, AuditLogSchema>(',
      '        this.workos,',
      "        '/audit_logs/actions',",
      '        deserializeAuditLogSchema,',
      '        paginationOptions,',
      '      ),',
      '      (params) =>',
      '        fetchAndDeserialize<AuditLogSchemaResponse, AuditLogSchema>(',
      '          this.workos,',
      "          '/audit_logs/actions',",
      '          deserializeAuditLogSchema,',
      '          params,',
      '        ),',
      '      paginationOptions,',
      '    );',
      '  }',
    ].join('\n');
    expect(resourceFile!.content).toContain(expectedMethod);
    expect(resourceFile!.content).not.toContain('Omit<');
  });

  it('omits every destructured path param when there are multiple', () => {
    const memberModel: Model = {
      name: 'GroupMember',
      fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
    };
    const services: Service[] = [
      {
        name: 'Groups',
        operations: [
          {
            name: 'listGroupMembers',
            httpMethod: 'get',
            path: '/organizations/{organizationId}/groups/{groupId}/members',
            pathParams: [
              { name: 'organizationId', type: { kind: 'primitive', type: 'string' }, required: true },
              { name: 'groupId', type: { kind: 'primitive', type: 'string' }, required: true },
            ],
            queryParams: paginationQueryParams,
            headerParams: [],
            response: { kind: 'array', items: { kind: 'model', name: 'GroupMember' } },
            pagination: {
              strategy: 'cursor',
              param: 'after',
              itemType: { kind: 'model', name: 'GroupMember' },
            },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const spec: ApiSpec = { ...emptySpec, services, models: [memberModel] };
    const result = generateResources(services, { ...ctx, spec });
    const resourceFile = result.find((f) => f.path.includes('groups.ts'));
    expect(resourceFile).toBeDefined();
    const content = resourceFile!.content;

    expect(content).toContain(
      'async listGroupMembers(options: ListGroupMembersOptions): ' +
        "Promise<AutoPaginatable<GroupMember, Omit<ListGroupMembersOptions, 'organizationId' | 'groupId'>>> {",
    );
    expect(content).toContain('const { organizationId, groupId, ...paginationOptions } = options;');
    expect(content).toContain(
      '`/organizations/${encodeURIComponent(organizationId)}/groups/${encodeURIComponent(groupId)}/members`',
    );
    expect(content).not.toContain('AutoPaginatable<GroupMember, ListGroupMembersOptions>');
  });
});

describe('inline object-literal baseline parameter types', () => {
  // The hand-written workos-node AdminPortal method uses an inline object-literal
  // parameter TYPE (`generateLink({ ... }: { intent: GenerateLinkIntent; ... })`).
  // When the baseline surface reports that literal text as the param "type name",
  // the emitter must keep it inline in the signature and must NOT slugify it into
  // an interface filename or emit a named import of a brace-expression.
  it('keeps the literal type inline and never imports it', () => {
    const literalType = '{ intent: GenerateLinkIntent; organization: string; returnUrl?: string }';
    const service: Service = {
      name: 'AdminPortal',
      operations: [
        {
          name: 'generateLink',
          httpMethod: 'post',
          path: '/portal/generate_link',
          pathParams: [],
          queryParams: [],
          headerParams: [],
          requestBody: { kind: 'model', name: 'GenerateLinkBody' },
          response: { kind: 'model', name: 'PortalLink' },
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
          name: 'GenerateLinkBody',
          fields: [
            { name: 'intent', type: { kind: 'primitive', type: 'string' }, required: true },
            { name: 'organization', type: { kind: 'primitive', type: 'string' }, required: true },
          ],
        },
        {
          name: 'PortalLink',
          fields: [{ name: 'link', type: { kind: 'primitive', type: 'string' }, required: true }],
        },
      ],
    };
    const ctxWithBaseline: EmitterContext = {
      ...ctx,
      spec,
      emitterOptions: { ownedServices: ['AdminPortal'] },
      apiSurface: {
        classes: {
          AdminPortal: {
            constructorParams: [{ name: 'workos', type: 'WorkOS' }],
            methods: {
              generateLink: [
                {
                  name: 'generateLink',
                  params: [{ name: 'options', type: literalType, passingStyle: 'options_object' }],
                  returnType: 'Promise<{ link: string }>',
                  async: true,
                },
              ],
            },
          },
        },
      } as any,
    };

    const result = generateResources([service], ctxWithBaseline);
    const resourceFile = result.find((f) => f.path === 'src/admin-portal/admin-portal.ts');
    expect(resourceFile).toBeDefined();
    const content = resourceFile!.content;

    // The literal type stays inline in the method signature.
    expect(content).toContain(`async generateLink(options: ${literalType})`);
    // No named import of a brace-expression…
    expect(content).not.toContain('import type { {');
    // …and no import path derived from slugifying the literal type's text.
    expect(content).not.toContain('intent-generate-link-intent');
    // No interface file is emitted for the literal type either.
    expect(result.some((f) => f.path.includes('intent-generate-link-intent'))).toBe(false);
  });
});

describe('@oagen-ignore region method filtering', () => {
  // `ignoredResourceMethodNames` scans @oagen-ignore-start/end regions in the
  // existing on-disk resource file and the plan filter drops matching method
  // names so user-preserved legacy methods are not re-emitted as duplicates.
  // Generic methods (`name<T>(...)`, including multi-line type-parameter lists
  // with constraints/defaults and nested angle brackets) must be caught too —
  // on the SSO pass, region-protected getProfile<T>/getProfileAndToken<T> were
  // re-appended as duplicates on every regen.
  const ssoOp = (name: string, opPath: string) =>
    ({
      name,
      httpMethod: 'get',
      path: opPath,
      pathParams: [],
      queryParams: [],
      headerParams: [],
      response: { kind: 'model', name: 'Profile' },
      errors: [],
      injectIdempotencyKey: false,
    }) as Service['operations'][number];

  it('filters region-protected generic methods (single-line and multi-line type params)', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'node-ignore-region-'));
    try {
      fs.mkdirSync(path.join(tmpRoot, 'src', 'sso'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, 'src', 'sso', 'sso.ts'),
        [
          "import type { WorkOS } from '../workos';",
          '',
          'export class Sso {',
          '  constructor(private readonly workos: WorkOS) {}',
          '',
          '  // @oagen-ignore-start',
          '  async getProfile<T extends Record<string, unknown> = Record<string, unknown>>(accessToken: string): Promise<T> {',
          '    return {} as T;',
          '  }',
          '  // @oagen-ignore-end',
          '',
          '  // @oagen-ignore-start',
          '  async getProfileAndToken<',
          '    T extends Record<string, unknown> = Record<string, unknown>,',
          '  >(payload: { code: string }): Promise<T> {',
          '    return {} as T;',
          '  }',
          '  // @oagen-ignore-end',
          '',
          '  // @oagen-ignore-start',
          '  getAuthorizationUrl(options: { provider: string }): string {',
          "    return '';",
          '  }',
          '  // @oagen-ignore-end',
          '}',
          '',
        ].join('\n'),
      );

      const service: Service = {
        name: 'Sso',
        operations: [
          ssoOp('getProfile', '/sso/profile'),
          ssoOp('getProfileAndToken', '/sso/token'),
          ssoOp('getAuthorizationUrl', '/sso/authorize'),
          {
            name: 'deleteConnection',
            httpMethod: 'delete',
            path: '/connections/{id}',
            pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
            queryParams: [],
            headerParams: [],
            response: { kind: 'primitive', type: 'unknown' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      };
      const profileModel: Model = {
        name: 'Profile',
        fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
      };
      const spec: ApiSpec = { ...emptySpec, services: [service], models: [profileModel] };

      const result = generateResources([service], {
        ...ctx,
        spec,
        outputDir: tmpRoot,
        emitterOptions: { ownedServices: ['Sso'] },
      } as EmitterContext);

      const resourceFile = result.find((f) => f.path === 'src/sso/sso.ts');
      expect(resourceFile).toBeDefined();
      const content = resourceFile!.content;
      // The non-protected method is still emitted…
      expect(content).toContain('async deleteConnection');
      // …but region-protected methods are not re-emitted, generic or not.
      expect(content).not.toContain('async getProfile(');
      expect(content).not.toContain('async getProfileAndToken(');
      expect(content).not.toContain('getAuthorizationUrl(');
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
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
