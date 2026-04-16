import { describe, it, expect } from 'vitest';
import { generateResources, resolveResourceClassName, hasCompatibleConstructor } from '../../src/node/resources.js';
import type { EmitterContext, ApiSpec, Service } from '@workos/oagen';
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
                type: {
                  kind: 'array',
                  items: { kind: 'primitive', type: 'string' },
                },
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

    // Should have AutoPaginatable type import and createPaginatedList import
    expect(content).toContain("import type { AutoPaginatable } from '../common/utils/pagination'");
    expect(content).toContain("import { createPaginatedList } from '../common/utils/fetch-and-deserialize'");
    // Options interface lives in its own file under interfaces/ so the
    // per-service barrel picks it up.
    expect(content).toContain(
      "import type { ListOrganizationsOptions } from './interfaces/list-organizations-options.interface';",
    );

    // The options interface file is emitted separately.
    const optionsFile = files.find(
      (f) => f.path === 'src/organizations/interfaces/list-organizations-options.interface.ts',
    );
    expect(optionsFile).toBeDefined();
    expect(optionsFile!.content).toContain('export interface ListOrganizationsOptions extends PaginationOptions {');
    expect(optionsFile!.content).toContain('domains?: string[];');

    // Should return AutoPaginatable
    expect(content).toContain('Promise<AutoPaginatable<Organization, ListOrganizationsOptions>>');

    // `domains` has the same camelCase and snake_case spelling, so no wire
    // serializer should be emitted and createPaginatedList should be called
    // with just options (no 5th arg).
    expect(content).not.toContain('serializeListOrganizationsOptions');
    expect(content).toMatch(/createPaginatedList<[^>]+>\([^)]+options\);/);
  });

  it('emits wire-options serializer for paginated list with camelCase filter fields', () => {
    // Regression test for PR #1535 reviewer comment r3075477146: list
    // methods whose extended filter fields have divergent camelCase/snake_case
    // spellings (e.g. `organizationId` ↔ `organization_id`) must translate
    // keys before hitting the wire, otherwise the API silently ignores them.
    const services: Service[] = [
      {
        name: 'Applications',
        operations: [
          {
            name: 'listApplications',
            httpMethod: 'get',
            path: '/connect/applications',
            pathParams: [],
            queryParams: [
              {
                name: 'organization_id',
                type: { kind: 'primitive', type: 'string' },
                required: false,
                description: 'Filter by organization ID.',
              },
            ],
            headerParams: [],
            response: { kind: 'model', name: 'ConnectApplication' },
            errors: [],
            pagination: {
              strategy: 'cursor',
              param: 'after',
              dataPath: 'data',
              itemType: { kind: 'model', name: 'ConnectApplication' },
            },
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const files = generateResources(services, ctx);
    const content = files[0].content;

    // Options interface uses camelCase (user-facing) and lives in its own file.
    const optionsFile = files.find(
      (f) => f.path === 'src/applications/interfaces/list-applications-options.interface.ts',
    );
    expect(optionsFile).toBeDefined();
    expect(optionsFile!.content).toContain('export interface ListApplicationsOptions extends PaginationOptions {');
    expect(optionsFile!.content).toContain('organizationId?: string;');

    // Resource class imports the options type from the interface file.
    expect(content).toContain(
      "import type { ListApplicationsOptions } from './interfaces/list-applications-options.interface';",
    );

    // Wire-options serializer emits snake_case key for the extension field
    // and leaves standard pagination fields unchanged.
    expect(content).toContain(
      'const serializeListApplicationsOptions = (options: ListApplicationsOptions): PaginationOptions => {',
    );
    expect(content).toContain('wire.organization_id = options.organizationId');
    expect(content).not.toContain('wire.organizationId');

    // createPaginatedList is invoked with the serializer as the 5th arg.
    expect(content).toMatch(/createPaginatedList<[^>]+>\([^)]+options,\s*serializeListApplicationsOptions\);/);
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
    expect(content).toContain('deserializeConnection');
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

  it('generates unpaginated GET returning an array of models', () => {
    // Regression test for PR #1535 reviewer comment (r3074705330): endpoints
    // whose OpenAPI response is `type: array` must return `Model[]` and map
    // the deserializer over each element, not treat the array as a single
    // object (which silently produces garbage at runtime).
    const services: Service[] = [
      {
        name: 'Secrets',
        operations: [
          {
            name: 'listSecrets',
            httpMethod: 'get',
            path: '/applications/{id}/secrets',
            pathParams: [
              {
                name: 'id',
                type: { kind: 'primitive', type: 'string' },
                required: true,
              },
            ],
            queryParams: [],
            headerParams: [],
            response: { kind: 'array', items: { kind: 'model', name: 'Secret' } },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const files = generateResources(services, ctx);
    const content = files[0].content;

    expect(content).toContain('async listSecrets(id: string): Promise<Secret[]>');
    expect(content).toContain('this.workos.get<SecretResponse[]>');
    expect(content).toContain('return data.map(deserializeSecret);');
    // Should NOT produce the single-object form — that was the bug.
    expect(content).not.toMatch(/Promise<Secret>\s*\{/);
    expect(content).not.toContain('return deserializeSecret(data);');
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
            {
              className: 'Mfa',
              methodName: 'enrollFactor',
              params: [],
              returnType: 'void',
            },
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
    expect(content).toContain('   * @returns {Promise<RadarAttempt>}');
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
    const content = files[0].content;
    expect(content).toContain('@returns {Promise<Organization>}');
  });

  it('renders @returns from overlay return type when available', () => {
    const services: Service[] = [
      {
        name: 'Authorization',
        operations: [
          {
            name: 'createEnvironmentRole',
            httpMethod: 'post',
            path: '/authorization/roles',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            requestBody: { kind: 'model', name: 'CreateRoleInput' },
            response: { kind: 'model', name: 'Role' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const overlayCtx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec: { ...emptySpec, services, models: [] },
      overlayLookup: {
        methodByOperation: new Map([
          [
            'POST /authorization/roles',
            {
              className: 'Authorization',
              methodName: 'createEnvironmentRole',
              params: [{ name: 'payload', type: 'CreateRoleInput', optional: false }],
              returnType: 'Promise<EnvironmentRole>',
            },
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

    const files = generateResources(services, overlayCtx);
    const content = files[0].content;
    // JSDoc should use the overlay return type, not the spec schema name
    expect(content).toContain('@returns {Promise<EnvironmentRole>}');
    expect(content).not.toContain('@returns {Role}');
    expect(content).not.toContain('@returns {Promise<Role>}');
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
            pathParams: [
              {
                name: 'id',
                type: { kind: 'primitive', type: 'string' },
                required: true,
              },
            ],
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
            pathParams: [
              {
                name: 'id',
                type: { kind: 'primitive', type: 'string' },
                required: true,
              },
            ],
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
              {
                statusCode: 200,
                type: { kind: 'model', name: 'Organization' },
              },
              {
                statusCode: 201,
                type: { kind: 'model', name: 'Organization' },
              },
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
    expect(content).toContain('@returns {Promise<Organization>}');
    expect(content).not.toContain('@returns {Promise<Organization>} 200');
    expect(content).not.toContain('@returns {Promise<Organization>} 201');
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
            pathParams: [
              {
                name: 'id',
                type: { kind: 'primitive', type: 'string' },
                required: true,
              },
            ],
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

  it('falls back to pass-through for non-discriminated union when models not in spec', () => {
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

    // Models not in spec → falls back to pass-through
    expect(content).toContain("'/user_management/authenticate',");
    expect(content).toContain('payload,');

    // Should import all union variant types
    expect(content).toContain('AuthByPassword');
    expect(content).toContain('AuthByCode');
    expect(content).toContain('AuthByMagicAuth');
  });

  it('generates field-guard serializer dispatch for non-discriminated union with models', () => {
    const services: Service[] = [
      {
        name: 'Applications',
        operations: [
          {
            name: 'createApplication',
            httpMethod: 'post',
            path: '/connect/applications',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            requestBody: {
              kind: 'union',
              variants: [
                { kind: 'model', name: 'CreateOAuthApplication' },
                { kind: 'model', name: 'CreateM2MApplication' },
              ],
            },
            response: { kind: 'model', name: 'ConnectApplication' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const testCtx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec: {
        ...emptySpec,
        services,
        models: [
          {
            name: 'CreateOAuthApplication',
            fields: [
              {
                name: 'name',
                type: { kind: 'primitive', type: 'string' },
                required: true,
              },
              {
                name: 'redirect_uris',
                type: {
                  kind: 'array',
                  items: { kind: 'primitive', type: 'string' },
                },
                required: true,
              },
              {
                name: 'uses_pkce',
                type: { kind: 'primitive', type: 'boolean' },
                required: false,
              },
            ],
          },
          {
            name: 'CreateM2MApplication',
            fields: [
              {
                name: 'name',
                type: { kind: 'primitive', type: 'string' },
                required: true,
              },
              {
                name: 'scopes',
                type: {
                  kind: 'array',
                  items: { kind: 'primitive', type: 'string' },
                },
                required: true,
              },
            ],
          },
          {
            name: 'ConnectApplication',
            fields: [
              {
                name: 'id',
                type: { kind: 'primitive', type: 'string' },
                required: true,
              },
            ],
          },
        ],
      },
    };

    const files = generateResources(services, testCtx);
    const content = files[0].content;

    // Should use the union type for the payload parameter
    expect(content).toContain('payload: CreateOAuthApplication | CreateM2MApplication');

    // Should dispatch via unique required field guards
    expect(content).toContain("'redirectUris' in payload");
    expect(content).toContain('serializeCreateOAuthApplication(payload as any)');
    expect(content).toContain('serializeCreateM2MApplication(payload as any)');

    // Should import serializers for all union variants
    expect(content).toContain('serializeCreateOAuthApplication');
    expect(content).toContain('serializeCreateM2MApplication');
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

    // Should dispatch to the correct serializer based on the discriminator,
    // using the typed discriminator so TS narrows payload per case.
    expect(content).toContain('switch (payload.grantType)');
    expect(content).toContain("case 'password': return serializeAuthByPassword(payload)");
    expect(content).toContain("case 'authorization_code': return serializeAuthByCode(payload)");
    expect(content).toContain(
      "case 'urn:workos:oauth:grant-type:magic-auth:code': return serializeAuthByMagicAuth(payload)",
    );

    // Should not use `as any` casts — TS discriminated-union narrowing makes
    // them unnecessary and they suppress real type mismatches.
    expect(content).not.toContain('switch ((payload as any)');
    expect(content).not.toMatch(/return serialize\w+\(payload as any\)/);

    // Should import serializers for all union variants
    expect(content).toContain('serializeAuthByPassword');
    expect(content).toContain('serializeAuthByCode');
    expect(content).toContain('serializeAuthByMagicAuth');

    // Should NOT pass payload directly without serialization
    expect(content).not.toMatch(/,\n\s+payload,\n/);

    // Default branch must throw — silently forwarding unserialized camelCase
    // to the API produces malformed requests when the discriminator is unknown.
    expect(content).toContain('default:');
    expect(content).toContain('const _unknown: never = payload');
    expect(content).toContain('throw new Error');
    expect(content).not.toMatch(/default:\s*return payload/);
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

    // Should dispatch to the correct serializer using the typed discriminator.
    expect(content).toContain('switch (payload.grantType)');
    expect(content).toContain("case 'authorization_code': return serializeTokenByCode(payload)");
    expect(content).toContain("case 'refresh_token': return serializeTokenByRefresh(payload)");
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

    // Should use createPaginatedList helper for concise paginated methods
    expect(content).toContain('createPaginatedList<ConnectionResponse, Connection,');
    expect(content).toContain('this.workos,');
    expect(content).toContain('deserializeConnection');
  });

  it('prefixes ListOptions with service name when method is "list"', () => {
    const services: Service[] = [
      {
        name: 'Payments',
        operations: [
          {
            name: 'list',
            httpMethod: 'get',
            path: '/payments',
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
          [
            'GET /payments',
            {
              className: 'Payments',
              methodName: 'list',
              params: [],
              returnType: 'void',
            },
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

    const files = generateResources(services, overlayCtx);
    const content = files[0].content;

    // Should use service-prefixed options name instead of generic "ListOptions"
    const optionsFile = files.find((f) => f.path.endsWith('payments-list-options.interface.ts'));
    expect(optionsFile).toBeDefined();
    expect(optionsFile!.content).toContain('export interface PaymentsListOptions extends PaginationOptions {');
    expect(content).toContain('Promise<AutoPaginatable<Connection, PaymentsListOptions>>');
    // Should NOT use the generic "ListOptions"
    expect(content).not.toContain('export interface ListOptions ');
    expect(files.every((f) => !f.path.endsWith('/list-options.interface.ts'))).toBe(true);
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
                type: {
                  kind: 'array',
                  items: { kind: 'primitive', type: 'string' },
                },
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

    // Method is "listOrganizations", not "list", so options name should be normal
    const optionsFile = files.find((f) => f.path.endsWith('list-organizations-options.interface.ts'));
    expect(optionsFile).toBeDefined();
    expect(optionsFile!.content).toContain('export interface ListOrganizationsOptions extends PaginationOptions {');
  });

  it('removes skipIfExists when fully-covered service has methods absent from baseline', () => {
    const services: Service[] = [
      {
        name: 'SSOService',
        operations: [
          {
            name: 'getAuthorizationUrl',
            httpMethod: 'get',
            path: '/sso/authorize',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model', name: 'AuthorizationUrl' },
            errors: [],
            injectIdempotencyKey: false,
          },
          {
            name: 'logout',
            httpMethod: 'get',
            path: '/sso/logout',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model', name: 'LogoutResult' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    // Overlay maps both operations to SSO class
    // Baseline SSO class exists but only has getAuthorizationUrl (logout is missing)
    const overlayCtx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec: { ...emptySpec, services, models: [] },
      overlayLookup: {
        methodByOperation: new Map([
          [
            'GET /sso/authorize',
            {
              className: 'SSO',
              methodName: 'getAuthorizationUrl',
              params: [],
              returnType: 'void',
            },
          ],
          [
            'GET /sso/logout',
            {
              className: 'SSO',
              methodName: 'logout',
              params: [],
              returnType: 'void',
            },
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
          SSO: {
            name: 'SSO',
            methods: {
              getAuthorizationUrl: [
                {
                  name: 'getAuthorizationUrl',
                  params: [],
                  returnType: 'void',
                  async: true,
                },
              ],
              // logout method is intentionally ABSENT
            },
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

    const files = generateResources(services, overlayCtx);
    expect(files.length).toBe(1);

    // skipIfExists should be removed because 'logout' is absent from baseline
    expect(files[0].skipIfExists).toBeUndefined();
  });

  it('keeps skipIfExists when fully-covered service has all methods in baseline', () => {
    const services: Service[] = [
      {
        name: 'SSOService',
        operations: [
          {
            name: 'getAuthorizationUrl',
            httpMethod: 'get',
            path: '/sso/authorize',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model', name: 'AuthorizationUrl' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const overlayCtx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec: { ...emptySpec, services, models: [] },
      overlayLookup: {
        methodByOperation: new Map([
          [
            'GET /sso/authorize',
            {
              className: 'SSO',
              methodName: 'getAuthorizationUrl',
              params: [],
              returnType: 'void',
            },
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
          SSO: {
            name: 'SSO',
            methods: {
              getAuthorizationUrl: [
                {
                  name: 'getAuthorizationUrl',
                  params: [],
                  returnType: 'void',
                  async: true,
                },
              ],
            },
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

    const files = generateResources(services, overlayCtx);
    expect(files.length).toBe(1);

    // skipIfExists should stay true because all methods exist in baseline
    expect(files[0].skipIfExists).toBe(true);
  });

  it('removes skipIfExists for purely oagen-managed services (no baseline)', () => {
    const services: Service[] = [
      {
        name: 'Applications',
        operations: [
          {
            name: 'create',
            httpMethod: 'post',
            path: '/connect/applications',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model', name: 'ConnectApplication' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const overlayCtx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec: { ...emptySpec, services, models: [] },
      overlayLookup: {
        methodByOperation: new Map([
          [
            'POST /connect/applications',
            {
              className: 'Applications',
              methodName: 'create',
              params: [],
              returnType: 'ConnectApplication',
            },
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
        // No baseline class for Applications — purely oagen-managed.
        classes: {},
        interfaces: {},
        typeAliases: {},
        enums: {},
        exports: {},
      },
    };

    const files = generateResources(services, overlayCtx);
    expect(files.length).toBe(1);

    // skipIfExists must be removed so emitter improvements always overwrite.
    expect(files[0].skipIfExists).toBeUndefined();
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
            {
              className: 'Webhooks',
              methodName: 'listWebhookEvents',
              params: [],
              returnType: 'void',
            },
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
            constructorParams: [
              {
                name: 'cryptoProvider',
                type: 'CryptoProvider',
                optional: false,
              },
            ],
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
            {
              className: 'Webhooks',
              methodName: 'listWebhookEvents',
              params: [],
              returnType: 'void',
            },
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
          [
            'GET /webhooks',
            {
              className: 'Webhooks',
              methodName: 'listWebhooks',
              params: [],
              returnType: 'void',
            },
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
            constructorParams: [
              {
                name: 'cryptoProvider',
                type: 'CryptoProvider',
                optional: false,
              },
            ],
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
            constructorParams: [
              {
                name: 'cryptoProvider',
                type: 'CryptoProvider',
                optional: false,
              },
            ],
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

describe('partial service coverage', () => {
  it('generates methods for uncovered operations in partially covered services', () => {
    const services: Service[] = [
      {
        name: 'AuditLogs',
        operations: [
          {
            name: 'createEvent',
            httpMethod: 'post',
            path: '/audit_logs/events',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model', name: 'AuditLogEvent' },
            errors: [],
            injectIdempotencyKey: false,
          },
          {
            name: 'getRetention',
            httpMethod: 'get',
            path: '/audit_logs/retention',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model', name: 'AuditLogRetention' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    // createEvent is covered by existing AuditLogs class, getRetention is NOT
    const ctxPartial: EmitterContext = {
      ...ctx,
      spec: { ...emptySpec, services, models: [] },
      overlayLookup: {
        methodByOperation: new Map([
          [
            'POST /audit_logs/events',
            {
              className: 'AuditLogs',
              methodName: 'createEvent',
              params: [],
              returnType: 'AuditLogEvent',
            },
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
          AuditLogs: {
            name: 'AuditLogs',
            methods: {
              createEvent: [
                {
                  name: 'createEvent',
                  params: [],
                  returnType: 'AuditLogEvent',
                  async: true,
                },
              ],
            },
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

    const files = generateResources(services, ctxPartial);
    expect(files.length).toBe(1);
    const content = files[0].content;

    // Should generate method for uncovered operation
    expect(content).toContain('async getRetention');
    // Should also generate covered operation so the merger can apply JSDoc
    expect(content).toContain('async createEvent');
  });

  it('generates resource class for fully covered services to provide JSDoc', () => {
    const services: Service[] = [
      {
        name: 'Permissions',
        operations: [
          {
            name: 'listPermissions',
            description: 'List all permissions.',
            httpMethod: 'get',
            path: '/authorization/permissions',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model', name: 'PermissionList' },
            errors: [{ statusCode: 404 }],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const ctxCovered: EmitterContext = {
      ...ctx,
      spec: { ...emptySpec, services, models: [] },
      overlayLookup: {
        methodByOperation: new Map([
          [
            'GET /authorization/permissions',
            {
              className: 'Permissions',
              methodName: 'listPermissions',
              params: [],
              returnType: 'void',
            },
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
          Permissions: {
            name: 'Permissions',
            methods: {
              listPermissions: [
                {
                  name: 'listPermissions',
                  params: [],
                  returnType: 'void',
                  async: true,
                },
              ],
            },
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

    const files = generateResources(services, ctxCovered);
    expect(files.length).toBe(1);
    const content = files[0].content;
    // All methods should have generated JSDoc — the merger matches by name
    // and handles @deprecated preservation, so the emitter always provides
    // docstrings for the merger to work with.
    expect(content).toContain('List all permissions.');
    // skipIfExists should remain true for covered services
    expect(files[0].skipIfExists).toBe(true);
  });

  it('uses resolved operation method names when provided', () => {
    const op = {
      name: 'listRolesOrganizations',
      httpMethod: 'get' as const,
      path: '/authorization/organizations/{organizationId}/roles',
      pathParams: [
        {
          name: 'organizationId',
          type: { kind: 'primitive' as const, type: 'string' as const },
          required: true,
        },
      ],
      queryParams: [],
      headerParams: [],
      response: { kind: 'model' as const, name: 'RoleList' },
      errors: [],
      pagination: {
        strategy: 'cursor' as const,
        param: 'after',
        itemType: { kind: 'model' as const, name: 'RoleList' },
      },
      injectIdempotencyKey: false,
    };
    const services: Service[] = [
      {
        name: 'Authorization',
        operations: [op],
      },
    ];

    const ctxResolved: EmitterContext = {
      ...ctx,
      spec: {
        ...emptySpec,
        services,
        models: [{ name: 'RoleList', fields: [] }],
      },
      resolvedOperations: [
        {
          operation: op,
          service: services[0],
          methodName: 'list_organization_roles',
          mountOn: 'Authorization',
        } as any,
      ],
    };

    const files = generateResources(services, ctxResolved);
    expect(files.length).toBe(1);
    const content = files[0].content;
    // Should use the resolved operation name (converted to camelCase)
    expect(content).toContain('async listOrganizationRoles');
    expect(content).not.toContain('async listRolesOrganizations');
  });

  it('deduplicates method names for operations on different paths', () => {
    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [
          {
            name: 'create',
            httpMethod: 'post',
            path: '/organization_domains',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            requestBody: { kind: 'model', name: 'CreateOrgDomain' },
            response: { kind: 'model', name: 'OrgDomain' },
            errors: [],
            injectIdempotencyKey: false,
          },
          {
            name: 'create',
            httpMethod: 'post',
            path: '/organizations',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            requestBody: { kind: 'model', name: 'CreateOrg' },
            response: { kind: 'model', name: 'Organization' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const ctxDedup: EmitterContext = {
      ...ctx,
      spec: {
        ...emptySpec,
        services,
        models: [
          { name: 'CreateOrgDomain', fields: [] },
          { name: 'OrgDomain', fields: [] },
          { name: 'CreateOrg', fields: [] },
          { name: 'Organization', fields: [] },
        ],
      },
    };

    const files = generateResources(services, ctxDedup);
    expect(files.length).toBe(1);
    const content = files[0].content;
    // The best-scoring plan keeps the name; the other gets disambiguated.
    // "create" matches "organizations" path better (the word "create" doesn't
    // appear in either path, but scoring is equal — first wins).
    // The other gets a path suffix.
    const createMatches = content.match(/async create\b/g);
    // At most one un-suffixed "create"
    expect(createMatches?.length ?? 0).toBeLessThanOrEqual(1);
    // The two methods should have different names
    const methodNames = [...content.matchAll(/async (\w+)\(/g)].map((m) => m[1]);
    const createMethods = methodNames.filter((n) => n.toLowerCase().startsWith('create'));
    expect(new Set(createMethods).size).toBe(createMethods.length); // all unique
  });

  it('generates discriminated union types and serializer for parameter groups on paginated GET', () => {
    const services: Service[] = [
      {
        name: 'Authorization',
        operations: [
          {
            name: 'listResourceUsers',
            httpMethod: 'get',
            path: '/fga/resources/{resourceType}/{resourceId}/users',
            pathParams: [
              {
                name: 'resourceType',
                type: { kind: 'primitive', type: 'string' },
                required: true,
              },
              {
                name: 'resourceId',
                type: { kind: 'primitive', type: 'string' },
                required: true,
              },
            ],
            queryParams: [
              {
                name: 'parent_resource_id',
                type: { kind: 'primitive', type: 'string' },
                required: false,
              },
              {
                name: 'parent_resource_type_slug',
                type: { kind: 'primitive', type: 'string' },
                required: false,
              },
              {
                name: 'parent_resource_external_id',
                type: { kind: 'primitive', type: 'string' },
                required: false,
              },
            ],
            headerParams: [],
            response: { kind: 'model', name: 'ResourceUser' },
            errors: [],
            pagination: {
              strategy: 'cursor',
              param: 'after',
              dataPath: 'data',
              itemType: { kind: 'model', name: 'ResourceUser' },
            },
            parameterGroups: [
              {
                name: 'parent_resource',
                optional: false,
                variants: [
                  {
                    name: 'by_id',
                    parameters: [
                      {
                        name: 'parent_resource_id',
                        type: { kind: 'primitive', type: 'string' },
                        required: false,
                      },
                    ],
                  },
                  {
                    name: 'by_external_id',
                    parameters: [
                      {
                        name: 'parent_resource_type_slug',
                        type: { kind: 'primitive', type: 'string' },
                        required: false,
                      },
                      {
                        name: 'parent_resource_external_id',
                        type: { kind: 'primitive', type: 'string' },
                        required: false,
                      },
                    ],
                  },
                ],
              },
            ],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const files = generateResources(services, ctx);
    const resourceContent = files[0].content;

    // The options interface file should contain the discriminated union types
    const optionsFile = files.find((f) => f.path.endsWith('list-resource-users-options.interface.ts'));
    expect(optionsFile).toBeDefined();
    const optionsContent = optionsFile!.content;

    // Variant interfaces with discriminator
    expect(optionsContent).toContain('export interface ParentResourceById {');
    expect(optionsContent).toContain("  type: 'by_id';");
    expect(optionsContent).toContain('  parentResourceId: string;');
    expect(optionsContent).toContain('}');

    expect(optionsContent).toContain('export interface ParentResourceByExternalId {');
    expect(optionsContent).toContain("  type: 'by_external_id';");
    expect(optionsContent).toContain('  parentResourceTypeSlug: string;');
    expect(optionsContent).toContain('  parentResourceExternalId: string;');

    // Union type alias
    expect(optionsContent).toContain('export type ParentResource = ParentResourceById | ParentResourceByExternalId;');

    // Options interface should have group field, not individual grouped params
    expect(optionsContent).toContain('parentResource: ParentResource;');
    expect(optionsContent).not.toContain('parentResourceId?:');
    expect(optionsContent).not.toContain('parentResourceTypeSlug?:');
    expect(optionsContent).not.toContain('parentResourceExternalId?:');

    // Wire serializer should exist and dispatch on discriminator
    expect(resourceContent).toContain('serializeListResourceUsersOptions');
    expect(resourceContent).toContain('switch (options.parentResource.type)');
    expect(resourceContent).toContain("case 'by_id':");
    expect(resourceContent).toContain('wire.parent_resource_id = options.parentResource.parentResourceId');
    expect(resourceContent).toContain("case 'by_external_id':");
    expect(resourceContent).toContain('wire.parent_resource_type_slug = options.parentResource.parentResourceTypeSlug');
    expect(resourceContent).toContain(
      'wire.parent_resource_external_id = options.parentResource.parentResourceExternalId',
    );

    // createPaginatedList should use the serializer
    expect(resourceContent).toMatch(/createPaginatedList<[^>]+>\([^)]+options,\s*serializeListResourceUsersOptions\)/);
  });

  it('generates optional parameter group field when group.optional is true', () => {
    const services: Service[] = [
      {
        name: 'Resources',
        operations: [
          {
            name: 'listResources',
            httpMethod: 'get',
            path: '/resources',
            pathParams: [],
            queryParams: [
              {
                name: 'filter_id',
                type: { kind: 'primitive', type: 'string' },
                required: false,
              },
              {
                name: 'filter_slug',
                type: { kind: 'primitive', type: 'string' },
                required: false,
              },
            ],
            headerParams: [],
            response: { kind: 'model', name: 'Resource' },
            errors: [],
            pagination: {
              strategy: 'cursor',
              param: 'after',
              dataPath: 'data',
              itemType: { kind: 'model', name: 'Resource' },
            },
            parameterGroups: [
              {
                name: 'filter',
                optional: true,
                variants: [
                  {
                    name: 'by_id',
                    parameters: [
                      {
                        name: 'filter_id',
                        type: { kind: 'primitive', type: 'string' },
                        required: false,
                      },
                    ],
                  },
                  {
                    name: 'by_slug',
                    parameters: [
                      {
                        name: 'filter_slug',
                        type: { kind: 'primitive', type: 'string' },
                        required: false,
                      },
                    ],
                  },
                ],
              },
            ],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const files = generateResources(services, ctx);
    const optionsFile = files.find((f) => f.path.endsWith('list-resources-options.interface.ts'));
    expect(optionsFile).toBeDefined();
    const optionsContent = optionsFile!.content;

    // Optional group field should have ? suffix
    expect(optionsContent).toContain('filter?: Filter;');

    // Wire serializer should guard with if-check for optional group
    const resourceContent = files[0].content;
    expect(resourceContent).toContain('if (options.filter !== undefined)');
  });

  it('generates parameter group types for non-paginated GET', () => {
    const services: Service[] = [
      {
        name: 'Items',
        operations: [
          {
            name: 'getItem',
            httpMethod: 'get',
            path: '/items/{id}',
            pathParams: [
              {
                name: 'id',
                type: { kind: 'primitive', type: 'string' },
                required: true,
              },
            ],
            queryParams: [
              {
                name: 'scope_id',
                type: { kind: 'primitive', type: 'string' },
                required: false,
              },
              {
                name: 'scope_name',
                type: { kind: 'primitive', type: 'string' },
                required: false,
              },
            ],
            headerParams: [],
            response: { kind: 'model', name: 'Item' },
            errors: [],
            parameterGroups: [
              {
                name: 'scope',
                optional: false,
                variants: [
                  {
                    name: 'by_id',
                    parameters: [
                      {
                        name: 'scope_id',
                        type: { kind: 'primitive', type: 'string' },
                        required: false,
                      },
                    ],
                  },
                  {
                    name: 'by_name',
                    parameters: [
                      {
                        name: 'scope_name',
                        type: { kind: 'primitive', type: 'string' },
                        required: false,
                      },
                    ],
                  },
                ],
              },
            ],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const files = generateResources(services, ctx);
    const content = files[0].content;

    // Should generate inline discriminated union types
    expect(content).toContain('export interface ScopeById {');
    expect(content).toContain("  type: 'by_id';");
    expect(content).toContain('  scopeId: string;');
    expect(content).toContain('export interface ScopeByName {');
    expect(content).toContain("  type: 'by_name';");
    expect(content).toContain('  scopeName: string;');
    expect(content).toContain('export type Scope = ScopeById | ScopeByName;');

    // Options interface should have group field
    expect(content).toContain('export interface GetItemOptions {');
    expect(content).toContain('  scope: Scope;');

    // Should NOT have individual grouped params in the options interface
    expect(content).not.toContain('scopeId?:');
    expect(content).not.toContain('scopeName?:');

    // Method should accept options
    expect(content).toContain('async getItem(id: string, options?: GetItemOptions)');

    // Should serialize group params with switch on discriminator
    expect(content).toContain('switch (options.scope.type)');
    expect(content).toContain("case 'by_id':");
    expect(content).toContain('query.scope_id = options.scope.scopeId');
    expect(content).toContain("case 'by_name':");
    expect(content).toContain('query.scope_name = options.scope.scopeName');
  });
});
