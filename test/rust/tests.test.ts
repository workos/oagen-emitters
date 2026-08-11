import { describe, it, expect } from 'vitest';
import type { ApiSpec, EmitterContext, Service } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateTests } from '../../src/rust/tests.js';

const baseSpec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: '',
  services: [],
  models: [],
  enums: [],
  sdk: defaultSdkBehavior(),
};

const baseCtx: EmitterContext = {
  namespace: 'workos',
  namespacePascal: 'WorkOS',
  spec: baseSpec,
};

/**
 * Build an emitter context with the given services and inject a minimal
 * `resolvedOperations` table so the tests generator can group by mount.
 */
function ctxWithResolved(
  services: Service[],
  models: ApiSpec['models'] = [],
  enums: ApiSpec['enums'] = [],
): EmitterContext {
  const spec: ApiSpec = { ...baseSpec, services, models, enums };
  return {
    ...baseCtx,
    spec,
    resolvedOperations: services.flatMap((service) =>
      service.operations.map((operation) => ({
        service,
        operation,
        methodName: operation.name,
        mountOn: service.name,
        defaults: {},
        inferFromClient: [],
        urlBuilder: false,
      })),
    ),
  };
}

/** Convenience: locate the `tests/<accessor>_test.rs` file produced for one mount. */
function getMountTestFile(files: ReturnType<typeof generateTests>, accessor: string): string {
  const f = files.find((x) => x.path === `tests/${accessor}_test.rs`);
  if (!f) throw new Error(`expected tests/${accessor}_test.rs in generated files`);
  return f.content;
}

