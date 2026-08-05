import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Service, Model } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateTests } from '../../src/php/tests.js';

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
        name: 'listOrganizations',
        httpMethod: 'get',
        path: '/organizations',
        pathParams: [],
        queryParams: [{ name: 'after', type: { kind: 'primitive', type: 'string' }, required: false }],
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

const spec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: '',
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
  it('does not generate TestHelper (now hand-maintained)', () => {
    const result = generateTests(spec, ctx);

    const helper = result.find((f) => f.path === 'tests/TestHelper.php');
    expect(helper).toBeUndefined();
  });

  it('generates resource test files', () => {
    const result = generateTests(spec, ctx);

    const resourceTest = result.find((f) => f.path === 'tests/Service/OrganizationsTest.php');
    expect(resourceTest).toBeDefined();
    expect(resourceTest!.content).toContain('class OrganizationsTest extends TestCase');
    expect(resourceTest!.content).toContain('use TestHelper;');
    expect(resourceTest!.content).toContain('testGet');
    // Round-trip assertion: fromArray -> toArray must not throw
    expect(resourceTest!.content).toContain('$result->toArray()');
  });

  it('generates client test', () => {
    const result = generateTests(spec, ctx);

    const clientTest = result.find((f) => f.path === 'tests/ClientTest.php');
    expect(clientTest).toBeDefined();
    expect(clientTest!.content).toContain('testConstructor');
  });

  it('generates pagination boundary test with cursor null assertions', () => {
    const result = generateTests(spec, ctx);

    const resourceTest = result.find((f) => f.path === 'tests/Service/OrganizationsTest.php');
    expect(resourceTest).toBeDefined();
    expect(resourceTest!.content).toContain('testPaginationBoundary');
    // Cursor null assertions
    expect(resourceTest!.content).toContain("$this->assertNull($result->listMetadata['before'])");
    expect(resourceTest!.content).toContain("$this->assertNull($result->listMetadata['after'])");
    // Iteration still tested
    expect(resourceTest!.content).toContain('foreach ($result as $item)');
  });

  it('builds variant fixtures with named arguments so optional-member reordering stays valid', () => {
    const userModels: Model[] = [
      { name: 'User', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
      {
        name: 'CreateUserRequest',
        fields: [
          { name: 'password', type: { kind: 'primitive', type: 'string' }, required: false },
          { name: 'password_salt_position', type: { kind: 'primitive', type: 'string' }, required: false },
        ],
      },
    ];

    const userServices: Service[] = [
      {
        name: 'UserManagement',
        operations: [
          {
            name: 'createUser',
            httpMethod: 'post',
            path: '/user_management/users',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            requestBody: { kind: 'model', name: 'CreateUserRequest' },
            response: { kind: 'model', name: 'User' },
            errors: [],
            injectIdempotencyKey: false,
            parameterGroups: [
              {
                name: 'password',
                optional: false,
                variants: [
                  {
                    name: 'plaintext',
                    parameters: [
                      {
                        name: 'password_salt_position',
                        type: { kind: 'primitive', type: 'string' },
                        required: false,
                      },
                      { name: 'password', type: { kind: 'primitive', type: 'string' }, required: false },
                    ],
                    optionalParameters: ['password_salt_position'],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];

    const userSpec: ApiSpec = { ...spec, services: userServices, models: userModels };
    const result = generateTests(userSpec, { ...ctx, spec: userSpec });

    // Named arguments are order-independent, so the fixture stays valid even
    // though the variant class declares $saltPosition last. Every member gets a
    // value, including the optional one, so the body assertions still hold.
    const resourceTest = result.find((f) => f.path === 'tests/Service/UserManagementTest.php');
    expect(resourceTest).toBeDefined();
    expect(resourceTest!.content).toContain(
      "new \\WorkOS\\Service\\PasswordPlaintext(saltPosition: 'test_value', password: 'test_value')",
    );
  });

  it('generates redirect endpoint test with query param assertions', () => {
    const ssoServices: Service[] = [
      {
        name: 'SSO',
        operations: [
          {
            name: 'getAuthorizationUrl',
            httpMethod: 'get',
            path: '/sso/authorize',
            pathParams: [],
            queryParams: [
              { name: 'client_id', type: { kind: 'primitive', type: 'string' }, required: true },
              { name: 'response_type', type: { kind: 'primitive', type: 'string' }, required: true },
              { name: 'redirect_uri', type: { kind: 'primitive', type: 'string' }, required: true },
              { name: 'state', type: { kind: 'primitive', type: 'string' }, required: false },
            ],
            headerParams: [],
            response: { kind: 'primitive', type: 'unknown' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const ssoSpec = { ...spec, services: ssoServices };
    const ssoCtx: EmitterContext = {
      ...ctx,
      spec: ssoSpec,
      resolvedOperations: [
        {
          operation: ssoServices[0].operations[0],
          service: ssoServices[0],
          methodName: 'get_authorization_url',
          mountOn: 'SSO',
          defaults: { response_type: 'code' },
          inferFromClient: ['client_id'],
        } as any,
      ],
    };

    const result = generateTests(ssoSpec, ssoCtx);
    const testFile = result.find((f) => f.path === 'tests/Service/SSOTest.php');
    expect(testFile).toBeDefined();
    const content = testFile!.content;

    // Should be a redirect endpoint test (no mock responses, returns string)
    expect(content).toContain('$this->assertIsString($result)');
    expect(content).toContain("assertStringContainsString('sso/authorize'");

    // Should parse query params from URL
    expect(content).toContain('parse_str(parse_url($result, PHP_URL_QUERY)');

    // Should assert visible query params (required and optional)
    expect(content).toContain("assertSame('test_value', $query['redirect_uri'])");
    expect(content).toContain("assertSame('test_value', $query['state'])");

    // Should pass optional params in the method call
    expect(content).toContain("state: 'test_value'");

    // Should assert hidden defaults
    expect(content).toContain("assertSame('code', $query['response_type'])");

    // Should assert inferred client fields
    expect(content).toContain("assertArrayHasKey('client_id', $query)");
  });

  it('generates fixture JSON files', () => {
    const result = generateTests(spec, ctx);

    const fixture = result.find((f) => f.path.includes('Fixtures/organization.json'));
    expect(fixture).toBeDefined();
    // Fixtures overwrite rather than deep-merge, so a regen can't preserve
    // stale entries (e.g. an old `metadata: { "key": {} }` map placeholder).
    expect(fixture!.overwriteExisting).toBe(true);
    const parsed = JSON.parse(fixture!.content);
    expect(parsed).toHaveProperty('id');
    expect(parsed).toHaveProperty('name');
  });

  describe('scoped (--services) generation', () => {
    // Two-service / two-model spec: a scoped run selecting only `Organizations`
    // must regenerate ONLY Organizations' artifacts and leave Connections'
    // fixtures/tests untouched on disk (never emitted this run).
    const scopedModels: Model[] = [
      {
        name: 'Organization',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
        ],
      },
      {
        name: 'Connection',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
        ],
      },
    ];

    const scopedServices: Service[] = [
      ...services,
      {
        name: 'Connections',
        operations: [
          {
            name: 'getConnection',
            httpMethod: 'get',
            path: '/connections/{id}',
            pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model', name: 'Connection' },
            errors: [],
            injectIdempotencyKey: false,
          },
          {
            name: 'listConnections',
            httpMethod: 'get',
            path: '/connections',
            pathParams: [],
            queryParams: [{ name: 'after', type: { kind: 'primitive', type: 'string' }, required: false }],
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

    const scopedSpec: ApiSpec = { ...spec, services: scopedServices, models: scopedModels };

    // Resolved operations drive mount grouping (scopedMountGroups). Provide them
    // for both services so a scoped run can select `Organizations` and drop
    // `Connections`.
    const resolvedOperations = [
      ...scopedServices[0].operations.map((operation) => ({
        operation,
        service: scopedServices[0],
        methodName: operation.name,
        mountOn: 'Organizations',
      })),
      ...scopedServices[1].operations.map((operation) => ({
        operation,
        service: scopedServices[1],
        methodName: operation.name,
        mountOn: 'Connections',
      })),
    ] as any;

    // Scope to `Organizations` only. `scopedModelNames` (selected-only) is what
    // gates fixtures — Connection is reachable only from the out-of-scope service.
    const scopedCtx: EmitterContext = {
      ...ctx,
      spec: scopedSpec,
      resolvedOperations,
      scopedServices: new Set(['Organizations']),
      scopedModelNames: new Set(['Organization']),
    };

    it('emits fixtures only for in-scope (selected) models', () => {
      const result = generateTests(scopedSpec, scopedCtx);

      // In-scope model fixture (+ list fixture) present.
      expect(result.find((f) => f.path === 'tests/Fixtures/organization.json')).toBeDefined();
      expect(result.find((f) => f.path === 'tests/Fixtures/list_organization.json')).toBeDefined();

      // Out-of-scope model fixtures NOT emitted (left untouched on disk).
      expect(result.find((f) => f.path === 'tests/Fixtures/connection.json')).toBeUndefined();
      expect(result.find((f) => f.path === 'tests/Fixtures/list_connection.json')).toBeUndefined();
    });

    it('emits per-service test files only for the selected service', () => {
      const result = generateTests(scopedSpec, scopedCtx);

      expect(result.find((f) => f.path === 'tests/Service/OrganizationsTest.php')).toBeDefined();
      expect(result.find((f) => f.path === 'tests/Service/ConnectionsTest.php')).toBeUndefined();
    });

    it('does not emit a monolithic model round-trip test (PHP has none)', () => {
      const result = generateTests(scopedSpec, scopedCtx);

      // PHP round-trips models inline in the per-service tests; there is no
      // whole-suite aggregate file that would reference out-of-scope models.
      const roundTrip = result.find((f) => /round.?trip|model_round|ModelRoundTrip/i.test(f.path));
      expect(roundTrip).toBeUndefined();
    });

    it('a full (unscoped) run still emits every model fixture', () => {
      const fullCtx: EmitterContext = { ...ctx, spec: scopedSpec, resolvedOperations };
      const result = generateTests(scopedSpec, fullCtx);

      expect(result.find((f) => f.path === 'tests/Fixtures/organization.json')).toBeDefined();
      expect(result.find((f) => f.path === 'tests/Fixtures/connection.json')).toBeDefined();
      expect(result.find((f) => f.path === 'tests/Service/OrganizationsTest.php')).toBeDefined();
      expect(result.find((f) => f.path === 'tests/Service/ConnectionsTest.php')).toBeDefined();
    });
  });

  it('asserts date-time request-body fields against the RFC3339 wire value', () => {
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
      (f) => f.path === 'tests/Service/AuditLogsTest.php',
    )!.content;

    // Call passes a DateTimeImmutable; the body assertion expects its RFC3339 form.
    expect(content).toContain("new \\DateTimeImmutable('2023-01-01T00:00:00Z')");
    expect(content).toContain("assertSame('2023-01-01T00:00:00.000+00:00', $body['range_start'])");
    // The plain-string placeholder must NOT be used for a date-time field.
    expect(content).not.toContain("assertSame('test_value', $body['range_start'])");
  });
});
