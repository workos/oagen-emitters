import { describe, it, expect } from 'vitest';
import type { ApiSpec, EmitterContext, Model, Operation, ResolvedOperation, Service } from '@workos/oagen';
import { defaultSdkBehavior, toPascalCase, toSnakeCase } from '@workos/oagen';
import { runSnippetEmitters } from '../../src/snippets/runner.js';
import { rubySnippetEmitter } from '../../src/snippets/ruby.js';

function makeSpec(services: Service[], models: Model[] = []): ApiSpec {
  return {
    name: 'Test',
    version: '1.0.0',
    baseUrl: '',
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

function makeCtx(spec: ApiSpec): EmitterContext {
  return {
    namespace: 'workos',
    namespacePascal: 'WorkOS',
    spec,
    resolvedOperations: buildResolvedOps(spec.services),
  };
}

function makeOp(overrides: Partial<Operation>): Operation {
  return {
    name: 'listOrganizations',
    httpMethod: 'get',
    path: '/organizations',
    pathParams: [],
    queryParams: [],
    headerParams: [],
    requestBody: undefined,
    response: { kind: 'model', name: 'Organization' },
    errors: [],
    injectIdempotencyKey: false,
    ...overrides,
  };
}

function runRuby(spec: ApiSpec): string[] {
  const results = runSnippetEmitters([rubySnippetEmitter], makeCtx(spec));
  return results.map((r) => r.content);
}

describe('snippets/ruby', () => {
  it('returns no snippets for an empty spec', () => {
    expect(runRuby(makeSpec([]))).toEqual([]);
  });

  it('renders a no-arg list call', () => {
    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [makeOp({ name: 'list_organizations' })],
      },
    ];
    const [content] = runRuby(makeSpec(services));
    expect(content).toBe(
      [
        'require "workos"',
        '',
        'WorkOS.configure do |config|',
        '  config.api_key = "sk_example_123456789"',
        'end',
        '',
        'WorkOS.client.organizations.list_organizations',
        '',
      ].join('\n'),
    );
  });

  it('renders a GET with a required path param as a keyword arg', () => {
    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [
          makeOp({
            name: 'get_organization',
            httpMethod: 'get',
            path: '/organizations/{id}',
            pathParams: [
              {
                name: 'id',
                type: { kind: 'primitive', type: 'string' },
                required: true,
                example: 'org_01EHZNVPK3SFK441A1RGBFSHRT',
              },
            ],
          }),
        ],
      },
    ];
    const [content] = runRuby(makeSpec(services));
    expect(content).toContain('WorkOS.client.organizations.get_organization(id: "org_01EHZNVPK3SFK441A1RGBFSHRT")');
  });

  it('renders a POST with body kwargs, expanding the request body model fields', () => {
    const models: Model[] = [
      {
        name: 'CreateOrganizationRequest',
        fields: [
          {
            name: 'name',
            type: { kind: 'primitive', type: 'string' },
            required: true,
            example: 'Foo Corp',
          },
          {
            name: 'domain_data',
            type: {
              kind: 'array',
              items: { kind: 'model', name: 'OrganizationDomainData' },
            },
            required: true,
          },
          {
            name: 'metadata',
            type: { kind: 'map', valueType: { kind: 'primitive', type: 'string' } },
            required: false,
          },
        ],
      },
      {
        name: 'OrganizationDomainData',
        fields: [
          {
            name: 'domain',
            type: { kind: 'primitive', type: 'string' },
            required: true,
            example: 'foo-corp.com',
          },
          {
            name: 'state',
            type: { kind: 'primitive', type: 'string' },
            required: true,
            example: 'pending',
          },
        ],
      },
    ];
    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [
          makeOp({
            name: 'create_organization',
            httpMethod: 'post',
            path: '/organizations',
            requestBody: { kind: 'model', name: 'CreateOrganizationRequest' },
            response: { kind: 'model', name: 'Organization' },
          }),
        ],
      },
    ];
    const [content] = runRuby(makeSpec(services, models));
    // Optional `metadata` is omitted from the snippet — only required fields show.
    expect(content).toContain('WorkOS.client.organizations.create_organization(');
    expect(content).toContain('name: "Foo Corp"');
    expect(content).toContain('domain_data:');
    expect(content).toContain('domain: "foo-corp.com"');
    expect(content).toContain('state: "pending"');
    expect(content).not.toContain('metadata');
  });

  it('renames body fields that collide with path params', () => {
    const models: Model[] = [
      {
        name: 'UpdateOrganizationRequest',
        fields: [
          {
            name: 'id',
            type: { kind: 'primitive', type: 'string' },
            required: true,
            example: 'override_id',
          },
        ],
      },
    ];
    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [
          makeOp({
            name: 'update_organization',
            httpMethod: 'put',
            path: '/organizations/{id}',
            pathParams: [
              {
                name: 'id',
                type: { kind: 'primitive', type: 'string' },
                required: true,
                example: 'org_123',
              },
            ],
            requestBody: { kind: 'model', name: 'UpdateOrganizationRequest' },
          }),
        ],
      },
    ];
    const [content] = runRuby(makeSpec(services, models));
    expect(content).toContain('id: "org_123"');
    expect(content).toContain('body_id: "override_id"');
  });

  it('skips URL-builder operations', () => {
    const services: Service[] = [
      {
        name: 'SSO',
        operations: [
          makeOp({
            name: 'get_authorization_url',
            httpMethod: 'get',
            path: '/sso/authorize',
          }),
        ],
      },
    ];
    const ctx = makeCtx(makeSpec(services));
    ctx.resolvedOperations![0]!.urlBuilder = true;
    const results = runSnippetEmitters([rubySnippetEmitter], ctx);
    expect(results).toEqual([]);
  });

  it('hides params injected via defaults/inferFromClient', () => {
    const models: Model[] = [
      {
        name: 'AuthenticateRequest',
        fields: [
          { name: 'grant_type', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'client_id', type: { kind: 'primitive', type: 'string' }, required: true },
          {
            name: 'email',
            type: { kind: 'primitive', type: 'string' },
            required: true,
            example: 'user@example.com',
          },
        ],
      },
    ];
    const services: Service[] = [
      {
        name: 'UserManagement',
        operations: [
          makeOp({
            name: 'authenticate',
            httpMethod: 'post',
            path: '/user_management/authenticate',
            requestBody: { kind: 'model', name: 'AuthenticateRequest' },
          }),
        ],
      },
    ];
    const ctx = makeCtx(makeSpec(services, models));
    ctx.resolvedOperations![0]!.defaults = { grant_type: 'password' };
    ctx.resolvedOperations![0]!.inferFromClient = ['client_id'];

    const results = runSnippetEmitters([rubySnippetEmitter], ctx);
    const content = results[0]!.content;
    expect(content).not.toContain('grant_type');
    expect(content).not.toContain('client_id');
    expect(content).toContain('email: "user@example.com"');
  });

  it('emits one snippet per split wrapper using the wrapper method name', () => {
    const models: Model[] = [
      {
        name: 'PasswordAuthenticateRequest',
        fields: [
          { name: 'grant_type', type: { kind: 'primitive', type: 'string' }, required: true },
          {
            name: 'email',
            type: { kind: 'primitive', type: 'string' },
            required: true,
            example: 'user@example.com',
          },
          {
            name: 'password',
            type: { kind: 'primitive', type: 'string' },
            required: true,
            example: 'hunter2',
          },
        ],
      },
    ];
    const services: Service[] = [
      {
        name: 'UserManagement',
        operations: [
          makeOp({
            name: 'authenticate',
            httpMethod: 'post',
            path: '/user_management/authenticate',
            requestBody: { kind: 'model', name: 'PasswordAuthenticateRequest' },
          }),
        ],
      },
    ];
    const ctx = makeCtx(makeSpec(services, models));
    ctx.resolvedOperations![0]!.wrappers = [
      {
        name: 'authenticate_with_password',
        targetVariant: 'PasswordAuthenticateRequest',
        defaults: { grant_type: 'password' },
        inferFromClient: ['client_id', 'client_secret'],
        exposedParams: ['email', 'password'],
        optionalParams: [],
        responseModelName: 'AuthenticationResponse',
      },
    ];

    const results = runSnippetEmitters([rubySnippetEmitter], ctx);
    const content = results[0]!.content;
    expect(content).toContain('WorkOS.client.user_management.authenticate_with_password(');
    expect(content).toContain('email: "user@example.com"');
    expect(content).toContain('password: "hunter2"');
  });
});
