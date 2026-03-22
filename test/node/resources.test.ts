import { describe, it, expect } from 'vitest';
import { generateResources } from '../../src/node/resources.js';
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
    expect(content).toContain('import { AutoPaginatable }');
    expect(content).toContain('import { fetchAndDeserialize }');

    // Should generate options interface
    expect(content).toContain('export interface ListOrganizationsOptions extends PaginationOptions {');
    expect(content).toContain('domains?: string[];');

    // Should return AutoPaginatable
    expect(content).toContain('Promise<AutoPaginatable<Organization, ListOrganizationsOptions>>');
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
    expect(content).toContain('@param xRequestId - Unique request identifier.');
    expect(content).toContain('@param sessionToken - The session cookie.');
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
});