describe('rust/tests', () => {
  it('emits the common test client with max_retries(0)', () => {
    const services: Service[] = [];
    const files = generateTests(baseSpec, ctxWithResolved(services));
    const common = files.find((f) => f.path === 'tests/common/mod.rs');
    expect(common).toBeDefined();
    expect(common!.content).toContain('pub async fn test_client(server: &MockServer) -> Client {');
    expect(common!.content).toContain('.max_retries(0)');
  });

  it('emits a round-trip plus four standard error tests for a GET operation', () => {
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
    const files = generateTests(
      { ...baseSpec, services },
      ctxWithResolved(services, [
        {
          name: 'Organization',
          fields: [
            {
              name: 'id',
              type: { kind: 'primitive', type: 'string' },
              required: true,
            },
          ],
        },
      ]),
    );
    const content = getMountTestFile(files, 'organizations');
    // Round-trip is preserved.
    expect(content).toContain('async fn organizations_get_organization_round_trip()');
    // Standard error tests are emitted.
    expect(content).toContain('async fn organizations_get_organization_unauthorized()');
    expect(content).toContain('async fn organizations_get_organization_not_found()');
    expect(content).toContain('async fn organizations_get_organization_rate_limited()');
    expect(content).toContain('async fn organizations_get_organization_server_error()');
    // GET ops don't get write-only error tests.
    expect(content).not.toContain('async fn organizations_get_organization_bad_request()');
    expect(content).not.toContain('async fn organizations_get_organization_unprocessable()');
    // Error asserts go through Error::Api.
    expect(content).toContain('Error::Api(api) => api.as_ref()');
    expect(content).toContain('assert_eq!(api.status, 401);');
  });

  it('adds bad_request and unprocessable tests for write methods', () => {
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
            requestBody: { kind: 'model', name: 'OrganizationInput' },
            response: { kind: 'model', name: 'Organization' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];
    const files = generateTests(
      { ...baseSpec, services },
      ctxWithResolved(services, [
        {
          name: 'Organization',
          fields: [
            {
              name: 'id',
              type: { kind: 'primitive', type: 'string' },
              required: true,
            },
          ],
        },
        {
          name: 'OrganizationInput',
          fields: [
            {
              name: 'name',
              type: { kind: 'primitive', type: 'string' },
              required: true,
            },
          ],
        },
      ]),
    );
    const content = getMountTestFile(files, 'organizations');
    expect(content).toContain('async fn organizations_create_organization_bad_request()');
    expect(content).toContain('async fn organizations_create_organization_unprocessable()');
    // The bad_request body sets `code = validation_error` and the test asserts it.
    expect(content).toContain('"code\\":\\"validation_error\\"');
    expect(content).toContain('assert_eq!(api.code.as_deref(), Some("validation_error"));');
  });

  it('emits Retry-After assertion on the rate_limited test', () => {
    const services: Service[] = [
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
            response: { kind: 'model', name: 'EventList' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];
    const files = generateTests(
      { ...baseSpec, services },
      ctxWithResolved(services, [
        {
          name: 'EventList',
          fields: [
            {
              name: 'data',
              type: {
                kind: 'array',
                items: { kind: 'primitive', type: 'string' },
              },
              required: true,
            },
          ],
        },
      ]),
    );
    const content = getMountTestFile(files, 'events');
    expect(content).toContain('async fn events_list_events_rate_limited()');
    expect(content).toContain('"retry-after"');
    expect(content).toContain('assert_eq!(api.retry_after, Some(std::time::Duration::from_secs(1)));');
  });

  it('emits an empty_page test for cursor-paginated list ops returning a wrapper model', () => {
    const services: Service[] = [
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
    const files = generateTests(
      { ...baseSpec, services },
      ctxWithResolved(services, [
        {
          name: 'OrganizationList',
          fields: [
            {
              name: 'data',
              type: {
                kind: 'array',
                items: { kind: 'model', name: 'Organization' },
              },
              required: true,
            },
          ],
        },
      ]),
    );
    const content = getMountTestFile(files, 'organizations');
    expect(content).toContain('async fn organizations_list_organizations_empty_page()');
    // The body literal is JSON-escaped in the generated Rust source.
    expect(content).toContain('\\"object\\":\\"list\\"');
    expect(content).toContain('resp.data.is_empty()');
  });

  it('emits an empty_page test using a bare [] body for Vec<T> paginated responses', () => {
    const services: Service[] = [
      {
        name: 'AuditLogs',
        operations: [
          {
            name: 'listActions',
            httpMethod: 'get',
            path: '/audit_logs/actions',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            response: {
              kind: 'array',
              items: { kind: 'model', name: 'AuditLogAction' },
            },
            errors: [],
            injectIdempotencyKey: false,
            pagination: {
              strategy: 'cursor',
              param: 'after',
              itemType: { kind: 'model', name: 'AuditLogAction' },
            },
          },
        ],
      },
    ];
    const files = generateTests({ ...baseSpec, services }, ctxWithResolved(services, []));
    const content = getMountTestFile(files, 'audit_logs');
    expect(content).toContain('async fn audit_logs_list_actions_empty_page()');
    // Bare array shape, asserted via `resp.is_empty()`.
    expect(content).toContain('"[]"');
    expect(content).toContain('resp.is_empty()');
  });

  it('skips error tests for URL-builder ops (no HTTP call)', () => {
    const services: Service[] = [
      {
        name: 'Sso',
        operations: [
          {
            name: 'getAuthorizationUrl',
            httpMethod: 'get',
            path: '/sso/authorize',
            pathParams: [],
            queryParams: [
              {
                name: 'redirect_uri',
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
    const ctx: EmitterContext = {
      ...baseCtx,
      spec: { ...baseSpec, services },
      resolvedOperations: services.flatMap((service) =>
        service.operations.map((operation) => ({
          service,
          operation,
          methodName: operation.name,
          mountOn: service.name,
          defaults: {},
          inferFromClient: [],
          urlBuilder: true,
        })),
      ),
    };
    const files = generateTests({ ...baseSpec, services }, ctx);
    const content = getMountTestFile(files, 'sso');
    expect(content).toContain('async fn sso_get_authorization_url_round_trip()');
    // URL-builder ops do not emit error tests — there is no HTTP call to mock.
    expect(content).not.toContain('async fn sso_get_authorization_url_unauthorized()');
    expect(content).not.toContain('async fn sso_get_authorization_url_not_found()');
  });

  it('emits an encodes_query_params test for ops with Vec<String> query params', () => {
    const services: Service[] = [
      {
        name: 'Events',
        operations: [
          {
            name: 'listEvents',
            httpMethod: 'get',
            path: '/events',
            pathParams: [],
            queryParams: [
              {
                name: 'events',
                type: {
                  kind: 'array',
                  items: { kind: 'primitive', type: 'string' },
                },
                required: false,
                explode: false,
              },
            ],
            headerParams: [],
            response: { kind: 'model', name: 'EventList' },
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
    const files = generateTests(
      { ...baseSpec, services },
      ctxWithResolved(services, [
        {
          name: 'EventList',
          fields: [
            {
              name: 'data',
              type: {
                kind: 'array',
                items: { kind: 'model', name: 'EventSchema' },
              },
              required: true,
            },
          ],
        },
      ]),
    );
    const content = getMountTestFile(files, 'events');
    expect(content).toContain('async fn events_list_events_encodes_query_params()');
    // explode=false → comma-joined (URL-encoded as %2C).
    expect(content).toContain('events=foo%2Cbar');
    // The test inspects the request via wiremock's received_requests().
    expect(content).toContain('server.received_requests().await');
  });

  it('emits explode=true repeated-key encoding when explode is unset', () => {
    const services: Service[] = [
      {
        name: 'Things',
        operations: [
          {
            name: 'listThings',
            httpMethod: 'get',
            path: '/things',
            pathParams: [],
            queryParams: [
              {
                name: 'tags',
                type: {
                  kind: 'array',
                  items: { kind: 'primitive', type: 'string' },
                },
                required: false,
                // explode left undefined → defaults to true for form-style arrays.
              },
            ],
            headerParams: [],
            response: { kind: 'model', name: 'Thing' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];
    const files = generateTests(
      { ...baseSpec, services },
      ctxWithResolved(services, [
        {
          name: 'Thing',
          fields: [
            {
              name: 'id',
              type: { kind: 'primitive', type: 'string' },
              required: true,
            },
          ],
        },
      ]),
    );
    const content = getMountTestFile(files, 'things');
    expect(content).toContain('async fn things_list_things_encodes_query_params()');
    expect(content).toContain('tags=foo&tags=bar');
  });

  it('does not wrap a required Vec<String> query param in Some()', () => {
    const services: Service[] = [
      {
        name: 'Events',
        operations: [
          {
            name: 'listEvents',
            httpMethod: 'get',
            path: '/events',
            pathParams: [],
            queryParams: [
              {
                name: 'events',
                type: {
                  kind: 'array',
                  items: { kind: 'primitive', type: 'string' },
                },
                required: true,
                explode: false,
              },
            ],
            headerParams: [],
            response: { kind: 'model', name: 'EventList' },
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
    const files = generateTests(
      { ...baseSpec, services },
      ctxWithResolved(services, [
        {
          name: 'EventList',
          fields: [
            {
              name: 'data',
              type: {
                kind: 'array',
                items: { kind: 'model', name: 'EventSchema' },
              },
              required: true,
            },
          ],
        },
      ]),
    );
    const content = getMountTestFile(files, 'events');
    expect(content).toContain('async fn events_list_events_encodes_query_params()');
    // A required param is `Vec<String>`, not `Option<Vec<String>>`, so the
    // generated fixture must not wrap it in `Some(...)` (which would be E0308).
    expect(content).not.toContain('Some(vec!["foo".to_string(), "bar".to_string()])');
    expect(content).toContain('vec!["foo".to_string(), "bar".to_string()]');
  });

  it('skips encodes_query_params for ops with no Vec<String> query params', () => {
    const services: Service[] = [
      {
        name: 'Things',
        operations: [
          {
            name: 'listThings',
            httpMethod: 'get',
            path: '/things',
            pathParams: [],
            queryParams: [
              {
                name: 'limit',
                type: { kind: 'primitive', type: 'integer' },
                required: false,
              },
            ],
            headerParams: [],
            response: { kind: 'model', name: 'Thing' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];
    const files = generateTests(
      { ...baseSpec, services },
      ctxWithResolved(services, [
        {
          name: 'Thing',
          fields: [
            {
              name: 'id',
              type: { kind: 'primitive', type: 'string' },
              required: true,
            },
          ],
        },
      ]),
    );
    const content = getMountTestFile(files, 'things');
    expect(content).not.toContain('encodes_query_params');
  });

  it('wraps optional parameter-group members in Some(..) in the variant fixture', () => {
    const services: Service[] = [
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
                    name: 'hashed',
                    parameters: [
                      {
                        name: 'password_hash',
                        type: { kind: 'primitive', type: 'string' },
                        required: false,
                      },
                      {
                        name: 'password_salt_position',
                        type: { kind: 'primitive', type: 'string' },
                        required: false,
                      },
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
    const files = generateTests(
      { ...baseSpec, services },
      ctxWithResolved(services, [
        { name: 'User', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
        {
          name: 'CreateUserRequest',
          fields: [
            { name: 'email', type: { kind: 'primitive', type: 'string' }, required: true },
            { name: 'password_hash', type: { kind: 'primitive', type: 'string' }, required: false },
            { name: 'password_salt_position', type: { kind: 'primitive', type: 'string' }, required: false },
          ],
        },
      ]),
    );
    const content = getMountTestFile(files, 'user_management');
    // The variant's optional member is `Option<String>` in the generated enum,
    // so the fixture literal has to wrap its stub; the required member stays
    // bare. Every member gets a value, keeping the literal exhaustive.
    expect(content).toContain(
      'workos::user_management::Password::Hashed { password_hash: "stub_password_hash".to_string(), password_salt_position: Some("stub_password_salt_position".to_string()) }',
    );
  });

  describe('minimal scoped generation', () => {
    const svc = (name: string): Service => ({
      name,
      operations: [
        {
          name: `list${name}`,
          httpMethod: 'get',
          path: `/${name.toLowerCase()}`,
          pathParams: [],
          queryParams: [],
          headerParams: [],
          response: { kind: 'model', name: `${name}Item` },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    });

    it('emits per-service test files ONLY for the selected mount, leaving siblings untouched', () => {
      const pipes = svc('Pipes');
      const radar = svc('Radar');
      const models: ApiSpec['models'] = [
        { name: 'PipesItem', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
        { name: 'RadarItem', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
      ];
      const scopedCtx: EmitterContext = {
        ...ctxWithResolved([pipes, radar], models),
        scopedServices: new Set(['Pipes']),
        scopedModelNames: new Set(['PipesItem']),
      };
      const files = generateTests({ ...baseSpec, services: [pipes, radar], models }, scopedCtx);
      const paths = files.map((f) => f.path);
      // Selected service's mount test file is emitted; the sibling's is not.
      expect(paths).toContain('tests/pipes_test.rs');
      expect(paths).not.toContain('tests/radar_test.rs');
    });

    it('has NO monolithic all-models round-trip file — round-trips are per-op inside per-service files', () => {
      const pipes = svc('Pipes');
      const radar = svc('Radar');
      const models: ApiSpec['models'] = [
        { name: 'PipesItem', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
        { name: 'RadarItem', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
      ];
      const scopedCtx: EmitterContext = {
        ...ctxWithResolved([pipes, radar], models),
        scopedServices: new Set(['Pipes']),
        scopedModelNames: new Set(['PipesItem']),
      };
      const files = generateTests({ ...baseSpec, services: [pipes, radar], models }, scopedCtx);
      // The only *_test.rs files are the per-service mount tests (here: pipes).
      // No aggregate model_round_trip / all-models test file exists to gate.
      const testFiles = files.filter((f) => f.path.endsWith('_test.rs')).map((f) => f.path);
      expect(testFiles).toEqual(['tests/pipes_test.rs']);
      // The out-of-scope sibling's round-trip must not leak into the emitted file.
      const pipesContent = getMountTestFile(files, 'pipes');
      expect(pipesContent).toContain('async fn pipes_list_pipes_round_trip()');
      expect(pipesContent).not.toContain('radar');
    });
  });
});
