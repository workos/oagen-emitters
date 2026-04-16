import { describe, it, expect } from 'vitest';
import { generateTests } from '../../src/dotnet/tests.js';
import { primeEnumAliases } from '../../src/dotnet/enums.js';
import type { EmitterContext, ApiSpec, Service, Model } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';

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

const spec: ApiSpec = {
  name: 'TestAPI',
  version: '1.0.0',
  baseUrl: 'https://api.workos.com',
  services,
  models,
  enums: [],
  sdk: defaultSdkBehavior(),
};

const ctx: EmitterContext = {
  namespace: 'workos',
  namespacePascal: 'WorkOS',
  spec,
};

describe('dotnet/tests', () => {
  it('generates per-service test files', () => {
    primeEnumAliases([]);
    const files = generateTests(spec, ctx);
    const testFile = files.find((f) => f.path === 'Tests/OrganizationsServiceTest.cs');
    expect(testFile).toBeDefined();

    const content = testFile!.content;
    expect(content).toContain('namespace WorkOSTests');
    expect(content).toContain('public class OrganizationsServiceTest');
    expect(content).toContain('HttpMock');
    expect(content).toContain('[Fact]');
  });

  it('generates GET operation test with fixture', () => {
    primeEnumAliases([]);
    const files = generateTests(spec, ctx);
    const testFile = files.find((f) => f.path === 'Tests/OrganizationsServiceTest.cs')!;
    const content = testFile.content;

    expect(content).toContain('TestGet');
    expect(content).toContain('ReadAllText');
    expect(content).toContain('MockResponse');
    expect(content).toContain('Assert.NotNull(result)');
    expect(content).toContain('AssertRequestWasMade');
  });

  it('generates DELETE operation test', () => {
    primeEnumAliases([]);
    const files = generateTests(spec, ctx);
    const testFile = files.find((f) => f.path === 'Tests/OrganizationsServiceTest.cs')!;
    const content = testFile.content;

    expect(content).toContain('TestDelete');
    expect(content).toContain('HttpMethod.Delete');
    expect(content).toContain('NoContent');
  });

  it('generates error tests (401, 404, 422, 429, 500)', () => {
    primeEnumAliases([]);
    const files = generateTests(spec, ctx);
    const testFile = files.find((f) => f.path === 'Tests/OrganizationsServiceTest.cs')!;
    const content = testFile.content;

    expect(content).toContain('TestError401');
    expect(content).toContain('AuthenticationException');
    expect(content).toContain('TestError404');
    expect(content).toContain('NotFoundException');
    expect(content).toContain('TestError422');
    expect(content).toContain('UnprocessableEntityException');
    expect(content).toContain('TestError429');
    expect(content).toContain('RateLimitExceededException');
    expect(content).toContain('TestError500');
    expect(content).toContain('ServerException');
  });

  it('generates fixture JSON files', () => {
    primeEnumAliases([]);
    const files = generateTests(spec, ctx);
    const fixture = files.find((f) => f.path === 'testdata/organization.json');
    expect(fixture).toBeDefined();
    expect(fixture!.headerPlacement).toBe('skip');

    const data = JSON.parse(fixture!.content);
    expect(data).toHaveProperty('id');
    expect(data).toHaveProperty('name');
  });

  it('does not generate static test infrastructure', () => {
    primeEnumAliases([]);
    const files = generateTests(spec, ctx);
    const paths = files.map((f) => f.path);

    // HttpMock and other static helpers are @oagen-ignore-file in target SDK
    expect(paths.find((p) => p.includes('HttpMock'))).toBeUndefined();
    expect(paths.find((p) => p.includes('WorkOSClientTest'))).toBeUndefined();
  });

  it('generates auto-pagination tests for paginated operations', () => {
    const paginatedModels: Model[] = [
      ...models,
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

    const paginatedServices: Service[] = [
      {
        name: 'Organizations',
        operations: [
          {
            name: 'listOrganizations',
            httpMethod: 'get',
            path: '/organizations',
            pathParams: [],
            queryParams: [],
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

    const paginatedSpec: ApiSpec = {
      ...spec,
      services: paginatedServices,
      models: paginatedModels,
    };

    primeEnumAliases([]);
    const files = generateTests(paginatedSpec, { ...ctx, spec: paginatedSpec });
    const testFile = files.find((f) => f.path === 'Tests/OrganizationsServiceTest.cs')!;
    const content = testFile.content;

    // Auto-paging test
    expect(content).toContain('AutoPagingAsync');
    expect(content).toContain('MockSequentialResponses');
    expect(content).toContain('await foreach');
  });
});
