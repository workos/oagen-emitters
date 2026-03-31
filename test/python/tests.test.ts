import { describe, it, expect } from 'vitest';
import { generateTests } from '../../src/python/tests.js';
import type { EmitterContext, ApiSpec, Service, Model } from '@workos/oagen';

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
};

const ctx: EmitterContext = {
  namespace: 'workos',
  namespacePascal: 'WorkOS',
  spec,
};

describe('generateTests', () => {
  it('generates conftest and helpers', () => {
    const files = generateTests(spec, ctx);
    const helpers = files.find((f) => f.path === 'tests/generated_helpers.py');
    expect(helpers).toBeDefined();
    expect(helpers!.content).toContain('def load_fixture(name: str)');
    const conftest = files.find((f) => f.path === 'tests/conftest.py');
    expect(conftest).toBeDefined();
    expect(conftest!.content).toContain('import pytest');
    expect(conftest!.content).toContain('import pytest_asyncio');
    expect(conftest!.content).toContain('from workos import WorkOS');
    expect(conftest!.content).toContain('@pytest.fixture');
    expect(conftest!.content).toContain('@pytest_asyncio.fixture');
    expect(conftest!.content).toContain('yield client');
    expect(conftest!.content).toContain('await client.close()');
  });

  it('generates per-service test file', () => {
    const files = generateTests(spec, ctx);
    const testFile = files.find((f) => f.path === 'tests/test_organizations.py');
    expect(testFile).toBeDefined();

    const content = testFile!.content;
    expect(content).toContain('class TestOrganizations:');
    // Method names normalized: get_organization → get, delete_organization → delete
    expect(content).toContain('def test_get(');
    expect(content).toContain('def test_delete(');
    expect(content).toContain('assert result is None');
    expect(content).toContain('isinstance(result, Organization)');
  });

  it('generates error test', () => {
    const files = generateTests(spec, ctx);
    const testFile = files.find((f) => f.path === 'tests/test_organizations.py');
    // Method names normalized: get_organization → get
    expect(testFile!.content).toContain('def test_get_unauthorized(');
    expect(testFile!.content).toContain('def test_get_not_found(');
    expect(testFile!.content).toContain('def test_get_rate_limited(');
    expect(testFile!.content).toContain('def test_get_server_error(');
    expect(testFile!.content).toContain('pytest.raises(AuthenticationError)');
  });

  it('generates generated client and pagination tests', () => {
    const files = generateTests(spec, ctx);
    const clientTests = files.find((f) => f.path === 'tests/test_generated_client.py');
    expect(clientTests).toBeDefined();
    expect(clientTests!.content).toContain('test_retry_exhaustion_raises_rate_limit');
    expect(clientTests!.content).toContain('test_timeout_error_is_wrapped');
    expect(clientTests!.content).toContain('test_documented_import_surface_exposes_resources');

    const paginationTests = files.find((f) => f.path === 'tests/test_pagination.py');
    expect(paginationTests).toBeDefined();
    expect(paginationTests!.content).toContain('class TestAsyncPage:');
  });

  it('generates fixture JSON files', () => {
    const files = generateTests(spec, ctx);
    const fixture = files.find((f) => f.path === 'tests/fixtures/organization.json');
    expect(fixture).toBeDefined();
    expect(fixture!.headerPlacement).toBe('skip');

    const data = JSON.parse(fixture!.content);
    expect(data).toHaveProperty('id');
    expect(data).toHaveProperty('name');
  });

  it('generates model edge-case and query/pagination regression tests', () => {
    const edgeModels: Model[] = [
      {
        name: 'Organization',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'status', type: { kind: 'enum', name: 'OrganizationStatus' }, required: true },
          { name: 'nickname', type: { kind: 'primitive', type: 'string' }, required: false },
          {
            name: 'external_id',
            type: { kind: 'nullable', inner: { kind: 'primitive', type: 'string' } },
            required: true,
          },
        ],
      },
      {
        name: 'OrganizationList',
        fields: [
          { name: 'data', type: { kind: 'array', items: { kind: 'model', name: 'Organization' } }, required: true },
          { name: 'list_metadata', type: { kind: 'model', name: 'ListMetadata' }, required: true },
        ],
      },
      {
        name: 'ListMetadata',
        fields: [
          { name: 'before', type: { kind: 'primitive', type: 'string' }, required: false },
          { name: 'after', type: { kind: 'primitive', type: 'string' }, required: false },
        ],
      },
    ];

    const edgeSpec: ApiSpec = {
      ...spec,
      models: edgeModels,
      enums: [
        {
          name: 'OrganizationStatus',
          values: [
            { name: 'ACTIVE', value: 'active' },
            { name: 'INACTIVE', value: 'inactive' },
          ],
        },
      ],
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
                { name: 'status', type: { kind: 'enum', name: 'OrganizationStatus' }, required: false },
                { name: 'email', type: { kind: 'primitive', type: 'string' }, required: false },
                { name: 'limit', type: { kind: 'primitive', type: 'integer' }, required: false },
                { name: 'before', type: { kind: 'primitive', type: 'string' }, required: false },
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
      ],
    };

    const files = generateTests(edgeSpec, { ...ctx, spec: edgeSpec });
    const serviceTest = files.find((f) => f.path === 'tests/test_organizations.py');
    const roundTripTest = files.find((f) => f.path === 'tests/test_models_round_trip.py');

    expect(serviceTest).toBeDefined();
    expect(serviceTest!.content).toContain('def test_list_organizations_empty_page(');
    expect(serviceTest!.content).toContain('def test_list_organizations_encodes_query_params(');
    expect(serviceTest!.content).toContain('assert request.url.params["email"] == "value email/test"');
    expect(serviceTest!.content).toContain('assert request.url.params["limit"] == "10"');

    expect(roundTripTest).toBeDefined();
    expect(roundTripTest!.content).toContain('def test_organization_minimal_payload(');
    expect(roundTripTest!.content).toContain('def test_organization_omits_absent_optional_non_nullable_fields(');
    expect(roundTripTest!.content).toContain('def test_organization_preserves_nullable_fields(');
    expect(roundTripTest!.content).toContain('def test_organization_round_trips_unknown_enum_values(');
  });
});
