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
});
