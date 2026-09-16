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
    // Fixtures overwrite rather than deep-merge into the on-disk JSON, so a
    // regen can't preserve stale entries (e.g. an old `metadata: { "key": {} }`).
    expect(fixture!.overwriteExisting).toBe(true);

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
    // No parameter groups, so no grouped-query pager test.
    expect(content).not.toContain('PreservesGroupedQueryParams');
  });

  it('does not seed a string literal into a date-time (DateTimeOffset) property', () => {
    const dtModels: Model[] = [
      {
        name: 'ExportCreation',
        fields: [
          { name: 'organization_id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'range_start', type: { kind: 'primitive', type: 'string', format: 'date-time' }, required: true },
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
    const dtSpec: ApiSpec = { ...spec, models: dtModels, services: dtServices };
    const content = generateTests(dtSpec, { ...ctx, spec: dtSpec }).find(
      (f) => f.path === 'Tests/AuditLogsServiceTest.cs',
    )!.content;

    // A DateTimeOffset property must never be assigned a string literal seed.
    expect(content).not.toContain('RangeStart = "');
    // The plain string field is still seeded.
    expect(content).toContain('OrganizationId = "test_organization_id"');
  });
  /**
   * Build a paginated Authorization list op whose parent scope is a mutually
   * exclusive parameter group, mirroring GET /authorization/resources.
   */
  function groupedListSpec(opts: {
    name: string;
    path: string;
    group: string;
    externalId: string;
    withPathParam: boolean;
    memberType?: { kind: 'primitive'; type: 'string' | 'integer' };
  }): ApiSpec {
    const memberType = opts.memberType ?? { kind: 'primitive', type: 'string' };
    const param = (name: string) => ({ name, type: memberType, required: true });
    const groupedServices: Service[] = [
      {
        name: 'Authorization',
        operations: [
          {
            name: opts.name,
            httpMethod: 'get',
            path: opts.path,
            pathParams: opts.withPathParam
              ? [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }]
              : [],
            queryParams: [param('parent_resource_id'), param('parent_resource_type_slug'), param(opts.externalId)],
            headerParams: [],
            response: { kind: 'model', name: 'ResourceList' },
            errors: [],
            injectIdempotencyKey: false,
            pagination: {
              strategy: 'cursor',
              param: 'after',
              dataPath: 'data',
              itemType: { kind: 'model', name: 'Resource' },
            },
            parameterGroups: [
              {
                name: opts.group,
                optional: !opts.withPathParam,
                variants: [
                  { name: 'by_id', parameters: [param('parent_resource_id')] },
                  { name: 'by_external_id', parameters: [param('parent_resource_type_slug'), param(opts.externalId)] },
                ],
              },
            ],
          },
        ],
      },
    ];
    const groupedModels: Model[] = [
      { name: 'Resource', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
      {
        name: 'ResourceList',
        fields: [{ name: 'data', type: { kind: 'array', items: { kind: 'model', name: 'Resource' } }, required: true }],
      },
    ];
    return { ...spec, services: groupedServices, models: groupedModels };
  }

  it.each([
    {
      name: 'listResources',
      path: '/authorization/resources',
      group: 'parent',
      externalId: 'parent_external_id',
      withPathParam: false,
      method: 'ListResourcesAutoPagingAsync',
      options: 'AuthorizationListResourcesOptions',
      setup: 'options.Parent = new AuthorizationParentById { ParentResourceId = "test_parent_resource_id" };',
      call: 'this.service.ListResourcesAutoPagingAsync(options)',
    },
    {
      name: 'listResourcesForMembership',
      path: '/authorization/organization_memberships/{id}/resources',
      group: 'parent_resource',
      externalId: 'parent_resource_external_id',
      withPathParam: true,
      method: 'ListResourcesForMembershipAutoPagingAsync',
      options: 'AuthorizationListResourcesForMembershipOptions',
      setup:
        'options.ParentResource = new AuthorizationParentResourceById { ParentResourceId = "test_parent_resource_id" };',
      call: 'this.service.ListResourcesForMembershipAutoPagingAsync("test_id", options)',
    },
  ])('pins grouped query params on every auto-paged request for $name', (tc) => {
    const groupedSpec = groupedListSpec(tc);
    primeEnumAliases([]);
    const files = generateTests(groupedSpec, { ...ctx, spec: groupedSpec });
    const content = files.find((f) => f.path === 'Tests/AuthorizationServiceTest.cs')!.content;

    const testName = `Test${tc.method}PreservesGroupedQueryParams`;
    expect(content).toContain(`public async Task ${testName}()`);
    const body = content.slice(content.indexOf(testName));

    // Two pages on the plain path matcher; the query string is asserted, not matched.
    expect(body).toContain(
      `this.httpMock.MockSequentialResponses(HttpMethod.Get, "${tc.path.replace('{id}', 'test_id')}", HttpStatusCode.OK, new[] { page1, page2 });`,
    );
    // The first variant is seeded through the JsonIgnore'd group property.
    expect(body).toContain(`var options = new ${tc.options}();`);
    expect(body).toContain(tc.setup);
    expect(body).toContain(`await foreach (var item in ${tc.call})`);
    // Every page the pager fetched must carry the dispatched param.
    expect(body).toContain('Assert.Equal(2, items.Count);');
    expect(body).toContain('Assert.Equal(2, this.httpMock.CapturedRequests.Count);');
    expect(body).toContain('foreach (var request in this.httpMock.CapturedRequests)');
    expect(body).toContain('var query = System.Web.HttpUtility.ParseQueryString(request.RequestUri.Query);');
    expect(body).toContain('Assert.Equal("test_parent_resource_id", query["parent_resource_id"]);');
    // Only the seeded variant's members are asserted.
    expect(body).not.toContain('parent_resource_type_slug');
    expect(body).not.toContain(tc.externalId);
  });

  it('skips the grouped-query pager test when no variant can be seeded as strings', () => {
    const groupedSpec = groupedListSpec({
      name: 'listResources',
      path: '/authorization/resources',
      group: 'parent',
      externalId: 'parent_external_id',
      withPathParam: false,
      memberType: { kind: 'primitive', type: 'integer' },
    });
    primeEnumAliases([]);
    const files = generateTests(groupedSpec, { ...ctx, spec: groupedSpec });
    const content = files.find((f) => f.path === 'Tests/AuthorizationServiceTest.cs')!.content;

    // The plain two-page and empty pager tests still emit; only the seeded one is dropped.
    expect(content).toContain('public async Task TestListResourcesAutoPagingAsync()');
    expect(content).toContain('public async Task TestListResourcesAutoPagingAsyncEmpty()');
    expect(content).not.toContain('PreservesGroupedQueryParams');
  });
});
