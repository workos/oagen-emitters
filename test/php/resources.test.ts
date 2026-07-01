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
    expect(result[0].content).toContain("'organizations/' . rawurlencode($id)");
    expect(result[0].content).toContain('Organization::fromArray($response)');
  });

  it('reads the order param default from the spec rather than hardcoding desc', () => {
    const orderEnum = {
      name: 'PaginationOrder',
      values: [
        { name: 'desc', value: 'desc' },
        { name: 'asc', value: 'asc' },
      ],
    };
    const specWithOrder: ApiSpec = {
      ...emptySpec,
      enums: [orderEnum],
      services: [
        {
          name: 'Organizations',
          operations: [
            {
              name: 'listOrganizations',
              httpMethod: 'get',
              path: '/organizations',
              pathParams: [],
              queryParams: [
                { name: 'limit', type: { kind: 'primitive', type: 'integer' }, required: false },
                { name: 'after', type: { kind: 'primitive', type: 'string' }, required: false },
                {
                  name: 'order',
                  type: { kind: 'enum', name: 'PaginationOrder' },
                  required: false,
                  default: 'desc',
                },
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
          ],
        },
      ],
    };
    const content = generateResources(specWithOrder.services, { ...ctx, spec: specWithOrder })[0].content;
    // With a spec default, the param is non-nullable and defaults to the enum case.
    expect(content).toMatch(/PaginationOrder \$order = .*PaginationOrder::Desc/);
  });

  it('emits ?order = null when the spec carries no default for `order`', () => {
    const orderEnum = {
      name: 'PaginationOrder',
      values: [
        { name: 'desc', value: 'desc' },
        { name: 'asc', value: 'asc' },
      ],
    };
    const specNoDefault: ApiSpec = {
      ...emptySpec,
      enums: [orderEnum],
      services: [
        {
          name: 'Organizations',
          operations: [
            {
              name: 'listOrganizations',
              httpMethod: 'get',
              path: '/organizations',
              pathParams: [],
              queryParams: [
                { name: 'limit', type: { kind: 'primitive', type: 'integer' }, required: false },
                { name: 'after', type: { kind: 'primitive', type: 'string' }, required: false },
                { name: 'order', type: { kind: 'enum', name: 'PaginationOrder' }, required: false },
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
          ],
        },
      ],
    };
    const content = generateResources(specNoDefault.services, { ...ctx, spec: specNoDefault })[0].content;
    expect(content).toMatch(/\?\\WorkOS\\Resource\\PaginationOrder \$order = null/);
    expect(content).not.toMatch(/PaginationOrder::Desc/);
  });

  it('does not materialize optional query defaults for URL builders', () => {
    const screenHintEnum = {
      name: 'UserManagementAuthenticationScreenHint',
      values: [
        { name: 'sign_in', value: 'sign-in' },
        { name: 'sign_up', value: 'sign-up' },
      ],
    };
    const op = {
      name: 'getAuthorizationUrl',
      httpMethod: 'get' as const,
      path: '/user_management/authorize',
      pathParams: [],
      queryParams: [
        { name: 'redirect_uri', type: { kind: 'primitive' as const, type: 'string' as const }, required: true },
        {
          name: 'screen_hint',
          type: { kind: 'enum' as const, name: 'UserManagementAuthenticationScreenHint' },
          required: false,
          default: 'sign-in',
        },
      ],
      headerParams: [],
      response: { kind: 'primitive' as const, type: 'unknown' as const },
      errors: [],
      injectIdempotencyKey: false,
    };
    const service: Service = { name: 'UserManagement', operations: [op] };
    const spec: ApiSpec = { ...emptySpec, enums: [screenHintEnum], services: [service] };
    const content = generateResources([service], {
      ...ctx,
      spec,
      resolvedOperations: [
        {
          operation: op,
          service,
          methodName: 'get_authorization_url',
          mountOn: 'UserManagement',
          defaults: { response_type: 'code' },
          inferFromClient: ['client_id'],
          urlBuilder: true,
        },
      ],
    })[0].content;

    expect(content).toContain('?\\WorkOS\\Resource\\UserManagementAuthenticationScreenHint $screenHint = null');
    expect(content).toContain("'screen_hint' => $screenHint?->value");
    expect(content).not.toContain('UserManagementAuthenticationScreenHint::SignIn');
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

  it('uses body model field types for parameter group variant classes', () => {
    const membershipModels: Model[] = [
      {
        name: 'OrganizationMembership',
        fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
      {
        name: 'CreateOrganizationMembershipRequest',
        fields: [
          { name: 'user_id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'organization_id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'role_slug', type: { kind: 'primitive', type: 'string' }, required: false },
          {
            name: 'role_slugs',
            type: { kind: 'array', items: { kind: 'primitive', type: 'string' } },
            required: false,
          },
        ],
      },
    ];

    const membershipServices: Service[] = [
      {
        name: 'UserManagement',
        operations: [
          {
            name: 'createOrganizationMembership',
            httpMethod: 'post',
            path: '/user_management/organization_memberships',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            requestBody: { kind: 'model', name: 'CreateOrganizationMembershipRequest' },
            response: { kind: 'model', name: 'OrganizationMembership' },
            errors: [],
            injectIdempotencyKey: false,
            parameterGroups: [
              {
                name: 'role',
                optional: true,
                variants: [
                  {
                    name: 'single',
                    parameters: [{ name: 'role_slug', type: { kind: 'primitive', type: 'string' }, required: true }],
                  },
                  {
                    name: 'multiple',
                    parameters: [{ name: 'role_slugs', type: { kind: 'primitive', type: 'string' }, required: true }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];

    const spec = { ...emptySpec, services: membershipServices, models: membershipModels };
    const result = generateResources(membershipServices, { ...ctx, spec });
    const roleMultiple = result.find((file) => file.path === 'lib/Service/RoleMultiple.php');

    expect(roleMultiple).toBeDefined();
    expect(roleMultiple!.content).toContain('public readonly array $slugs');
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

  it('hides defaults and inferFromClient params from method signature', () => {
    const ssoServices: Service[] = [
      {
        name: 'SSO',
        operations: [
          {
            name: 'getAuthorizationUrl',
            httpMethod: 'get',
            path: '/sso/authorize',
            pathParams: [],
            queryParams: [
              { name: 'client_id', type: { kind: 'primitive', type: 'string' }, required: true },
              { name: 'response_type', type: { kind: 'primitive', type: 'string' }, required: true },
              { name: 'redirect_uri', type: { kind: 'primitive', type: 'string' }, required: true },
              { name: 'state', type: { kind: 'primitive', type: 'string' }, required: false },
            ],
            headerParams: [],
            response: { kind: 'primitive', type: 'unknown' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const ssoSpec = { ...emptySpec, services: ssoServices };
    const ssoCtx: EmitterContext = {
      ...ctx,
      spec: ssoSpec,
      resolvedOperations: [
        {
          operation: ssoServices[0].operations[0],
          service: ssoServices[0],
          methodName: 'get_authorization_url',
          mountOn: 'SSO',
          defaults: { response_type: 'code' },
          inferFromClient: ['client_id'],
        } as any,
      ],
    };

    const result = generateResources(ssoServices, ssoCtx);
    const content = result[0].content;

    // Should NOT include hidden params in method signature
    expect(content).not.toContain('$clientId');
    expect(content).not.toContain('$responseType');

    // Should include the remaining params
    expect(content).toContain('string $redirectUri');
    expect(content).toContain('?string $state');

    // Should inject default and inferred values into query
    expect(content).toContain("'response_type' => 'code'");
    expect(content).toContain("$query['client_id'] = $this->client->requireClientId()");

    // Redirect endpoint: should return string and build URL, not make HTTP request
    expect(content).toContain('): string {');
    expect(content).toContain('$this->client->buildUrl(');
    expect(content).not.toContain('$this->client->request(');
    expect(content).toContain('@return string');
    // Should pass $options to buildUrl for base URL overrides
    expect(content).toContain('$options);');
  });

  it('generates redirect endpoint that builds URL for GET with primitive unknown response', () => {
    const logoutServices: Service[] = [
      {
        name: 'SSO',
        operations: [
          {
            name: 'getLogoutUrl',
            httpMethod: 'get',
            path: '/sso/logout',
            pathParams: [],
            queryParams: [{ name: 'token', type: { kind: 'primitive', type: 'string' }, required: true }],
            headerParams: [],
            response: { kind: 'primitive', type: 'unknown' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const spec = { ...emptySpec, services: logoutServices };
    const result = generateResources(logoutServices, { ...ctx, spec });
    const content = result[0].content;

    expect(content).toContain('): string {');
    expect(content).toContain("return $this->client->buildUrl(path: 'sso/logout', query: $query, options: $options);");
    expect(content).not.toContain('$this->client->request(');
    expect(content).toContain('@return string');
  });

  it('skips base method when wrappers exist', () => {
    const authServices: Service[] = [
      {
        name: 'UserManagement',
        operations: [
          {
            name: 'authenticate',
            httpMethod: 'post',
            path: '/user_management/authenticate',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            requestBody: { kind: 'model', name: 'CreateOrganizationRequest' },
            response: { kind: 'model', name: 'Organization' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const authSpec = { ...emptySpec, services: authServices };
    const authCtx: EmitterContext = {
      ...ctx,
      spec: authSpec,
      resolvedOperations: [
        {
          operation: authServices[0].operations[0],
          service: authServices[0],
          methodName: 'authenticate',
          mountOn: 'UserManagement',
          wrappers: [
            {
              name: 'authenticate_with_password',
              targetVariant: 'PasswordSessionAuthenticateRequest',
              defaults: { grant_type: 'password' },
              inferFromClient: ['client_id', 'client_secret'],
              exposedParams: ['email'],
            },
          ],
        } as any,
      ],
    };

    const result = generateResources(authServices, authCtx);
    const content = result[0].content;

    // Wrapper method should be emitted
    expect(content).toContain('authenticateWithPassword');
    // Base method should NOT be emitted
    expect(content).not.toContain('public function authenticate(');
  });

  it('does not produce |null|null in PHPDoc for nullable optional body fields', () => {
    const nullableModels: Model[] = [
      ...models,
      {
        name: 'UpdateOrgRequest',
        fields: [
          {
            name: 'domain',
            type: { kind: 'nullable', inner: { kind: 'primitive', type: 'string' } },
            required: false,
          },
        ],
      },
    ];

    const nullableServices: Service[] = [
      {
        name: 'Organizations',
        operations: [
          {
            name: 'updateOrganization',
            httpMethod: 'put',
            path: '/organizations/{id}',
            pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
            queryParams: [],
            headerParams: [],
            requestBody: { kind: 'model', name: 'UpdateOrgRequest' },
            response: { kind: 'model', name: 'Organization' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const spec = { ...emptySpec, services: nullableServices, models: nullableModels };
    const result = generateResources(nullableServices, { ...ctx, spec });

    expect(result[0].content).toContain('string|null $domain');
    expect(result[0].content).not.toContain('|null|null');
  });

  it('hides body params from PHPDoc when in hiddenParams', () => {
    const tokenModels: Model[] = [
      ...models,
      {
        name: 'TokenRequest',
        fields: [
          { name: 'code', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'client_id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'client_secret', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'grant_type', type: { kind: 'primitive', type: 'string' }, required: true },
        ],
      },
    ];

    const tokenServices: Service[] = [
      {
        name: 'SSO',
        operations: [
          {
            name: 'getProfileAndToken',
            httpMethod: 'post',
            path: '/sso/token',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            requestBody: { kind: 'model', name: 'TokenRequest' },
            response: { kind: 'model', name: 'Organization' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const spec = { ...emptySpec, services: tokenServices, models: tokenModels };
    const tokenCtx: EmitterContext = {
      ...ctx,
      spec,
      resolvedOperations: [
        {
          operation: tokenServices[0].operations[0],
          service: tokenServices[0],
          methodName: 'get_profile_and_token',
          mountOn: 'SSO',
          defaults: { grant_type: 'authorization_code' },
          inferFromClient: ['client_id', 'client_secret'],
        } as any,
      ],
    };

    const result = generateResources(tokenServices, tokenCtx);
    const content = result[0].content;

    // Hidden params should not appear in PHPDoc
    expect(content).not.toContain('@param string $clientId');
    expect(content).not.toContain('@param string $clientSecret');
    expect(content).not.toContain('@param string $grantType');
    // Visible params should appear
    expect(content).toContain('@param string $code');

    // Body should NOT reference hidden fields as variables
    expect(content).not.toContain("'client_id' => $clientId");
    expect(content).not.toContain("'client_secret' => $clientSecret");
    expect(content).not.toContain("'grant_type' => $grantType");
    // Body should inject defaults and inferred fields
    expect(content).toContain("'grant_type' => 'authorization_code'");
    expect(content).toContain("$body['client_id'] = $this->client->requireClientId()");
    expect(content).toContain("$body['client_secret'] = $this->client->requireApiKey()");
    // Visible field should still be in the body array
    expect(content).toContain("'code' => $code");
    // Developer should only need to pass code
    expect(content).toContain('public function getProfileAndToken(');
    expect(content).toMatch(/function getProfileAndToken\(\s*string \$code/);
  });

  it('serializes required date-time body fields via RFC3339_EXTENDED', () => {
    const dtModels: Model[] = [
      {
        name: 'ExportCreation',
        fields: [
          { name: 'organization_id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'range_start', type: { kind: 'primitive', type: 'string', format: 'date-time' }, required: true },
          { name: 'range_end', type: { kind: 'primitive', type: 'string', format: 'date-time' }, required: true },
        ],
      },
      { name: 'Export', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
    ];
    const dtServices: Service[] = [
      {
        name: 'AuditLogs',
        operations: [
          {
            name: 'createExport',
            httpMethod: 'post',
            path: '/audit_logs/exports',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            requestBody: { kind: 'model', name: 'ExportCreation' },
            response: { kind: 'model', name: 'Export' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];
    const dtSpec: ApiSpec = { ...emptySpec, models: dtModels, services: dtServices };
    const content = generateResources(dtServices, { ...ctx, spec: dtSpec })[0].content;

    // date-time body fields must be formatted, not passed as raw \DateTimeImmutable
    expect(content).toContain("'range_start' => $rangeStart->format(\\DateTimeInterface::RFC3339_EXTENDED)");
    expect(content).toContain("'range_end' => $rangeEnd->format(\\DateTimeInterface::RFC3339_EXTENDED)");
    // plain string fields are unaffected
    expect(content).toContain("'organization_id' => $organizationId");
  });
});
