import { describe, it, expect } from 'vitest';
import { generateResources } from '../../src/dotnet/resources.js';
import { primeEnumAliases } from '../../src/dotnet/enums.js';
import type { EmitterContext, ApiSpec, Service, Model } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';

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

describe('dotnet/resources', () => {
  it('returns empty for no services', () => {
    primeEnumAliases([]);
    expect(generateResources([], ctx)).toEqual([]);
  });

  it('generates a service class with methods', () => {
    const models: Model[] = [
      {
        name: 'Organization',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
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

    primeEnumAliases([]);
    const ctxWithServices: EmitterContext = {
      ...ctx,
      spec: { ...emptySpec, services, models },
    };

    const files = generateResources(services, ctxWithServices);
    expect(files.length).toBeGreaterThanOrEqual(1);

    const serviceFile = files.find((f) => f.path.includes('OrganizationsService.cs'))!;
    expect(serviceFile).toBeDefined();

    const content = serviceFile.content;
    // Namespace and class
    expect(content).toContain('namespace WorkOS');
    expect(content).toContain('public class OrganizationsService : Service');

    // GET method
    expect(content).toContain('GetAsync');
    expect(content).toContain('async Task');

    // DELETE method
    expect(content).toContain('DeleteAsync');
  });

  it('qualifies delete helper calls with base. when a generated DeleteAsync would capture them', () => {
    const stringParam = (name: string) => ({
      name,
      type: { kind: 'primitive', type: 'string' } as const,
      required: true,
    });
    const deleteOp = (name: string, path: string, pathParams: string[]) => ({
      name,
      httpMethod: 'delete' as const,
      path,
      pathParams: pathParams.map(stringParam),
      queryParams: [],
      headerParams: [],
      response: { kind: 'primitive', type: 'unknown' } as const,
      errors: [],
      injectIdempotencyKey: false,
    });

    const services: Service[] = [
      {
        // Bare `delete` op with two path params emits DeleteAsync(string, string, ...),
        // which hides Service.DeleteAsync from the 4-argument helper calls.
        name: 'ItContacts',
        operations: [
          deleteOp('delete', '/organizations/{organization_id}/it_contacts/{contact_id}', [
            'organization_id',
            'contact_id',
          ]),
          // Sibling delete in the same class is captured too and must also use base.
          deleteOp('deleteInvitation', '/organizations/{organization_id}/it_contacts/{contact_id}/invitation', [
            'organization_id',
            'contact_id',
          ]),
        ],
      },
      {
        // One leading param: DeleteAsync(string, RequestOptions?, CT) cannot take the
        // 4-argument call, so `this.` still reaches the helper — and `base.` here
        // would trip StyleCop SA1100.
        name: 'Widgets',
        operations: [deleteOp('delete', '/widgets/{id}', ['id'])],
      },
    ];

    primeEnumAliases([]);
    const ctxWithServices: EmitterContext = {
      ...ctx,
      spec: { ...emptySpec, services, models: [] },
    };

    const files = generateResources(services, ctxWithServices);
    const itContacts = files.find((f) => f.path.includes('ItContactsService.cs'))!.content;
    const widgets = files.find((f) => f.path.includes('WidgetsService.cs'))!.content;

    expect(itContacts).toContain(
      'await base.DeleteAsync($"/organizations/{Uri.EscapeDataString(organizationId)}/it_contacts/{Uri.EscapeDataString(contactId)}", null, requestOptions, cancellationToken);',
    );
    expect(itContacts).not.toContain('await this.DeleteAsync(');
    expect(widgets).toContain(
      'await this.DeleteAsync($"/widgets/{Uri.EscapeDataString(id)}", null, requestOptions, cancellationToken);',
    );
    expect(widgets).not.toContain('await base.DeleteAsync(');
  });

  it('counts a bearer-override parameter when detecting DeleteAsync capture', () => {
    const models: Model[] = [
      {
        name: 'RevokeSessionRequest',
        fields: [{ name: 'session_id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ];

    const services: Service[] = [
      {
        name: 'Sessions',
        operations: [
          {
            // Bearer override + typed options and no path params: emits
            // DeleteAsync(string accessToken, SessionsDeleteOptions options, ...) —
            // two leading params, so it captures the sibling's 4-argument call.
            // Its own body uses the inlined WorkOSRequest form (bearer overrides
            // never reach the helper one-liner).
            name: 'delete',
            httpMethod: 'delete' as const,
            path: '/sessions',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            requestBody: { kind: 'model', name: 'RevokeSessionRequest' } as const,
            response: { kind: 'primitive', type: 'unknown' } as const,
            errors: [],
            injectIdempotencyKey: false,
            security: [{ schemeName: 'access_token', scopes: [] }],
          },
          {
            name: 'deleteToken',
            httpMethod: 'delete' as const,
            path: '/sessions/tokens/{id}',
            pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
            queryParams: [],
            headerParams: [],
            response: { kind: 'primitive', type: 'unknown' } as const,
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    primeEnumAliases([]);
    const ctxWithServices: EmitterContext = {
      ...ctx,
      spec: { ...emptySpec, services, models },
    };

    const files = generateResources(services, ctxWithServices);
    const sessions = files.find((f) => f.path.includes('SessionsService.cs'))!.content;

    // The bearer-override delete keeps the inlined request form — no helper
    // call it could recurse into.
    expect(sessions).toContain('AccessToken = accessToken,');
    expect(sessions).not.toContain('this.DeleteAsync("/sessions"');
    expect(sessions).not.toContain('base.DeleteAsync("/sessions"');
    // The sibling's null-argument call is captured by the two-leading-parameter
    // DeleteAsync signature and must be qualified with base.
    expect(sessions).toContain(
      'await base.DeleteAsync($"/sessions/tokens/{Uri.EscapeDataString(id)}", null, requestOptions, cancellationToken);',
    );
  });

  it('mirrors emission-loop name reservation for union-split wrappers named DeleteAsync', () => {
    const deleteOp = (name: string, path: string, pathParams: string[]) => ({
      name,
      httpMethod: 'delete' as const,
      path,
      pathParams: pathParams.map((p) => ({
        name: p,
        type: { kind: 'primitive', type: 'string' } as const,
        required: true,
      })),
      queryParams: [],
      headerParams: [],
      response: { kind: 'primitive', type: 'unknown' } as const,
      errors: [],
      injectIdempotencyKey: false,
    });
    const deleteWrapper = {
      name: 'delete',
      targetVariant: 'RevokeRequest',
      defaults: {},
      inferFromClient: [],
      exposedParams: [],
    };

    const services: Service[] = [
      {
        // The `delete` wrapper claims the DeleteAsync name and emits
        // DeleteAsync(TokensDeleteOptions, ...) — one leading parameter, so it
        // captures nothing. The suppressed two-path-param op must NOT be
        // treated as capturing: `base.` in the sibling would trip SA1100.
        name: 'Tokens',
        operations: [
          deleteOp('revokeAll', '/tokens', []),
          deleteOp('delete', '/tokens/{group_id}/{token_id}', ['group_id', 'token_id']),
          deleteOp('deleteThing', '/tokens/things/{id}', ['id']),
        ],
      },
      {
        // Here the union-split op has one path param, so the `delete` wrapper
        // emits DeleteAsync(string, GrantsDeleteOptions, ...) — two leading
        // parameters. It captures the sibling's null-argument call AND its own
        // helper call, so both must be qualified with base.
        name: 'Grants',
        operations: [
          deleteOp('revokeAll', '/grants/{id}/revoke', ['id']),
          deleteOp('deleteThing', '/grants/things/{id}', ['id']),
        ],
      },
    ];

    // Resolve every op (real runs do — generateResources groups by the
    // resolved set when one is present); the `revokeAll` ops are union-split.
    const resolvedOperations = services.flatMap((service) =>
      service.operations.map((operation) => ({
        service,
        operation,
        methodName: operation.name,
        mountOn: service.name,
        ...(operation.name === 'revokeAll' ? { wrappers: [deleteWrapper] } : {}),
      })),
    ) as never[];

    primeEnumAliases([]);
    const ctxWithServices: EmitterContext = {
      ...ctx,
      spec: { ...emptySpec, services, models: [] },
      resolvedOperations: resolvedOperations as never,
    };

    const files = generateResources(services, ctxWithServices);
    const tokens = files.find((f) => f.path.includes('TokensService.cs'))!.content;
    const grants = files.find((f) => f.path.includes('GrantsService.cs'))!.content;

    // Tokens: wrapper DeleteAsync exists but does not capture; the suppressed
    // raw op leaves no two-string-param overload behind.
    expect(tokens).toContain('public async Task DeleteAsync(DeleteOptions options');
    expect(tokens).not.toContain('DeleteAsync(string groupId');
    expect(tokens).not.toContain('await base.DeleteAsync(');
    expect(tokens).toContain(
      'await this.DeleteAsync($"/tokens/things/{Uri.EscapeDataString(id)}", null, requestOptions, cancellationToken);',
    );

    // Grants: the capturing wrapper qualifies its own call and the sibling's.
    expect(grants).toContain(
      'await base.DeleteAsync($"/grants/{Uri.EscapeDataString(id)}/revoke", options, requestOptions, cancellationToken);',
    );
    expect(grants).toContain(
      'await base.DeleteAsync($"/grants/things/{Uri.EscapeDataString(id)}", null, requestOptions, cancellationToken);',
    );
    expect(grants).not.toContain('await this.DeleteAsync(');
  });

  it('generates options classes for operations with params', () => {
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
        fields: [{ name: 'name', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ];

    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [
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
        ],
      },
    ];

    primeEnumAliases([]);
    const ctxWithServices: EmitterContext = {
      ...ctx,
      spec: { ...emptySpec, services, models },
    };

    const files = generateResources(services, ctxWithServices);
    const optionsFile = files.find((f) => f.path.includes('Options.cs'))!;
    expect(optionsFile).toBeDefined();

    const content = optionsFile.content;
    expect(content).toContain('Options');
    expect(content).toContain('public string Name');
    // Convention-based naming — no per-property JSON attributes
    expect(content).not.toContain('[JsonProperty("name")]');
  });

  it('generates paginated list method with auto-pagination', () => {
    const models: Model[] = [
      {
        name: 'Organization',
        fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
      {
        name: 'OrganizationList',
        fields: [
          {
            name: 'data',
            type: { kind: 'array', items: { kind: 'model', name: 'Organization' } },
            required: true,
          },
          {
            name: 'list_metadata',
            type: { kind: 'model', name: 'ListMetadata' },
            required: true,
          },
        ],
      },
    ];

    const services: Service[] = [
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
            ],
            headerParams: [],
            response: { kind: 'model', name: 'OrganizationList' },
            errors: [],
            injectIdempotencyKey: false,
            pagination: {
              strategy: 'cursor',
              param: 'after',
              dataPath: 'data',
              itemType: { kind: 'model', name: 'Organization' },
            },
          },
        ],
      },
    ];

    primeEnumAliases([]);
    const ctxWithServices: EmitterContext = {
      ...ctx,
      spec: { ...emptySpec, services, models },
    };

    const files = generateResources(services, ctxWithServices);
    const serviceFile = files.find((f) => f.path.includes('OrganizationsService.cs'))!;
    const content = serviceFile.content;

    // List method (return type is async Task)
    expect(content).toContain('async Task<WorkOSList<Organization>>');
    expect(content).toContain('ListAsync(');

    // Auto-pagination method
    expect(content).toContain('ListAutoPagingAsync');
    expect(content).toContain('IAsyncEnumerable<Organization>');
  });

  it('generates deprecated operations with Obsolete attribute', () => {
    const models: Model[] = [
      {
        name: 'Organization',
        fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
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
            deprecated: true,
          },
        ],
      },
    ];

    primeEnumAliases([]);
    const ctxWithServices: EmitterContext = {
      ...ctx,
      spec: { ...emptySpec, services, models },
    };

    const files = generateResources(services, ctxWithServices);
    const serviceFile = files.find((f) => f.path.includes('OrganizationsService.cs'))!;

    expect(serviceFile.content).toContain('[System.Obsolete');
  });

  it('generates parameter group abstract base + variant classes and query serialization', () => {
    const models: Model[] = [
      {
        name: 'Authorization',
        fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
      {
        name: 'AuthorizationList',
        fields: [
          {
            name: 'data',
            type: { kind: 'array', items: { kind: 'model', name: 'Authorization' } },
            required: true,
          },
          {
            name: 'list_metadata',
            type: { kind: 'model', name: 'ListMetadata' },
            required: true,
          },
        ],
      },
    ];

    const services: Service[] = [
      {
        name: 'Fga',
        operations: [
          {
            name: 'listAuthorizations',
            httpMethod: 'get',
            path: '/fga/authorizations',
            pathParams: [],
            queryParams: [
              { name: 'limit', type: { kind: 'primitive', type: 'integer' }, required: false },
              { name: 'after', type: { kind: 'primitive', type: 'string' }, required: false },
              { name: 'parent_resource_id', type: { kind: 'primitive', type: 'string' }, required: false },
              { name: 'parent_resource_type_slug', type: { kind: 'primitive', type: 'string' }, required: false },
              { name: 'parent_resource_external_id', type: { kind: 'primitive', type: 'string' }, required: false },
            ],
            headerParams: [],
            response: { kind: 'model', name: 'AuthorizationList' },
            errors: [],
            injectIdempotencyKey: false,
            pagination: {
              strategy: 'cursor',
              param: 'after',
              dataPath: 'data',
              itemType: { kind: 'model', name: 'Authorization' },
            },
            parameterGroups: [
              {
                name: 'parent_resource',
                optional: false,
                variants: [
                  {
                    name: 'by_id',
                    parameters: [
                      { name: 'parent_resource_id', type: { kind: 'primitive', type: 'string' }, required: true },
                    ],
                  },
                  {
                    name: 'by_external_id',
                    parameters: [
                      {
                        name: 'parent_resource_type_slug',
                        type: { kind: 'primitive', type: 'string' },
                        required: true,
                      },
                      {
                        name: 'parent_resource_external_id',
                        type: { kind: 'primitive', type: 'string' },
                        required: true,
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];

    primeEnumAliases([]);
    const ctxWithServices: EmitterContext = {
      ...ctx,
      spec: { ...emptySpec, services, models },
    };

    const files = generateResources(services, ctxWithServices);

    // Options file should exist and contain group types
    const optionsFile = files.find((f) => f.path.includes('Options.cs'))!;
    expect(optionsFile).toBeDefined();
    const optContent = optionsFile.content;

    // Abstract base class (prefixed with service name)
    expect(optContent).toContain('public abstract class FGAParentResource { }');

    // Concrete variant: ById
    expect(optContent).toContain('public class FGAParentResourceById : FGAParentResource');
    expect(optContent).toContain('public string ParentResourceId { get; set; } = default!;');

    // Concrete variant: ByExternalId
    expect(optContent).toContain('public class FGAParentResourceByExternalId : FGAParentResource');
    expect(optContent).toContain('public string ParentResourceTypeSlug { get; set; } = default!;');
    expect(optContent).toContain('public string ParentResourceExternalId { get; set; } = default!;');

    // Group property on options class with JsonIgnore
    expect(optContent).toContain('[JsonIgnore]');
    expect(optContent).toContain('[STJS.JsonIgnore]');
    expect(optContent).toContain('public FGAParentResource ParentResource { get; set; } = default!;');

    // Grouped params should NOT appear as individual properties
    expect(optContent).not.toMatch(/\[JsonProperty\("parent_resource_id"\)\]/);
    expect(optContent).not.toMatch(/\[JsonProperty\("parent_resource_type_slug"\)\]/);
    expect(optContent).not.toMatch(/\[JsonProperty\("parent_resource_external_id"\)\]/);

    // Service file should contain group query serialization
    const serviceFile = files.find((f) => f.path.endsWith('Service.cs'))!;
    expect(serviceFile).toBeDefined();
    const svcContent = serviceFile.content;

    // Pattern matching for group variants
    expect(svcContent).toContain('ParentResourceById');
    expect(svcContent).toContain('ParentResourceByExternalId');
    expect(svcContent).toContain('AddQueryParam("parent_resource_id"');
    expect(svcContent).toContain('AddQueryParam("parent_resource_type_slug"');
    expect(svcContent).toContain('AddQueryParam("parent_resource_external_id"');
  });

  it('emits optional variant members as trailing nullable properties omitted from the body when unset', () => {
    const models: Model[] = [
      {
        name: 'User',
        fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
      {
        name: 'CreateUserRequest',
        fields: [
          { name: 'email', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'password', type: { kind: 'primitive', type: 'string' }, required: false },
          { name: 'password_hash', type: { kind: 'primitive', type: 'string' }, required: false },
          {
            name: 'password_hash_type',
            type: { kind: 'enum', name: 'CreateUserPasswordHashType' },
            required: false,
          },
          {
            name: 'password_salt_position',
            type: { kind: 'enum', name: 'CreateUserPasswordSaltPosition' },
            required: false,
          },
        ],
      },
    ];

    const services: Service[] = [
      {
        name: 'UserManagement',
        operations: [
          {
            name: 'createUser',
            httpMethod: 'post',
            path: '/user_management/users',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            requestBody: { kind: 'model', name: 'CreateUserRequest' },
            response: { kind: 'model', name: 'User' },
            errors: [],
            injectIdempotencyKey: false,
            parameterGroups: [
              {
                name: 'password',
                optional: true,
                variants: [
                  {
                    name: 'plaintext',
                    parameters: [{ name: 'password', type: { kind: 'primitive', type: 'string' }, required: false }],
                  },
                  {
                    name: 'hashed',
                    parameters: [
                      { name: 'password_hash', type: { kind: 'primitive', type: 'string' }, required: false },
                      // The optional member is listed first on purpose: the
                      // emitter must move it after the required members.
                      {
                        name: 'password_salt_position',
                        type: { kind: 'enum', name: 'CreateUserPasswordSaltPosition' },
                        required: false,
                      },
                      {
                        name: 'password_hash_type',
                        type: { kind: 'enum', name: 'CreateUserPasswordHashType' },
                        required: false,
                      },
                    ],
                    optionalParameters: ['password_salt_position'],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];

    const enums = [
      {
        name: 'CreateUserPasswordHashType',
        values: [
          { name: 'BCRYPT', value: 'bcrypt' },
          { name: 'SSHA_256', value: 'ssha256' },
        ],
      },
      {
        name: 'CreateUserPasswordSaltPosition',
        values: [
          { name: 'PREFIX', value: 'prefix' },
          { name: 'SUFFIX', value: 'suffix' },
        ],
      },
    ];

    primeEnumAliases(enums);
    const ctxWithServices: EmitterContext = {
      ...ctx,
      spec: { ...emptySpec, services, models, enums },
    };

    const files = generateResources(services, ctxWithServices);

    const optContent = files.find((f) => f.path.includes('Options.cs'))!.content;
    const hashedClass = optContent.slice(optContent.indexOf('public class UserManagementPasswordHashed'));

    // The optional member is nullable, has no `= default!` initializer, and
    // trails the required members.
    const hashTypeIndex = hashedClass.indexOf(
      'public CreateUserPasswordHashType PasswordHashType { get; set; } = default!;',
    );
    const saltPositionIndex = hashedClass.indexOf(
      'public CreateUserPasswordSaltPosition? PasswordSaltPosition { get; set; }\n',
    );
    expect(hashTypeIndex).toBeGreaterThan(-1);
    expect(saltPositionIndex).toBeGreaterThan(hashTypeIndex);
    expect(hashedClass).not.toContain('PasswordSaltPosition { get; set; } = default!;');

    const svcContent = files.find((f) => f.path.endsWith('Service.cs'))!.content;

    // The optional member is only written when set; the required enum member,
    // a value type, is written unconditionally.
    expect(svcContent).toContain('if (hashed.PasswordSaltPosition != null)');
    expect(svcContent).toContain(
      'request.AddBodyParam("password_salt_position", JsonConvert.SerializeObject(hashed.PasswordSaltPosition).Trim(\'"\'));',
    );
    expect(svcContent).toContain(
      '            request.AddBodyParam("password_hash_type", JsonConvert.SerializeObject(hashed.PasswordHashType).Trim(\'"\'));',
    );
  });

  it('leaves variants without optionalParameters byte-identical', () => {
    const models: Model[] = [
      {
        name: 'User',
        fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
      {
        name: 'CreateUserRequest',
        fields: [
          { name: 'password', type: { kind: 'primitive', type: 'string' }, required: false },
          { name: 'password_hash', type: { kind: 'primitive', type: 'string' }, required: false },
        ],
      },
    ];

    const buildServices = (optionalParameters?: string[]): Service[] => [
      {
        name: 'UserManagement',
        operations: [
          {
            name: 'createUser',
            httpMethod: 'post',
            path: '/user_management/users',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            requestBody: { kind: 'model', name: 'CreateUserRequest' },
            response: { kind: 'model', name: 'User' },
            errors: [],
            injectIdempotencyKey: false,
            parameterGroups: [
              {
                name: 'password',
                optional: true,
                variants: [
                  {
                    name: 'plaintext',
                    parameters: [{ name: 'password', type: { kind: 'primitive', type: 'string' }, required: false }],
                  },
                  {
                    name: 'hashed',
                    parameters: [
                      { name: 'password_hash', type: { kind: 'primitive', type: 'string' }, required: false },
                    ],
                    ...(optionalParameters ? { optionalParameters } : {}),
                  },
                ],
              },
            ],
          },
        ],
      },
    ];

    primeEnumAliases([]);
    const render = (optionalParameters?: string[]): string => {
      const services = buildServices(optionalParameters);
      const files = generateResources(services, {
        ...ctx,
        spec: { ...emptySpec, services, models },
      });
      return files.map((f) => `${f.path}\n${f.content}`).join('\n');
    };

    expect(render([])).toBe(render(undefined));
  });

  it('renames group types that would collide with a generated model', () => {
    // Mount `AuditLogs` + group `retention` derives `AuditLogsRetention`, which
    // is also the class generated for the AuditLogsRetention model. Every
    // generated type shares the one WorkOS namespace, so the group types must
    // step aside or the SDK fails to compile with CS0101.
    const models: Model[] = [
      {
        name: 'AuditLogsRetention',
        fields: [{ name: 'retention_period_in_days', type: { kind: 'primitive', type: 'integer' }, required: true }],
      },
      {
        name: 'UpdateAuditLogsRetention',
        fields: [
          { name: 'retention_period', type: { kind: 'primitive', type: 'string' }, required: false },
          { name: 'retention_period_in_days', type: { kind: 'primitive', type: 'integer' }, required: false },
        ],
      },
    ];

    const services: Service[] = [
      {
        name: 'AuditLogs',
        operations: [
          {
            name: 'updateAuditLogsRetention',
            httpMethod: 'put',
            path: '/organizations/{organizationId}/audit_logs_retention',
            pathParams: [{ name: 'organizationId', type: { kind: 'primitive', type: 'string' }, required: true }],
            queryParams: [],
            headerParams: [],
            requestBody: { kind: 'model', name: 'UpdateAuditLogsRetention' },
            response: { kind: 'model', name: 'AuditLogsRetention' },
            errors: [],
            injectIdempotencyKey: false,
            parameterGroups: [
              {
                name: 'retention',
                optional: false,
                variants: [
                  {
                    name: 'period',
                    parameters: [
                      { name: 'retention_period', type: { kind: 'primitive', type: 'string' }, required: true },
                    ],
                  },
                  {
                    name: 'period_in_days',
                    parameters: [
                      {
                        name: 'retention_period_in_days',
                        type: { kind: 'primitive', type: 'integer' },
                        required: true,
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];

    primeEnumAliases([]);
    const files = generateResources(services, { ...ctx, spec: { ...emptySpec, services, models } });

    const optContent = files.find((f) => f.path.includes('Options.cs'))!.content;
    const svcContent = files.find((f) => f.path.endsWith('Service.cs'))!.content;

    // The base class, the variant subclasses, and the options property all move
    // to the disambiguated name together.
    expect(optContent).toContain('public abstract class AuditLogsRetentionGroup { }');
    expect(optContent).toContain('public class AuditLogsRetentionGroupPeriod : AuditLogsRetentionGroup');
    expect(optContent).toContain('public class AuditLogsRetentionGroupPeriodInDays : AuditLogsRetentionGroup');
    expect(optContent).toContain('public AuditLogsRetentionGroup Retention { get; set; } = default!;');

    // Nothing may redeclare the model's name, and the service's pattern matches
    // have to name the same variant classes the options file declares.
    expect(optContent).not.toContain('public abstract class AuditLogsRetention { }');
    expect(svcContent).toContain('is AuditLogsRetentionGroupPeriod ');
    expect(svcContent).toContain('is AuditLogsRetentionGroupPeriodInDays ');
  });

  it('keeps a disambiguated group name off another group in the same mount', () => {
    // `retention` collides with the AuditLogsRetention model and moves to
    // AuditLogsRetentionGroup — which is what `retention_group` on the sibling
    // operation derives naturally. Both groups must still get their own
    // declarations: deduping on the class name rather than the group's identity
    // would drop the second group's classes while its options property and `is`
    // patterns went on referencing them.
    const models: Model[] = [
      {
        name: 'AuditLogsRetention',
        fields: [{ name: 'retention_period_in_days', type: { kind: 'primitive', type: 'integer' }, required: true }],
      },
    ];

    const services: Service[] = [
      {
        name: 'AuditLogs',
        operations: [
          {
            name: 'setRetention',
            httpMethod: 'put',
            path: '/organizations/{organizationId}/audit_logs_retention',
            pathParams: [{ name: 'organizationId', type: { kind: 'primitive', type: 'string' }, required: true }],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model', name: 'AuditLogsRetention' },
            errors: [],
            injectIdempotencyKey: false,
            parameterGroups: [
              {
                name: 'retention',
                optional: false,
                variants: [
                  {
                    name: 'period',
                    parameters: [
                      { name: 'retention_period', type: { kind: 'primitive', type: 'string' }, required: true },
                    ],
                  },
                ],
              },
            ],
          },
          {
            name: 'setRetentionGroup',
            httpMethod: 'put',
            path: '/organizations/{organizationId}/audit_logs_retention_group',
            pathParams: [{ name: 'organizationId', type: { kind: 'primitive', type: 'string' }, required: true }],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model', name: 'AuditLogsRetention' },
            errors: [],
            injectIdempotencyKey: false,
            parameterGroups: [
              {
                name: 'retention_group',
                optional: false,
                variants: [
                  {
                    name: 'slug',
                    parameters: [
                      { name: 'retention_group_slug', type: { kind: 'primitive', type: 'string' }, required: true },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];

    primeEnumAliases([]);
    const files = generateResources(services, { ...ctx, spec: { ...emptySpec, services, models } });

    const optContent = files.find((f) => f.path.includes('Options.cs'))!.content;
    const svcContent = files.find((f) => f.path.endsWith('Service.cs'))!.content;

    // Two distinct base classes, each declared exactly once.
    const declarations = [...optContent.matchAll(/public abstract class (\w+) \{ \}/g)].map((m) => m[1]);
    expect(declarations).toHaveLength(new Set(declarations).size);
    expect(declarations).toHaveLength(2);

    // Every variant class the service pattern-matches on has to be declared.
    for (const variantClass of [...svcContent.matchAll(/ is (\w+) \w+\)/g)].map((m) => m[1])) {
      expect(optContent).toContain(`public class ${variantClass} : `);
    }

    // Each options property points at its own group's base class.
    const retentionBase = optContent.match(/public (\w+) Retention \{ get; set; \}/)![1];
    const groupBase = optContent.match(/public (\w+) RetentionGroup \{ get; set; \}/)![1];
    expect(retentionBase).not.toBe(groupBase);
    expect(optContent).toContain(`public abstract class ${retentionBase} { }`);
    expect(optContent).toContain(`public abstract class ${groupBase} { }`);
  });
});
