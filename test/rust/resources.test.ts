import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Service } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateResources } from '../../src/rust/resources.js';
import { UnionRegistry } from '../../src/rust/type-map.js';

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

/**
 * Build a resolved-operations-aware context. The Rust emitter groups
 * operations by `mountOn`, which the resolver populates; tests that want to
 * exercise the per-resource emitter need to seed those entries themselves.
 */
function ctxWithResolved(services: Service[]): EmitterContext {
  return {
    ...ctx,
    spec: { ...emptySpec, services },
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

describe('rust/resources', () => {
  it('skips services with no operations', () => {
    const services: Service[] = [{ name: 'Empty', operations: [] }];
    const files = generateResources(services, ctxWithResolved(services), new UnionRegistry());
    expect(files.find((f) => f.path.startsWith('src/resources/empty'))).toBeUndefined();
  });

  it('emits a resource struct with async methods', () => {
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
            response: { kind: 'model', name: 'Organization' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];
    const files = generateResources(services, ctxWithResolved(services), new UnionRegistry());
    const f = files.find((x) => x.path === 'src/resources/organizations.rs')!;
    expect(f.content).toContain("pub struct OrganizationsApi<'a> {");
    expect(f.content).toContain("pub(crate) client: &'a Client,");
    expect(f.content).toContain('pub async fn create_organization(');
    expect(f.content).toContain(' -> Result<Organization, Error>');
    expect(f.content).toContain('http::Method::POST');
  });

  it('treats request body as required by default and passes Some(&body)', () => {
    const services: Service[] = [
      {
        name: 'Issues',
        operations: [
          {
            name: 'createIssue',
            httpMethod: 'post',
            path: '/issues',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            requestBody: { kind: 'model', name: 'CreateIssueRequest' },
            response: { kind: 'model', name: 'Issue' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];
    const f = generateResources(services, ctxWithResolved(services), new UnionRegistry()).find(
      (x) => x.path === 'src/resources/issues.rs',
    )!;
    expect(f.content).toContain('pub struct CreateIssueParams {');
    expect(f.content).toContain('pub body: CreateIssueRequest,');
    expect(f.content).not.toContain('pub body: Option<CreateIssueRequest>');
    expect(f.content).toContain('Some(&params.body)');
    // Required body forbids the Default derive.
    expect(f.content).toContain('#[derive(Debug, Clone, Serialize)]');
  });

  it('treats nullable request body as optional and passes params.body.as_ref()', () => {
    const services: Service[] = [
      {
        name: 'Issues',
        operations: [
          {
            name: 'updateIssue',
            httpMethod: 'patch',
            path: '/issues/{id}',
            pathParams: [
              {
                name: 'id',
                type: { kind: 'primitive', type: 'string' },
                required: true,
              },
            ],
            queryParams: [],
            headerParams: [],
            requestBody: {
              kind: 'nullable',
              inner: { kind: 'model', name: 'UpdateIssueRequest' },
            },
            response: { kind: 'model', name: 'Issue' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];
    const f = generateResources(services, ctxWithResolved(services), new UnionRegistry()).find(
      (x) => x.path === 'src/resources/issues.rs',
    )!;
    expect(f.content).toContain('pub body: Option<UpdateIssueRequest>,');
    expect(f.content).toContain('params.body.as_ref()');
    expect(f.content).toContain('#[derive(Debug, Clone, Default, Serialize)]');
  });

  it('renders multi-line operation descriptions as multi-line doc comments', () => {
    const services: Service[] = [
      {
        name: 'Users',
        operations: [
          {
            name: 'listUsers',
            description: 'List all users.\n\nSupports cursor pagination via `after`.',
            httpMethod: 'get',
            path: '/users',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model', name: 'UsersList' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];
    const f = generateResources(services, ctxWithResolved(services), new UnionRegistry()).find(
      (x) => x.path === 'src/resources/users.rs',
    )!;
    expect(f.content).toContain('    /// List all users.');
    expect(f.content).toContain('    ///');
    expect(f.content).toContain('    /// Supports cursor pagination via `after`.');
  });

  it('reads inferFromClient body fields from the runtime client', () => {
    const services: Service[] = [
      {
        name: 'UserManagement',
        operations: [
          {
            name: 'authenticate',
            httpMethod: 'post',
            path: '/user_management/authenticate',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model', name: 'AuthenticateResponse' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];
    const baseCtx = ctxWithResolved(services);
    const ctxWithWrapper: EmitterContext = {
      ...baseCtx,
      resolvedOperations: baseCtx.resolvedOperations!.map((r) => ({
        ...r,
        wrappers: [
          {
            name: 'authenticate_with_code',
            targetVariant: 'AuthorizationCodeSessionAuthenticateRequest',
            defaults: { grant_type: 'authorization_code' },
            inferFromClient: ['client_id', 'client_secret'],
            exposedParams: ['code'],
            optionalParams: [],
            responseModelName: null,
          },
        ],
      })),
    };
    const f = generateResources(services, ctxWithWrapper, new UnionRegistry()).find(
      (x) => x.path === 'src/resources/user_management.rs',
    )!;
    // Inferred fields read from the runtime client, not empty literals.
    expect(f.content).toContain('"client_id": self.client.client_id()');
    expect(f.content).toContain('"client_secret": self.client.api_key()');
    expect(f.content).not.toContain('"client_id": "",');
    expect(f.content).not.toContain('"client_secret": "",');
    // Defaults are still emitted as literal JSON values.
    expect(f.content).toContain('"grant_type": "authorization_code"');
  });

  it('renders spec-level parameter defaults as doc comments', () => {
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
                name: 'limit',
                type: { kind: 'primitive', type: 'integer' },
                required: false,
                description: 'Upper limit.',
                default: 10,
              },
              {
                name: 'order',
                type: { kind: 'enum', name: 'PaginationOrder' },
                required: false,
                description: 'Order the results.',
                default: 'desc',
              },
              {
                name: 'enabled',
                type: { kind: 'primitive', type: 'boolean' },
                required: false,
                default: true,
              },
            ],
            headerParams: [],
            response: { kind: 'model', name: 'EventsList' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];
    const f = generateResources(services, ctxWithResolved(services), new UnionRegistry()).find(
      (x) => x.path === 'src/resources/events.rs',
    )!;
    expect(f.content).toContain('    /// Upper limit.\n    ///\n    /// Defaults to `10`.');
    expect(f.content).toContain('    /// Order the results.\n    ///\n    /// Defaults to `desc`.');
    expect(f.content).toContain('    /// Defaults to `true`.');
  });

  it('interpolates path parameters via format!', () => {
    const services: Service[] = [
      {
        name: 'Users',
        operations: [
          {
            name: 'getUser',
            httpMethod: 'get',
            path: '/users/{id}',
            pathParams: [
              {
                name: 'id',
                type: { kind: 'primitive', type: 'string' },
                required: true,
              },
            ],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model', name: 'User' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];
    const files = generateResources(services, ctxWithResolved(services), new UnionRegistry());
    const f = files.find((x) => x.path === 'src/resources/users.rs')!;
    expect(f.content).toContain('let id = crate::client::path_segment(id);');
    expect(f.content).toContain('let path = format!("/users/{id}");');
    expect(f.content).toContain('pub async fn get_user(&self, id: &str');
  });

  it('emits a URL-builder method when resolved.urlBuilder is true', () => {
    const services: Service[] = [
      {
        name: 'SSO',
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
              {
                name: 'screen_hint',
                type: { kind: 'enum', name: 'UserManagementAuthenticationScreenHint' },
                required: false,
                default: 'sign-in',
              },
              {
                name: 'state',
                type: { kind: 'primitive', type: 'string' },
                required: false,
              },
            ],
            headerParams: [],
            response: { kind: 'model', name: 'SsoAuthorizeUrlResponse' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];
    const baseCtx = ctxWithResolved(services);
    const ctx: EmitterContext = {
      ...baseCtx,
      resolvedOperations: baseCtx.resolvedOperations!.map((r) => ({
        ...r,
        urlBuilder: true,
      })),
    };
    const f = generateResources(services, ctx, new UnionRegistry()).find((x) => x.path === 'src/resources/sso.rs')!;
    // URL builders are sync `pub fn`, return `Result<String, Error>`, and
    // never emit an `_with_options` variant or an HTTP issuer.
    expect(f.content).toContain('pub fn get_authorization_url(');
    expect(f.content).toContain('-> Result<String, Error>');
    expect(f.content).toContain('let qs = crate::query::encode_query');
    expect(f.content).toContain('pub screen_hint: Option<UserManagementAuthenticationScreenHint>,');
    expect(f.content).toContain('screen_hint: Default::default(),');
    expect(f.content).not.toContain('screen_hint: Some(UserManagementAuthenticationScreenHint::SignIn)');
    expect(f.content).not.toContain('get_authorization_url_with_options');
    expect(f.content).not.toContain('request_with_query_opts');
  });

  it('emits a bearer-override token parameter when op.security has a non-bearer scheme', () => {
    const services: Service[] = [
      {
        name: 'SSO',
        operations: [
          {
            name: 'getProfile',
            httpMethod: 'get',
            path: '/sso/profile',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model', name: 'Profile' },
            errors: [],
            injectIdempotencyKey: false,
            security: [{ schemeName: 'access_token', scopes: [] }],
          },
        ],
      },
    ];
    const f = generateResources(services, ctxWithResolved(services), new UnionRegistry()).find(
      (x) => x.path === 'src/resources/sso.rs',
    )!;
    // The method takes `access_token: impl Into<String>` and overrides the
    // Authorization header in-place via a merged RequestOptions clone.
    expect(f.content).toContain('access_token: impl Into<String>');
    expect(f.content).toContain('let access_token: String = access_token.into();');
    expect(f.content).toContain('http::header::AUTHORIZATION');
  });

  it('emits a parameter-group enum and a single flattened field on the params struct', () => {
    const services: Service[] = [
      {
        name: 'Authorization',
        operations: [
          {
            name: 'check',
            httpMethod: 'post',
            path: '/authorization/check',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            requestBody: { kind: 'model', name: 'CheckAuthorization' },
            response: { kind: 'model', name: 'AuthorizationCheck' },
            errors: [],
            injectIdempotencyKey: false,
            parameterGroups: [
              {
                name: 'resource_target',
                optional: false,
                variants: [
                  {
                    name: 'by_id',
                    parameters: [
                      {
                        name: 'resource_id',
                        type: { kind: 'primitive', type: 'string' },
                        required: false,
                      },
                    ],
                  },
                  {
                    name: 'by_external_id',
                    parameters: [
                      {
                        name: 'resource_external_id',
                        type: { kind: 'primitive', type: 'string' },
                        required: false,
                      },
                      {
                        name: 'resource_type_slug',
                        type: { kind: 'primitive', type: 'string' },
                        required: false,
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
    const baseCtx = ctxWithResolved(services);
    const ctx: EmitterContext = {
      ...baseCtx,
      spec: {
        ...baseCtx.spec,
        models: [
          {
            name: 'CheckAuthorization',
            fields: [
              {
                name: 'permission_slug',
                type: { kind: 'primitive', type: 'string' },
                required: true,
              },
              {
                name: 'resource_id',
                type: { kind: 'primitive', type: 'string' },
                required: false,
              },
              {
                name: 'resource_external_id',
                type: { kind: 'primitive', type: 'string' },
                required: false,
              },
              {
                name: 'resource_type_slug',
                type: { kind: 'primitive', type: 'string' },
                required: false,
              },
            ],
          },
        ],
      },
    };
    const f = generateResources(services, ctx, new UnionRegistry()).find(
      (x) => x.path === 'src/resources/authorization.rs',
    )!;
    // Enum is generated with untagged variants whose fields flatten cleanly.
    expect(f.content).toContain('pub enum ResourceTarget {');
    expect(f.content).toContain('#[serde(untagged)]');
    expect(f.content).toContain('ById {');
    expect(f.content).toContain('resource_id: String,');
    expect(f.content).toContain('ByExternalId {');
    // The synthetic body keeps non-grouped fields flat and folds the enum
    // in via `serde(flatten)`.
    expect(f.content).toContain('pub struct CheckParamsBody {');
    expect(f.content).toContain('pub permission_slug: String,');
    expect(f.content).toContain('#[serde(flatten)]\n    pub resource_target: ResourceTarget,');
    // The params struct's `body` field points at the synthetic type, not the
    // original model.
    expect(f.content).toContain('pub body: CheckParamsBody,');
  });

  it('drives auto-paging from op.pagination and uses the IR cursor param name', () => {
    const services: Service[] = [
      {
        name: 'Widgets',
        operations: [
          {
            name: 'listWidgets',
            httpMethod: 'get',
            path: '/widgets',
            pathParams: [],
            queryParams: [
              {
                name: 'before',
                type: { kind: 'primitive', type: 'string' },
                required: false,
              },
              {
                name: 'after',
                type: { kind: 'primitive', type: 'string' },
                required: false,
              },
              {
                name: 'limit',
                type: { kind: 'primitive', type: 'integer' },
                required: false,
              },
            ],
            headerParams: [],
            response: { kind: 'model', name: 'WidgetList' },
            errors: [],
            injectIdempotencyKey: false,
            pagination: {
              strategy: 'cursor',
              param: 'before',
              itemType: { kind: 'model', name: 'WidgetList' },
            },
          },
        ],
      },
    ];
    const baseCtx = ctxWithResolved(services);
    const ctx: EmitterContext = {
      ...baseCtx,
      spec: {
        ...baseCtx.spec,
        models: [
          {
            name: 'WidgetList',
            fields: [
              {
                name: 'data',
                type: {
                  kind: 'array',
                  items: { kind: 'model', name: 'Widget' },
                },
                required: true,
              },
              {
                name: 'list_metadata',
                type: { kind: 'model', name: 'WidgetListListMetadata' },
                required: true,
              },
            ],
          },
          {
            name: 'WidgetListListMetadata',
            fields: [
              {
                name: 'before',
                type: { kind: 'primitive', type: 'string' },
                required: false,
              },
              {
                name: 'after',
                type: { kind: 'primitive', type: 'string' },
                required: false,
              },
            ],
          },
          { name: 'Widget', fields: [] },
        ],
      },
    };
    const f = generateResources(services, ctx, new UnionRegistry()).find((x) => x.path === 'src/resources/widgets.rs')!;
    // The IR's cursor param wins over the old hardcoded `after` — both the
    // params side and the list-metadata side reference `before`.
    expect(f.content).toContain('list_widgets_auto_paging');
    expect(f.content).toContain('params.before = after;');
    expect(f.content).toContain('page.list_metadata.before');
  });

  it('skips auto-paging when the IR cursor field is missing from the response metadata', () => {
    // If the spec/IR is internally inconsistent (request says cursor is
    // `weird_cursor` but the list-metadata model has no such field) we'd emit
    // code that references a nonexistent field. Bail out instead — callers
    // can paginate manually.
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
                name: 'weird_cursor',
                type: { kind: 'primitive', type: 'string' },
                required: false,
              },
            ],
            headerParams: [],
            response: { kind: 'model', name: 'EventList' },
            errors: [],
            injectIdempotencyKey: false,
            pagination: {
              strategy: 'cursor',
              param: 'weird_cursor',
              itemType: { kind: 'model', name: 'EventList' },
            },
          },
        ],
      },
    ];
    const baseCtx = ctxWithResolved(services);
    const ctx: EmitterContext = {
      ...baseCtx,
      spec: {
        ...baseCtx.spec,
        models: [
          {
            name: 'EventList',
            fields: [
              {
                name: 'data',
                type: {
                  kind: 'array',
                  items: { kind: 'model', name: 'Event' },
                },
                required: true,
              },
              {
                name: 'list_metadata',
                type: { kind: 'model', name: 'EventListListMetadata' },
                required: true,
              },
            ],
          },
          {
            name: 'EventListListMetadata',
            fields: [
              {
                name: 'after',
                type: { kind: 'primitive', type: 'string' },
                required: false,
              },
            ],
          },
          { name: 'Event', fields: [] },
        ],
      },
    };
    const f = generateResources(services, ctx, new UnionRegistry()).find((x) => x.path === 'src/resources/events.rs')!;
    expect(f.content).not.toContain('list_events_auto_paging');
  });

  it('adds serialize_with attribute on Vec query params with explode=false', () => {
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
                style: 'form',
                explode: false,
              },
              {
                name: 'tags',
                type: {
                  kind: 'array',
                  items: { kind: 'primitive', type: 'string' },
                },
                required: false,
                style: 'form',
                explode: true,
              },
            ],
            headerParams: [],
            response: { kind: 'model', name: 'EventList' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];
    const f = generateResources(services, ctxWithResolved(services), new UnionRegistry()).find(
      (x) => x.path === 'src/resources/events.rs',
    )!;
    // explode=false → comma-joined serializer; explode=true (default) leaves
    // the field alone so the runtime query encoder unrolls it to repeated keys.
    expect(f.content).toContain(
      '#[serde(serialize_with = "crate::query::serialize_comma_separated_opt")]\n    pub events:',
    );
    expect(f.content).not.toContain('"crate::query::serialize_comma_separated_opt")]\n    pub tags:');
  });

  it('iterates cookieParams alongside path/query/header params', () => {
    // Forward-compatibility: ensure the iteration site picks up cookie
    // params so a future spec doesn't silently drop them.
    const services: Service[] = [
      {
        name: 'Widgets',
        operations: [
          {
            name: 'getWidget',
            httpMethod: 'get',
            path: '/widgets/{id}',
            pathParams: [
              {
                name: 'id',
                type: { kind: 'primitive', type: 'string' },
                required: true,
              },
            ],
            queryParams: [],
            headerParams: [],
            cookieParams: [
              {
                name: 'session_id',
                type: { kind: 'primitive', type: 'string' },
                required: false,
                description: 'Tracking cookie.',
              },
            ],
            response: { kind: 'model', name: 'Widget' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];
    const f = generateResources(services, ctxWithResolved(services), new UnionRegistry()).find(
      (x) => x.path === 'src/resources/widgets.rs',
    )!;
    expect(f.content).toContain('pub session_id: Option<String>,');
  });
});
