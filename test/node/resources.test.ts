import { describe, it, expect } from 'vitest';
import { generateResources, resolveResourceClassName, hasCompatibleConstructor } from '../../src/node/resources.js';
import type { EmitterContext, ApiSpec, Service } from '@workos/oagen';

const emptySpec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: '',
  services: [],
  models: [],
  enums: [],
};

const ctx: EmitterContext = {
  namespace: 'workos',
  namespacePascal: 'WorkOS',
  spec: emptySpec,
};

describe('generateResources', () => {
  it('returns empty for no services', () => {
    expect(generateResources([], ctx)).toEqual([]);
  });

  it('generates a resource class with GET method', () => {
    const services: Service[] = [
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

    const files = generateResources(services, ctx);
    expect(files.length).toBe(1);
    expect(files[0].path).toBe('src/organizations/organizations.ts');

    const content = files[0].content;
    expect(content).toContain('export class Organizations {');
    expect(content).toContain('constructor(private readonly workos: WorkOS) {}');
    expect(content).toContain('async getOrganization(id: string): Promise<Organization>');
    expect(content).toContain('deserializeOrganization(data)');
  });

  it('generates paginated list method', () => {
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
              {
                name: 'domains',
                type: { kind: 'array', items: { kind: 'primitive', type: 'string' } },
                required: false,
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
    ];

    const files = generateResources(services, ctx);
    const content = files[0].content;

    // Should have AutoPaginatable imports
    expect(content).toContain('import type { AutoPaginatable }');
    expect(content).toContain('import { createPaginatedList }');

    // Should generate options interface
    expect(content).toContain('export interface ListOrganizationsOptions extends PaginationOptions {');
    expect(content).toContain('domains?: string[];');

    // Should return AutoPaginatable
    expect(content).toContain('Promise<AutoPaginatable<Organization, ListOrganizationsOptions>>');
  });

  it('uses item type not list wrapper type for paginated methods', () => {
    // The response model is the list wrapper (ConnectionList), but the pagination
    // itemType is the actual item (Connection). The generated code should use the
    // item type for fetchAndDeserialize, not the list wrapper.
    const services: Service[] = [
      {
        name: 'SSO',
        operations: [
          {
            name: 'listConnections',
            httpMethod: 'get',
            path: '/connections',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model', name: 'ConnectionList' },
            errors: [],
            pagination: {
              strategy: 'cursor',
              param: 'after',
              dataPath: 'data',
              itemType: { kind: 'model', name: 'Connection' },
            },
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const testCtx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec: { ...emptySpec, services, models: [] },
    };

    const files = generateResources(services, testCtx);
    const content = files[0].content;

    // Should use item type (Connection) not list wrapper (ConnectionList)
    expect(content).toContain('createPaginatedList<ConnectionResponse, Connection,');
    expect(content).toContain('deserializeConnection, options,');
    expect(content).toContain('Promise<AutoPaginatable<Connection,');

    // Should NOT reference the list wrapper type
    expect(content).not.toContain('ConnectionList');
    expect(content).not.toContain('deserializeConnectionList');
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
            pathParams: [
              {
                name: 'id',
                type: { kind: 'primitive', type: 'string' },
                required: true,
              },
            ],
            queryParams: [],
            headerParams: [],
            response: { kind: 'primitive', type: 'unknown' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const files = generateResources(services, ctx);
    const content = files[0].content;
    expect(content).toContain('async deleteOrganization(id: string): Promise<void>');
    expect(content).toContain('await this.workos.delete(');
  });

  it('generates POST method with body and idempotency', () => {
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
            requestBody: { kind: 'model', name: 'CreateOrganizationInput' },
            response: { kind: 'model', name: 'Organization' },
            errors: [],
            injectIdempotencyKey: true,
          },
        ],
      },
    ];

    const files = generateResources(services, ctx);
    const content = files[0].content;
    expect(content).toContain(
      'async createOrganization(payload: CreateOrganizationInput, requestOptions: PostOptions = {}): Promise<Organization>',
    );
    expect(content).toContain('serializeCreateOrganizationInput(payload)');
    expect(content).toContain('requestOptions,');
  });

  it('uses overlay-resolved name for output path and class', () => {
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
          requestBody: { kind: 'model', name: 'EnrollFactorInput' },
          response: { kind: 'model', name: 'AuthenticationFactor' },
          errors: [],
          injectIdempotencyKey: true,
        },
      ],
    };

    const overlayCtx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec: { ...emptySpec, services: [mfaService], models: [] },
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

    const files = generateResources([mfaService], overlayCtx);
    expect(files.length).toBe(1);
    expect(files[0].path).toBe('src/mfa/mfa.ts');

    const content = files[0].content;
    expect(content).toContain('export class Mfa {');
  });

  it('renders multiline description and @deprecated in method docstring', () => {
    const services: Service[] = [
      {
        name: 'Radar',
        operations: [
          {
            name: 'updateAttempt',
            description: 'Update a Radar attempt\n\nYou may optionally inform Radar that an attempt was successful.',
            httpMethod: 'put',
            path: '/radar/attempts/{id}',
            pathParams: [
              {
                name: 'id',
                type: { kind: 'primitive', type: 'string' },
                required: true,
                description: 'The unique identifier of the attempt.',
              },
            ],
            queryParams: [],
            headerParams: [],
            requestBody: { kind: 'model', name: 'UpdateAttemptInput' },
            response: { kind: 'model', name: 'RadarAttempt' },
            errors: [],
            injectIdempotencyKey: false,
            deprecated: true,
          },
        ],
      },
    ];

    const files = generateResources(services, ctx);
    const content = files[0].content;

    expect(content).toContain('  /**');
    expect(content).toContain('   * Update a Radar attempt');
    expect(content).toContain('   *');
    expect(content).toContain('   * You may optionally inform Radar that an attempt was successful.');
    expect(content).toContain('   * @param id - The unique identifier of the attempt.');
    expect(content).toContain('   * @returns {RadarAttempt}');
    expect(content).toContain('   * @deprecated');
    expect(content).toContain('   */');
  });

  it('renders @returns for response model', () => {
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

    const files = generateResources(services, ctx);
    const content = files[0].content;
    expect(content).toContain('@returns {Organization}');
  });

  it('renders query param docs for non-paginated operations', () => {
    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [
          {
            name: 'getOrganization',
            httpMethod: 'get',
            path: '/organizations/{id}',
            pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
            queryParams: [
              {
                name: 'include_fields',
                type: { kind: 'primitive', type: 'string' },
                required: false,
                description: 'Comma-separated list of fields to include.',
              },
            ],
            headerParams: [],
            response: { kind: 'model', name: 'Organization' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const files = generateResources(services, ctx);
    const content = files[0].content;
    expect(content).toContain('@param options.includeFields - Comma-separated list of fields to include.');
  });

  it('renders header and cookie param docs', () => {
    const services: Service[] = [
      {
        name: 'Sessions',
        operations: [
          {
            name: 'getSession',
            httpMethod: 'get',
            path: '/sessions/{id}',
            pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
            queryParams: [],
            headerParams: [
              {
                name: 'X-Request-Id',
                type: { kind: 'primitive', type: 'string' },
                required: false,
                description: 'Unique request identifier.',
              },
            ],
            cookieParams: [
              {
                name: 'session_token',
                type: { kind: 'primitive', type: 'string' },
                required: true,
                description: 'The session cookie.',
              },
            ],
            response: { kind: 'model', name: 'Session' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const files = generateResources(services, ctx);
    const content = files[0].content;
    // Header and cookie params are intentionally NOT documented in JSDoc —
    // they are not exposed in the method signature (handled internally by the SDK).
    expect(content).not.toContain('@param xRequestId');
    expect(content).not.toContain('@param sessionToken');
  });

  it('renders single @returns without status-code duplicates', () => {
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
            requestBody: { kind: 'model', name: 'CreateOrganizationInput' },
            response: { kind: 'model', name: 'Organization' },
            successResponses: [
              { statusCode: 200, type: { kind: 'model', name: 'Organization' } },
              { statusCode: 201, type: { kind: 'model', name: 'Organization' } },
            ],
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const files = generateResources(services, ctx);
    const content = files[0].content;
    // Only emit a single @returns for the primary response model (no status-code variants)
    expect(content).toContain('@returns {Organization}');
    expect(content).not.toContain('@returns {Organization} 200');
    expect(content).not.toContain('@returns {Organization} 201');
  });

  it('generates DELETE-with-body method using deleteWithBody', () => {
    const services: Service[] = [
      {
        name: 'Radar',
        operations: [
          {
            name: 'deleteRadarListEntry',
            httpMethod: 'delete',
            path: '/radar/lists/{listId}/entries',
            pathParams: [
              {
                name: 'listId',
                type: { kind: 'primitive', type: 'string' },
                required: true,
              },
            ],
            queryParams: [],
            headerParams: [],
            requestBody: { kind: 'model', name: 'DeleteRadarListEntryInput' },
            response: { kind: 'primitive', type: 'unknown' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const files = generateResources(services, ctx);
    const content = files[0].content;
    expect(content).toContain(
      'async deleteRadarListEntry(listId: string, payload: DeleteRadarListEntryInput): Promise<void>',
    );
    expect(content).toContain('await this.workos.deleteWithBody(');
    expect(content).toContain('serializeDeleteRadarListEntryInput(payload)');
  });

  it('renders deprecated path params', () => {
    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [
          {
            name: 'getOrganization',
            httpMethod: 'get',
            path: '/organizations/{slug}',
            pathParams: [
              {
                name: 'slug',
                type: { kind: 'primitive', type: 'string' },
                required: true,
                description: 'The organization slug.',
                deprecated: true,
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

    const files = generateResources(services, ctx);
    const content = files[0].content;
    expect(content).toContain('@param slug - (deprecated) The organization slug.');
  });

  it('generates typed options interface for non-paginated GET with query params', () => {
    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [
          {
            name: 'getOrganization',
            httpMethod: 'get',
            path: '/organizations/{id}',
            pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
            queryParams: [
              {
                name: 'include_fields',
                type: { kind: 'primitive', type: 'string' },
                required: false,
                description: 'Comma-separated list of fields to include.',
              },
            ],
            headerParams: [],
            response: { kind: 'model', name: 'Organization' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const files = generateResources(services, ctx);
    const content = files[0].content;

    // Should generate a typed options interface
    expect(content).toContain('export interface GetOrganizationOptions {');
    expect(content).toContain('includeFields?: string;');

    // Should use the typed options in the method signature
    expect(content).toContain(
      'async getOrganization(id: string, options?: GetOrganizationOptions): Promise<Organization>',
    );

    // Should NOT use Record<string, unknown>
    expect(content).not.toContain('Record<string, unknown>');
  });

  it('generates typed options interface for void GET with query params', () => {
    const services: Service[] = [
      {
        name: 'Auth',
        operations: [
          {
            name: 'authorize',
            httpMethod: 'get',
            path: '/user_management/authorize',
            pathParams: [],
            queryParams: [
              {
                name: 'client_id',
                type: { kind: 'primitive', type: 'string' },
                required: true,
              },
              {
                name: 'redirect_uri',
                type: { kind: 'primitive', type: 'string' },
                required: true,
              },
              {
                name: 'response_type',
                type: { kind: 'primitive', type: 'string' },
                required: true,
              },
            ],
            headerParams: [],
            response: { kind: 'primitive', type: 'unknown' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const files = generateResources(services, ctx);
    const content = files[0].content;

    // Should generate a typed options interface
    expect(content).toContain('export interface AuthorizeOptions {');
    expect(content).toContain('clientId: string;');
    expect(content).toContain('redirectUri: string;');
    expect(content).toContain('responseType: string;');

    // Should use the typed options in the method signature
    expect(content).toContain('async authorize(options?: AuthorizeOptions): Promise<void>');

    // Should pass options as query params
    expect(content).toContain('query: options');
  });

  it('generates union type for non-discriminated request body (pass-through)', () => {
    const services: Service[] = [
      {
        name: 'Auth',
        operations: [
          {
            name: 'authenticate',
            httpMethod: 'post',
            path: '/user_management/authenticate',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            requestBody: {
              kind: 'union',
              variants: [
                { kind: 'model', name: 'AuthByPassword' },
                { kind: 'model', name: 'AuthByCode' },
                { kind: 'model', name: 'AuthByMagicAuth' },
              ],
            },
            response: { kind: 'model', name: 'AuthenticateResponse' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const files = generateResources(services, ctx);
    const content = files[0].content;

    // Should use the union type for the payload parameter
    expect(content).toContain('payload: AuthByPassword | AuthByCode | AuthByMagicAuth');

    // Should NOT use Record<string, unknown>
    expect(content).not.toContain('Record<string, unknown>');

    // Should pass payload directly (no serializer for unions)
    expect(content).toContain("'/user_management/authenticate',");
    expect(content).toContain('payload,');

    // Should import all union variant types
    expect(content).toContain('AuthByPassword');
    expect(content).toContain('AuthByCode');
    expect(content).toContain('AuthByMagicAuth');
  });

  it('generates discriminated union serializer dispatch for request body', () => {
    const services: Service[] = [
      {
        name: 'Auth',
        operations: [
          {
            name: 'authenticate',
            httpMethod: 'post',
            path: '/user_management/authenticate',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            requestBody: {
              kind: 'union',
              variants: [
                { kind: 'model', name: 'AuthByPassword' },
                { kind: 'model', name: 'AuthByCode' },
                { kind: 'model', name: 'AuthByMagicAuth' },
              ],
              discriminator: {
                property: 'grant_type',
                mapping: {
                  password: 'AuthByPassword',
                  authorization_code: 'AuthByCode',
                  'urn:workos:oauth:grant-type:magic-auth:code': 'AuthByMagicAuth',
                },
              },
            },
            response: { kind: 'model', name: 'AuthenticateResponse' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const files = generateResources(services, ctx);
    const content = files[0].content;

    // Should use the union type for the payload parameter
    expect(content).toContain('payload: AuthByPassword | AuthByCode | AuthByMagicAuth');

    // Should dispatch to the correct serializer based on the discriminator
    expect(content).toContain('switch ((payload as any).grantType)');
    expect(content).toContain("case 'password': return serializeAuthByPassword(payload as any)");
    expect(content).toContain("case 'authorization_code': return serializeAuthByCode(payload as any)");
    expect(content).toContain(
      "case 'urn:workos:oauth:grant-type:magic-auth:code': return serializeAuthByMagicAuth(payload as any)",
    );

    // Should import serializers for all union variants
    expect(content).toContain('serializeAuthByPassword');
    expect(content).toContain('serializeAuthByCode');
    expect(content).toContain('serializeAuthByMagicAuth');

    // Should NOT pass payload directly without serialization
    expect(content).not.toMatch(/,\n\s+payload,\n/);
  });

  it('generates discriminated union serializer dispatch for void method', () => {
    const services: Service[] = [
      {
        name: 'Auth',
        operations: [
          {
            name: 'sendToken',
            httpMethod: 'post',
            path: '/auth/token',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            requestBody: {
              kind: 'union',
              variants: [
                { kind: 'model', name: 'TokenByCode' },
                { kind: 'model', name: 'TokenByRefresh' },
              ],
              discriminator: {
                property: 'grant_type',
                mapping: {
                  authorization_code: 'TokenByCode',
                  refresh_token: 'TokenByRefresh',
                },
              },
            },
            response: { kind: 'primitive', type: 'unknown' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const files = generateResources(services, ctx);
    const content = files[0].content;

    // Should dispatch to the correct serializer
    expect(content).toContain('switch ((payload as any).grantType)');
    expect(content).toContain("case 'authorization_code': return serializeTokenByCode(payload as any)");
    expect(content).toContain("case 'refresh_token': return serializeTokenByRefresh(payload as any)");
  });

  it('uses createPaginatedList helper in paginated methods', () => {
    const services: Service[] = [
      {
        name: 'Connections',
        operations: [
          {
            name: 'listConnections',
            httpMethod: 'get',
            path: '/connections',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model', name: 'Connection' },
            errors: [],
            pagination: {
              strategy: 'cursor',
              param: 'after',
              dataPath: 'data',
              itemType: { kind: 'model', name: 'Connection' },
            },
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const files = generateResources(services, ctx);
    const content = files[0].content;

    // Should use createPaginatedList instead of inline AutoPaginatable construction
    expect(content).toContain('createPaginatedList<ConnectionResponse, Connection, PaginationOptions>(');
    expect(content).toContain('this.workos,');
    expect(content).toContain('deserializeConnection, options,');
    // Should NOT contain the old inline pattern
    expect(content).not.toContain('new AutoPaginatable(');
    expect(content).not.toContain('fetchAndDeserialize');
  });

  it('prefixes ListOptions with service name when method is "list"', () => {
    const services: Service[] = [
      {
        name: 'Connections',
        operations: [
          {
            name: 'list',
            httpMethod: 'get',
            path: '/connections',
            pathParams: [],
            queryParams: [
              {
                name: 'connection_type',
                type: { kind: 'primitive', type: 'string' },
                required: false,
              },
            ],
            headerParams: [],
            response: { kind: 'model', name: 'Connection' },
            errors: [],
            pagination: {
              strategy: 'cursor',
              param: 'after',
              dataPath: 'data',
              itemType: { kind: 'model', name: 'Connection' },
            },
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    // Use overlay to resolve method name to "list"
    const overlayCtx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec: { ...emptySpec, services, models: [] },
      overlayLookup: {
        methodByOperation: new Map([
          ['GET /connections', { className: 'Connections', methodName: 'list', params: [], returnType: 'void' }],
        ]),
        httpKeyByMethod: new Map(),
        interfaceByName: new Map(),
        typeAliasByName: new Map(),
        requiredExports: new Map(),
        modelNameByIR: new Map(),
        fileBySymbol: new Map(),
      },
    };

    const files = generateResources(services, overlayCtx);
    const content = files[0].content;

    // Should use service-prefixed options name instead of generic "ListOptions"
    expect(content).toContain('export interface ConnectionsListOptions extends PaginationOptions {');
    expect(content).toContain('Promise<AutoPaginatable<Connection, ConnectionsListOptions>>');
    // Should NOT use the generic "ListOptions"
    expect(content).not.toContain('export interface ListOptions ');
  });

  it('does not prefix ListOptions when method is not "list"', () => {
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
              {
                name: 'domains',
                type: { kind: 'array', items: { kind: 'primitive', type: 'string' } },
                required: false,
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
    ];

    const files = generateResources(services, ctx);
    const content = files[0].content;

    // Method is "listOrganizations", not "list", so options name should be normal
    expect(content).toContain('export interface ListOrganizationsOptions extends PaginationOptions {');
  });
});

describe('resolveResourceClassName', () => {
  const webhooksService: Service = {
    name: 'WebhookEvents',
    operations: [
      {
        name: 'listWebhookEvents',
        httpMethod: 'get',
        path: '/webhook_events',
        pathParams: [],
        queryParams: [],
        headerParams: [],
        response: { kind: 'model', name: 'WebhookEvent' },
        errors: [],
        injectIdempotencyKey: false,
      },
    ],
  };

  it('generates separate class when baseline has incompatible constructor', () => {
    const overlayCtx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec: { ...emptySpec, services: [webhooksService] },
      overlayLookup: {
        methodByOperation: new Map([
          [
            'GET /webhook_events',
            { className: 'Webhooks', methodName: 'listWebhookEvents', params: [], returnType: 'void' },
          ],
        ]),
        httpKeyByMethod: new Map(),
        interfaceByName: new Map(),
        typeAliasByName: new Map(),
        requiredExports: new Map(),
        modelNameByIR: new Map(),
        fileBySymbol: new Map(),
      },
      apiSurface: {
        language: 'node',
        extractedFrom: 'test',
        extractedAt: '2024-01-01',
        classes: {
          Webhooks: {
            name: 'Webhooks',
            methods: {},
            properties: {},
            constructorParams: [{ name: 'cryptoProvider', type: 'CryptoProvider', optional: false }],
          },
        },
        interfaces: {},
        typeAliases: {},
        enums: {},
        exports: {},
      },
    };

    const result = resolveResourceClassName(webhooksService, overlayCtx);
    // Falls back to IR name since overlay name has incompatible constructor
    expect(result).toBe('WebhookEvents');
  });

  it('uses overlay name when baseline has compatible constructor', () => {
    const overlayCtx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec: { ...emptySpec, services: [webhooksService] },
      overlayLookup: {
        methodByOperation: new Map([
          [
            'GET /webhook_events',
            { className: 'Webhooks', methodName: 'listWebhookEvents', params: [], returnType: 'void' },
          ],
        ]),
        httpKeyByMethod: new Map(),
        interfaceByName: new Map(),
        typeAliasByName: new Map(),
        requiredExports: new Map(),
        modelNameByIR: new Map(),
        fileBySymbol: new Map(),
      },
      apiSurface: {
        language: 'node',
        extractedFrom: 'test',
        extractedAt: '2024-01-01',
        classes: {
          Webhooks: {
            name: 'Webhooks',
            methods: {},
            properties: {},
            constructorParams: [{ name: 'workos', type: 'WorkOS', optional: false }],
          },
        },
        interfaces: {},
        typeAliases: {},
        enums: {},
        exports: {},
      },
    };

    const result = resolveResourceClassName(webhooksService, overlayCtx);
    expect(result).toBe('Webhooks');
  });

  it('appends Endpoints suffix when IR name collides with overlay name', () => {
    const collisionService: Service = {
      name: 'Webhooks',
      operations: [
        {
          name: 'listWebhooks',
          httpMethod: 'get',
          path: '/webhooks',
          pathParams: [],
          queryParams: [],
          headerParams: [],
          response: { kind: 'model', name: 'Webhook' },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    };

    const overlayCtx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec: { ...emptySpec, services: [collisionService] },
      overlayLookup: {
        methodByOperation: new Map([
          ['GET /webhooks', { className: 'Webhooks', methodName: 'listWebhooks', params: [], returnType: 'void' }],
        ]),
        httpKeyByMethod: new Map(),
        interfaceByName: new Map(),
        typeAliasByName: new Map(),
        requiredExports: new Map(),
        modelNameByIR: new Map(),
        fileBySymbol: new Map(),
      },
      apiSurface: {
        language: 'node',
        extractedFrom: 'test',
        extractedAt: '2024-01-01',
        classes: {
          Webhooks: {
            name: 'Webhooks',
            methods: {},
            properties: {},
            constructorParams: [{ name: 'cryptoProvider', type: 'CryptoProvider', optional: false }],
          },
        },
        interfaces: {},
        typeAliases: {},
        enums: {},
        exports: {},
      },
    };

    const result = resolveResourceClassName(collisionService, overlayCtx);
    // IR name "Webhooks" collides with overlay name "Webhooks", so append Endpoints
    expect(result).toBe('WebhooksEndpoints');
  });
});

describe('hasCompatibleConstructor', () => {
  it('returns true when no baseline exists', () => {
    expect(hasCompatibleConstructor('NewService', ctx)).toBe(true);
  });

  it('returns true when baseline has workos: WorkOS param', () => {
    const ctxWithSurface: EmitterContext = {
      ...ctx,
      apiSurface: {
        language: 'node',
        extractedFrom: 'test',
        extractedAt: '2024-01-01',
        classes: {
          Organizations: {
            name: 'Organizations',
            methods: {},
            properties: {},
            constructorParams: [{ name: 'workos', type: 'WorkOS', optional: false }],
          },
        },
        interfaces: {},
        typeAliases: {},
        enums: {},
        exports: {},
      },
    };

    expect(hasCompatibleConstructor('Organizations', ctxWithSurface)).toBe(true);
  });

  it('returns false when baseline has incompatible constructor', () => {
    const ctxWithSurface: EmitterContext = {
      ...ctx,
      apiSurface: {
        language: 'node',
        extractedFrom: 'test',
        extractedAt: '2024-01-01',
        classes: {
          Webhooks: {
            name: 'Webhooks',
            methods: {},
            properties: {},
            constructorParams: [{ name: 'cryptoProvider', type: 'CryptoProvider', optional: false }],
          },
        },
        interfaces: {},
        typeAliases: {},
        enums: {},
        exports: {},
      },
    };

    expect(hasCompatibleConstructor('Webhooks', ctxWithSurface)).toBe(false);
  });

  it('returns true when baseline has no constructor params', () => {
    const ctxWithSurface: EmitterContext = {
      ...ctx,
      apiSurface: {
        language: 'node',
        extractedFrom: 'test',
        extractedAt: '2024-01-01',
        classes: {
          EmptyService: {
            name: 'EmptyService',
            methods: {},
            properties: {},
            constructorParams: [],
          },
        },
        interfaces: {},
        typeAliases: {},
        enums: {},
        exports: {},
      },
    };

    expect(hasCompatibleConstructor('EmptyService', ctxWithSurface)).toBe(true);
  });
});
