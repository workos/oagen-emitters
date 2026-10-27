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

  it('builds a discriminated-union fixture from the first variant alone', () => {
    // oagen 0.32 gives a discriminated union the merged superset of its
    // variants' fields: `metadata` below is declared only by `client_credentials`.
    const union = {
      name: 'Credential',
      fields: [
        { name: 'auth_method', type: { kind: 'literal', value: 'oauth' }, required: false },
        { name: 'value', type: { kind: 'primitive', type: 'string' }, required: false },
        { name: 'metadata', type: { kind: 'map', valueType: { kind: 'primitive', type: 'unknown' } }, required: false },
      ],
      discriminator: {
        property: 'auth_method',
        mapping: { oauth: 'OAuthCredential', client_credentials: 'ClientCredentialsCredential' },
      },
    } as Model;
    const unionModels: Model[] = [
      union,
      {
        name: 'OAuthCredential',
        fields: [
          { name: 'auth_method', type: { kind: 'literal', value: 'oauth' }, required: true },
          { name: 'value', type: { kind: 'primitive', type: 'string' }, required: true },
        ],
      },
      {
        name: 'ClientCredentialsCredential',
        fields: [
          { name: 'auth_method', type: { kind: 'literal', value: 'client_credentials' }, required: true },
          { name: 'value', type: { kind: 'primitive', type: 'string' }, required: true },
          {
            name: 'metadata',
            type: { kind: 'map', valueType: { kind: 'primitive', type: 'unknown' } },
            required: true,
          },
        ],
      },
      {
        name: 'CredentialsResponse',
        fields: [{ name: 'credential', type: { kind: 'model', name: 'Credential' }, required: true }],
      },
    ];
    const unionSpec: ApiSpec = { ...spec, models: [...models, ...unionModels] };
    const files = generateTests(unionSpec, { ...ctx, spec: unionSpec });
    const fixture = JSON.parse(files.find((f) => f.path === 'tests/fixtures/credentials_response.json')!.content);
    expect(Object.keys(fixture.credential).sort()).toEqual(['auth_method', 'value']);
    expect(fixture.credential.auth_method).toBe('oauth');
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

  it('drives date-time query params and body fields through the client and asserts the UTC Z wire form', () => {
    const dateTime = { kind: 'primitive', type: 'string', format: 'date-time' } as const;
    const str = { kind: 'primitive', type: 'string' } as const;
    const dtModels: Model[] = [
      { name: 'Export', fields: [{ name: 'id', type: str, required: true }] },
      {
        name: 'ExportCreation',
        fields: [
          { name: 'name', type: str, required: true },
          { name: 'range_start', type: dateTime, required: true },
          { name: 'range_end', type: { kind: 'nullable', inner: dateTime }, required: false },
        ],
      },
      {
        name: 'ExportList',
        fields: [
          { name: 'data', type: { kind: 'array', items: { kind: 'model', name: 'Export' } }, required: true },
          { name: 'list_metadata', type: { kind: 'model', name: 'ListMetadata' }, required: true },
        ],
      },
      {
        name: 'ListMetadata',
        fields: [
          { name: 'before', type: str, required: false },
          { name: 'after', type: str, required: false },
        ],
      },
    ];
    const dtSpec: ApiSpec = {
      ...spec,
      models: dtModels,
      services: [
        {
          name: 'Events',
          operations: [
            {
              name: 'listEvents',
              httpMethod: 'get',
              path: '/events',
              pathParams: [],
              queryParams: [
                { name: 'range_start', type: dateTime, required: false },
                { name: 'range_end', type: { kind: 'nullable', inner: dateTime }, required: false },
                { name: 'organization_id', type: str, required: false },
                { name: 'limit', type: { kind: 'primitive', type: 'integer' }, required: false },
                { name: 'after', type: str, required: false },
              ],
              headerParams: [],
              response: { kind: 'model', name: 'ExportList' },
              errors: [],
              injectIdempotencyKey: false,
              pagination: {
                strategy: 'cursor',
                param: 'after',
                dataPath: 'data',
                itemType: { kind: 'model', name: 'Export' },
              },
            },
          ],
        },
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
        {
          name: 'Plain',
          operations: [
            {
              name: 'getPlain',
              httpMethod: 'get',
              path: '/plain',
              pathParams: [],
              queryParams: [{ name: 'since', type: str, required: false }],
              headerParams: [],
              response: { kind: 'model', name: 'Export' },
              errors: [],
              injectIdempotencyKey: false,
            },
          ],
        },
      ],
    };

    const files = generateTests(dtSpec, { ...ctx, spec: dtSpec });
    const events = files.find((f) => f.path === 'tests/test_events.py')!.content;
    const auditLogs = files.find((f) => f.path === 'tests/test_audit_logs.py')!.content;
    const plain = files.find((f) => f.path === 'tests/test_plain.py')!.content;

    // One shared value table per file: aware UTC, aware non-UTC, naive, and a
    // pre-formatted string, all expected to hit the wire identically.
    for (const content of [events, auditLogs]) {
      expect(content).toContain('import json\nfrom datetime import datetime, timedelta, timezone\n\nimport pytest');
      expect(content).toContain('DATETIME_PARAM_VALUES = [');
      expect(content).toContain('datetime(2026, 10, 1, 18, 1, 14, 870000, tzinfo=timezone.utc),');
      expect(content).toContain('datetime(2026, 10, 1, 14, 1, 14, 870000, tzinfo=timezone(timedelta(hours=-4))),');
      expect(content).toContain('datetime(2026, 10, 1, 18, 1, 14, 870000),');
      expect(content).toContain('"2026-10-01T18:01:14.870Z",');
      expect(content).toContain('DATETIME_PARAM_WIRE = "2026-10-01T18:01:14.870Z"');
    }

    // Query params: sync and async, parametrized over the value table, asserting the encoded query.
    expect(events).toContain(
      '    @pytest.mark.parametrize("value", DATETIME_PARAM_VALUES)\n' +
        '    def test_list_events_formats_datetime_query_params(self, workos, httpx_mock, value):\n' +
        '        httpx_mock.add_response(json={"data": [], "list_metadata": {}})\n' +
        '        workos.events.list_events(range_start=value, range_end=value)\n' +
        '        request = httpx_mock.get_request()\n' +
        '        assert request.url.params["range_start"] == DATETIME_PARAM_WIRE\n' +
        '        assert request.url.params["range_end"] == DATETIME_PARAM_WIRE\n',
    );
    expect(events).toContain(
      '    @pytest.mark.parametrize("value", DATETIME_PARAM_VALUES)\n' +
        '    @pytest.mark.asyncio\n' +
        '    async def test_list_events_formats_datetime_query_params(self, async_workos, httpx_mock, value):\n' +
        '        httpx_mock.add_response(json={"data": [], "list_metadata": {}})\n' +
        '        await async_workos.events.list_events(range_start=value, range_end=value)\n' +
        '        request = httpx_mock.get_request()\n' +
        '        assert request.url.params["range_start"] == DATETIME_PARAM_WIRE\n',
    );
    expect(events).not.toContain('formats_datetime_body_fields');
    // Plain string params keep their pass-through assertion in the encoding test.
    expect(events).toContain('assert request.url.params["organization_id"] == "value organization_id/test"');

    // Body fields: required stubs stay, every date-time field (required or optional) is the parametrized value.
    expect(auditLogs).toContain(
      '    @pytest.mark.parametrize("value", DATETIME_PARAM_VALUES)\n' +
        '    def test_create_export_formats_datetime_body_fields(self, workos, httpx_mock, value):\n' +
        '        httpx_mock.add_response(json=load_fixture("export.json"))\n' +
        '        workos.audit_logs.create_export(name="test_name", range_start=value, range_end=value)\n' +
        '        request = httpx_mock.get_request()\n' +
        '        body = json.loads(request.content)\n' +
        '        assert body["range_start"] == DATETIME_PARAM_WIRE\n' +
        '        assert body["range_end"] == DATETIME_PARAM_WIRE\n',
    );
    expect(auditLogs).toContain(
      '    async def test_create_export_formats_datetime_body_fields(self, async_workos, httpx_mock, value):',
    );
    expect(auditLogs).not.toContain('formats_datetime_query_params');

    // Files without a date-time parameter get neither the import nor the tests.
    expect(plain).not.toContain('from datetime import');
    expect(plain).not.toContain('DATETIME_PARAM_VALUES');
    expect(plain).not.toContain('formats_datetime');
  });
});
