import { describe, it, expect } from 'vitest';
import { generateTests } from '../../src/python/tests.js';
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
        successResponses: [{ statusCode: 202, type: { kind: 'primitive', type: 'unknown' } }],
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

describe('generateTests', () => {
  it('does not generate conftest, helpers, client tests, or pagination tests (now @oagen-ignore-file)', () => {
    const files = generateTests(spec, ctx);
    expect(files.find((f) => f.path === 'tests/generated_helpers.py')).toBeUndefined();
    expect(files.find((f) => f.path === 'tests/conftest.py')).toBeUndefined();
    expect(files.find((f) => f.path === 'tests/test_generated_client.py')).toBeUndefined();
    expect(files.find((f) => f.path === 'tests/test_pagination.py')).toBeUndefined();
  });

  it('generates per-service test file', () => {
    const files = generateTests(spec, ctx);
    const testFile = files.find((f) => f.path === 'tests/test_organizations.py');
    expect(testFile).toBeDefined();

    const content = testFile!.content;
    expect(content).toContain('class TestOrganizations:');
    expect(content).toContain('def test_get_organization(');
    expect(content).toContain('def test_delete_organization(');
    expect(content).toContain('httpx_mock.add_response(status_code=202, content=b"\\n")');
    expect(content).toContain('assert result is None');
    expect(content).toContain('isinstance(result, Organization)');
  });

  it('generates error test', () => {
    const files = generateTests(spec, ctx);
    const testFile = files.find((f) => f.path === 'tests/test_organizations.py');
    expect(testFile!.content).toContain('def test_get_organization_unauthorized(');
    expect(testFile!.content).toContain('def test_get_organization_not_found(');
    expect(testFile!.content).toContain('def test_get_organization_rate_limited(');
    expect(testFile!.content).toContain('def test_get_organization_server_error(');
    expect(testFile!.content).toContain('pytest.raises(AuthenticationError)');
  });

  it('still generates per-service and model round-trip tests', () => {
    const files = generateTests(spec, ctx);
    expect(files.find((f) => f.path === 'tests/test_organizations.py')).toBeDefined();
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

  it('generates discriminator dispatch tests for dispatcher models', () => {
    const discriminatorModel: any = {
      name: 'EventSchema',
      fields: [],
      discriminator: {
        property: 'event',
        mapping: {
          'user.created': 'UserCreated',
          'dsync.user.created': 'DsyncUserCreated',
        },
      },
    };

    const discModels: Model[] = [
      discriminatorModel,
      {
        name: 'UserCreated',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'event', type: { kind: 'literal', value: 'user.created' }, required: true },
          { name: 'data', type: { kind: 'primitive', type: 'unknown' }, required: true },
        ],
      },
      {
        name: 'DsyncUserCreated',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'event', type: { kind: 'literal', value: 'dsync.user.created' }, required: true },
          { name: 'data', type: { kind: 'primitive', type: 'unknown' }, required: true },
        ],
      },
    ];

    const discServices: Service[] = [
      {
        name: 'Events',
        operations: [
          {
            name: 'listEvents',
            httpMethod: 'get',
            path: '/events',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model', name: 'EventSchema' },
            errors: [],
            injectIdempotencyKey: false,
            pagination: {
              strategy: 'cursor',
              param: 'after',
              dataPath: 'data',
              itemType: { kind: 'model', name: 'EventSchema' },
            },
          },
        ],
      },
    ];

    const discSpec: ApiSpec = {
      ...spec,
      models: discModels,
      services: discServices,
      enums: [],
    };

    const files = generateTests(discSpec, { ...ctx, spec: discSpec });
    const roundTripTest = files.find((f) => f.path === 'tests/test_events_models_round_trip.py');
    expect(roundTripTest).toBeDefined();

    const content = roundTripTest!.content;
    expect(content).toContain('class TestDiscriminatorDispatch:');
    expect(content).toContain('def test_event_schema_dispatches_known_variant(self)');
    expect(content).toContain('def test_event_schema_returns_unknown_for_unrecognized_type(self)');
    expect(content).toContain('isinstance(result, EventSchemaUnknown)');
    expect(content).toContain('def test_event_schema_raises_on_missing_discriminator(self)');
    expect(content).toContain('def test_event_schema_raises_on_none_discriminator(self)');
    expect(content).toContain('pytest.raises(Exception)');

    // Service test should exercise discriminated union dispatch through pagination
    const serviceTest = files.find((f) => f.path === 'tests/test_events.py');
    expect(serviceTest).toBeDefined();
    const svcContent = serviceTest!.content;
    expect(svcContent).toContain('load_fixture("dsync_user_created.json")');
    expect(svcContent).toContain('isinstance(page.data[0], DsyncUserCreated)');
    expect(svcContent).toContain('assert len(page.data) == 1');
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
    const roundTripTest = files.find((f) => f.path === 'tests/test_organizations_models_round_trip.py');

    expect(serviceTest).toBeDefined();
    expect(serviceTest!.content).toContain('assert len(page.data) == 1');
    expect(serviceTest!.content).toContain('assert isinstance(page.data[0], Organization)');
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
