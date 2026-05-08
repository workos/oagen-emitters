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
            pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
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

  it('interpolates path parameters via format!', () => {
    const services: Service[] = [
      {
        name: 'Users',
        operations: [
          {
            name: 'getUser',
            httpMethod: 'get',
            path: '/users/{id}',
            pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
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
    expect(f.content).toContain('let path = format!("/users/{}", id);');
    expect(f.content).toContain('pub async fn get_user(&self, id: &str');
  });
});
