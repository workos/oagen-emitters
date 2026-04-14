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
    expect(content).toContain('[JsonProperty("name")]');
    expect(content).toContain('public string Name');
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

    // List method (public method name omits Async suffix; return type is async Task)
    expect(content).toContain('async Task<WorkOSList<Organization>>');
    expect(content).toContain('List(');

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
});
