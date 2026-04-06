import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Service, Model } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateResources } from '../../src/php/resources.js';
import { generateWrapperMethods } from '../../src/php/wrappers.js';

const models: Model[] = [
  {
    name: 'Organization',
    fields: [
      { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
      { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
    ],
  },
  {
    name: 'CreateOrganizationRequest',
    fields: [
      { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
      { name: 'slug', type: { kind: 'primitive', type: 'string' }, required: false },
    ],
  },
];

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
      {
        name: 'listOrganizations',
        httpMethod: 'get',
        path: '/organizations',
        pathParams: [],
        queryParams: [
          { name: 'limit', type: { kind: 'primitive', type: 'integer' }, required: false },
          { name: 'after', type: { kind: 'primitive', type: 'string' }, required: false },
        ],
        headerParams: [],
        response: { kind: 'model', name: 'Organization' },
        errors: [],
        pagination: {
          strategy: 'cursor',
          param: 'after',
          dataPath: 'data',
          itemType: { kind: 'model', name: 'Organization' },
        },
        injectIdempotencyKey: false,
      },
      {
        name: 'createOrganization',
        httpMethod: 'post',
        path: '/organizations',
        pathParams: [],
        queryParams: [],
        headerParams: [],
        requestBody: { kind: 'model', name: 'CreateOrganizationRequest' },
        response: { kind: 'model', name: 'Organization' },
        errors: [],
        injectIdempotencyKey: false,
      },
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

const emptySpec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: '',
  services,
  models,
  enums: [],
  sdk: defaultSdkBehavior(),
};

const ctx: EmitterContext = {
  namespace: 'workos',
  namespacePascal: 'WorkOS',
  spec: emptySpec,
};

describe('generateResources', () => {
  it('returns empty array for no services', () => {
    expect(generateResources([], ctx)).toEqual([]);
  });

  it('generates a resource class with methods', () => {
    const result = generateResources(services, ctx);

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('lib/Service/Organizations.php');
    expect(result[0].content).toContain('class Organizations');
    expect(result[0].content).toContain('private readonly \\WorkOS\\HttpClient $client');
  });

  it('generates GET by ID method with path interpolation', () => {
    const result = generateResources(services, ctx);

    expect(result[0].content).toContain('public function getOrganization(');
    expect(result[0].content).toContain('string $id');
    expect(result[0].content).toContain('"organizations/{$id}"');
    expect(result[0].content).toContain('Organization::fromArray($response)');
  });

  it('generates paginated list method', () => {
    const result = generateResources(services, ctx);

    expect(result[0].content).toContain('public function listOrganizations(');
    expect(result[0].content).toContain('?int $limit = null');
    expect(result[0].content).toContain('PaginatedResponse');
    expect(result[0].content).toContain('$this->client->requestPage(');
    expect(result[0].content).toContain('modelClass: Organization::class');
    expect(result[0].content).not.toContain('PaginatedResponse::fromArray($response, Organization::class)');
  });

  it('generates create method with body params', () => {
    const result = generateResources(services, ctx);

    expect(result[0].content).toContain('public function createOrganization(');
    expect(result[0].content).toContain('string $name');
    expect(result[0].content).toContain('?string $slug = null');
  });

  it('generates delete method returning void', () => {
    const result = generateResources(services, ctx);

    expect(result[0].content).toContain('): void');
  });

  it('generates correct namespace', () => {
    const result = generateResources(services, ctx);

    expect(result[0].content).toContain('namespace WorkOS\\Service;');
  });

  it('generates DELETE method with body params', () => {
    const deleteBodyModels: Model[] = [
      {
        name: 'DeleteRoleAssignmentsRequest',
        fields: [
          {
            name: 'permissions',
            type: { kind: 'array', items: { kind: 'primitive', type: 'string' } },
            required: true,
          },
        ],
      },
    ];

    const deleteBodyServices: Service[] = [
      {
        name: 'Authorization',
        operations: [
          {
            name: 'deleteRoleAssignments',
            httpMethod: 'delete',
            path: '/roles/{slug}/assignments',
            pathParams: [{ name: 'slug', type: { kind: 'primitive', type: 'string' }, required: true }],
            queryParams: [],
            headerParams: [],
            requestBody: { kind: 'model', name: 'DeleteRoleAssignmentsRequest' },
            response: { kind: 'primitive', type: 'unknown' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const spec = { ...emptySpec, services: deleteBodyServices, models: deleteBodyModels };
    const result = generateResources(deleteBodyServices, { ...ctx, spec });

    expect(result[0].content).toContain('body: $body,');
    expect(result[0].content).toContain("'permissions' => $permissions,");
  });

  it('generates DELETE method with query params', () => {
    const deleteQueryServices: Service[] = [
      {
        name: 'Authorization',
        operations: [
          {
            name: 'deleteResource',
            httpMethod: 'delete',
            path: '/resources/{id}',
            pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
            queryParams: [{ name: 'cascade_delete', type: { kind: 'primitive', type: 'boolean' }, required: false }],
            headerParams: [],
            response: { kind: 'primitive', type: 'unknown' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const spec = { ...emptySpec, services: deleteQueryServices };
    const result = generateResources(deleteQueryServices, { ...ctx, spec });

    expect(result[0].content).toContain('query: $query,');
    expect(result[0].content).toContain("'cascade_delete' => $cascadeDelete,");
  });

  it('generates array response with array_map', () => {
    const arrayModels: Model[] = [
      {
        name: 'ClientSecret',
        fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ];

    const arrayServices: Service[] = [
      {
        name: 'Applications',
        operations: [
          {
            name: 'listClientSecrets',
            httpMethod: 'get',
            path: '/applications/{id}/secrets',
            pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
            queryParams: [],
            headerParams: [],
            response: { kind: 'array', items: { kind: 'model', name: 'ClientSecret' } },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const spec = { ...emptySpec, services: arrayServices, models: arrayModels };
    const result = generateResources(arrayServices, { ...ctx, spec });

    expect(result[0].content).toContain('array_map(fn ($item) => ClientSecret::fromArray($item), $response)');
  });

  it('disambiguates body field from path param with same name', () => {
    const collisionModels: Model[] = [
      {
        name: 'CreateRolePermissionRequest',
        fields: [{ name: 'slug', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ];

    const collisionServices: Service[] = [
      {
        name: 'Authorization',
        operations: [
          {
            name: 'createRolePermissions',
            httpMethod: 'post',
            path: '/roles/{slug}/permissions',
            pathParams: [{ name: 'slug', type: { kind: 'primitive', type: 'string' }, required: true }],
            queryParams: [],
            headerParams: [],
            requestBody: { kind: 'model', name: 'CreateRolePermissionRequest' },
            response: { kind: 'primitive', type: 'unknown' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const spec = { ...emptySpec, services: collisionServices, models: collisionModels };
    const result = generateResources(collisionServices, { ...ctx, spec });

    // Should have both $slug (path) and $bodySlug (body) params
    expect(result[0].content).toContain('string $slug');
    expect(result[0].content).toContain('string $bodySlug');
    expect(result[0].content).toContain("'slug' => $bodySlug,");
  });

  it('adds @deprecated PHPDoc for deprecated operations', () => {
    const deprecatedServices: Service[] = [
      {
        name: 'Organizations',
        operations: [
          {
            name: 'getOrganizationOld',
            httpMethod: 'get',
            path: '/organizations/{id}',
            pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model', name: 'Organization' },
            errors: [],
            injectIdempotencyKey: false,
            deprecated: true,
          },
        ],
      },
    ];

    const spec = { ...emptySpec, services: deprecatedServices };
    const result = generateResources(deprecatedServices, { ...ctx, spec });

    expect(result[0].content).toContain('@deprecated');
  });

  it('adds description in PHPDoc for operations with description', () => {
    const describedServices: Service[] = [
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
            description: 'Fetch a single organization by ID',
          },
        ],
      },
    ];

    const spec = { ...emptySpec, services: describedServices };
    const result = generateResources(describedServices, { ...ctx, spec });

    expect(result[0].content).toContain('Fetch a single organization by ID');
  });

  it('adds (deprecated) prefix in @param for deprecated path params', () => {
    const deprecatedParamServices: Service[] = [
      {
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
                deprecated: true,
                description: 'The organization ID',
              },
            ],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model', name: 'Organization' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const spec = { ...emptySpec, services: deprecatedParamServices };
    const result = generateResources(deprecatedParamServices, { ...ctx, spec });

    expect(result[0].content).toContain('(deprecated) The organization ID');
  });

  it('requires inferred client credentials in wrapper methods', () => {
    const lines = generateWrapperMethods(
      {
        operation: {
          name: 'authenticate',
          httpMethod: 'post',
          path: '/user_management/authenticate',
          pathParams: [],
          queryParams: [],
          headerParams: [],
          response: { kind: 'model', name: 'Organization' },
          errors: [],
          injectIdempotencyKey: false,
        },
        service: services[0],
        methodName: 'authenticate',
        mountOn: 'Organizations',
        wrappers: [
          {
            name: 'authenticate_with_password',
            targetVariant: 'PasswordSessionAuthenticateRequest',
            defaults: { grant_type: 'password' },
            inferFromClient: ['client_id', 'client_secret'],
            exposedParams: ['email'],
          },
        ],
      } as never,
      ctx,
    ).join('\n');

    expect(lines).toContain("$body['client_id'] = $this->client->requireClientId();");
    expect(lines).toContain("$body['client_secret'] = $this->client->requireApiKey();");
    expect(lines).not.toContain('\\WorkOS\\WorkOS::getClientId()');
    expect(lines).not.toContain('\\WorkOS\\WorkOS::getApiKey()');
  });
});
