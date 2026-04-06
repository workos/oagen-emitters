import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Service, Operation, Model } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateResources } from '../../src/go/resources.js';

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

function makeCtx(spec: ApiSpec): EmitterContext {
  return {
    namespace: 'workos',
    namespacePascal: 'WorkOS',
    spec,
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

describe('go/resources', () => {
  it('returns empty for no services', () => {
    const spec = makeSpec([]);
    expect(generateResources([], makeCtx(spec))).toEqual([]);
  });

  it('generates a service file with methods', () => {
    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [
          makeOp({
            name: 'listOrganizations',
            httpMethod: 'get',
            path: '/organizations',
            queryParams: [
              {
                name: 'limit',
                type: { kind: 'primitive', type: 'integer' },
                required: false,
              },
            ],
            pagination: {
              strategy: 'cursor',
              param: 'after',
              dataPath: 'data',
              itemType: { kind: 'model', name: 'Organization' },
            },
          }),
          makeOp({
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
          }),
          makeOp({
            name: 'createOrganization',
            httpMethod: 'post',
            path: '/organizations',
            requestBody: { kind: 'model', name: 'CreateOrganizationRequest' },
          }),
          makeOp({
            name: 'deleteOrganization',
            httpMethod: 'delete',
            path: '/organizations/{id}',
            pathParams: [
              {
                name: 'id',
                type: { kind: 'primitive', type: 'string' },
                required: true,
              },
            ],
            response: { kind: 'primitive', type: 'unknown' },
          }),
        ],
      },
    ];
    const spec = makeSpec(services, [
      {
        name: 'CreateOrganizationRequest',
        fields: [{ name: 'name', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ]);
    const ctx = makeCtx(spec);
    const files = generateResources(services, ctx);

    expect(files.length).toBeGreaterThanOrEqual(1);
    const content = files[0].content;
    expect(content).toContain('package workos');
    expect(content).toContain('type organizationService struct {');
    expect(content).toContain('Limit *int `url:"limit,omitempty" json:"-"`');
    expect(content).toContain('func (s *organizationService) List(');
    expect(content).toContain('func (s *organizationService) Get(');
    expect(content).toContain('func (s *organizationService) Create(');
    expect(content).toContain('func (s *organizationService) Delete(');
  });

  it('generates path interpolation with fmt.Sprintf', () => {
    const services: Service[] = [
      {
        name: 'Users',
        operations: [
          makeOp({
            name: 'getUser',
            httpMethod: 'get',
            path: '/users/{id}',
            pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
          }),
        ],
      },
    ];
    const spec = makeSpec(services);
    const files = generateResources(services, makeCtx(spec));
    const content = files[0].content;
    expect(content).toContain('fmt.Sprintf("/users/%s", id)');
  });

  it('generates paginated methods returning Iterator', () => {
    const services: Service[] = [
      {
        name: 'Users',
        operations: [
          makeOp({
            name: 'listUsers',
            httpMethod: 'get',
            path: '/users',
            pagination: {
              strategy: 'cursor',
              param: 'after',
              dataPath: 'data',
              itemType: { kind: 'model', name: 'User' },
            },
          }),
        ],
      },
    ];
    const spec = makeSpec(services);
    const files = generateResources(services, makeCtx(spec));
    const content = files[0].content;
    expect(content).toContain('*Iterator[User]');
    expect(content).toContain('newIterator[User](ctx, s.client, "GET", "/users", nil, "after", "data", opts)');
  });

  it('generates delete methods returning error', () => {
    const services: Service[] = [
      {
        name: 'Items',
        operations: [
          makeOp({
            name: 'deleteItem',
            httpMethod: 'delete',
            path: '/items/{id}',
            pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
            response: { kind: 'primitive', type: 'unknown' },
          }),
        ],
      },
    ];
    const spec = makeSpec(services);
    const files = generateResources(services, makeCtx(spec));
    const content = files[0].content;
    expect(content).toContain(') error {');
    expect(content).toContain('return err');
  });

  it('generates params struct for body + query params', () => {
    const services: Service[] = [
      {
        name: 'Users',
        operations: [
          makeOp({
            name: 'createUser',
            httpMethod: 'post',
            path: '/users',
            requestBody: { kind: 'model', name: 'CreateUserRequest' },
            queryParams: [
              {
                name: 'notify',
                type: { kind: 'primitive', type: 'boolean' },
                required: false,
              },
            ],
          }),
        ],
      },
    ];
    const spec = makeSpec(services, [
      {
        name: 'CreateUserRequest',
        fields: [{ name: 'email', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ]);
    const files = generateResources(services, makeCtx(spec));
    const content = files[0].content;
    expect(content).toContain('type UsersCreateParams struct {');
    expect(content).toContain('Email string `json:"email"`');
    expect(content).toContain('Notify *bool `url:"notify,omitempty" json:"-"`');
    expect(content).toContain('request(ctx, "POST", "/users", params, params, &result, opts)');
  });

  it('uses params.Body for non-model request bodies', () => {
    const services: Service[] = [
      {
        name: 'Connect',
        operations: [
          makeOp({
            name: 'createApplications',
            httpMethod: 'post',
            path: '/connect/applications',
            requestBody: { kind: 'primitive', type: 'unknown' },
            response: { kind: 'model', name: 'ConnectApplication' },
          }),
        ],
      },
    ];
    const spec = makeSpec(services);
    const files = generateResources(services, makeCtx(spec));
    const content = files[0].content;
    expect(content).toContain('type ConnectCreateApplicationsParams struct {');
    expect(content).toContain('Body interface{} `json:"-"`');
    expect(content).toContain('request(ctx, "POST", "/connect/applications", nil, params.Body, &result, opts)');
  });
});
