import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Service, Operation, Model, ResolvedOperation } from '@workos/oagen';
import { defaultSdkBehavior, toSnakeCase, toPascalCase } from '@workos/oagen';
import { generateResources } from '../../src/ruby/resources.js';

function makeSpec(services: Service[], models: Model[] = []): ApiSpec {
  return {
    name: 'Test',
    version: '1.0.0',
    baseUrl: '',
    services,
    models,
    enums: [],
    sdk: defaultSdkBehavior(),
  };
}

/** Build resolvedOperations from services so groupByMount works. */
function buildResolvedOps(services: Service[]): ResolvedOperation[] {
  const ops: ResolvedOperation[] = [];
  for (const service of services) {
    const mountOn = toPascalCase(service.name);
    for (const op of service.operations) {
      ops.push({
        operation: op,
        service,
        methodName: toSnakeCase(op.name),
        mountOn,
        defaults: {},
        inferFromClient: [],
        urlBuilder: false,
      });
    }
  }
  return ops;
}

function makeCtx(spec: ApiSpec): EmitterContext {
  return {
    namespace: 'workos',
    namespacePascal: 'WorkOS',
    spec,
    resolvedOperations: buildResolvedOps(spec.services),
  };
}

function makeOp(overrides: Partial<Operation>): Operation {
  return {
    name: 'listOrganizations',
    httpMethod: 'get',
    path: '/organizations',
    pathParams: [],
    queryParams: [],
    headerParams: [],
    requestBody: undefined,
    response: { kind: 'model', name: 'Organization' },
    errors: [],
    injectIdempotencyKey: false,
    ...overrides,
  };
}

describe('ruby/resources', () => {
  it('returns empty for no services', () => {
    const spec = makeSpec([]);
    expect(generateResources([], makeCtx(spec))).toEqual([]);
  });

  // ── P0-1: request_options forwarding ────────────────────────────────────

  it('forwards request_options to the unified request helper', () => {
    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [
          makeOp({
            name: 'getOrganization',
            httpMethod: 'get',
            path: '/organizations/{id}',
            pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
          }),
        ],
      },
    ];
    const spec = makeSpec(services);
    const files = generateResources(services, makeCtx(spec));
    const content = files[0].content;

    // Uses the unified @client.request helper
    expect(content).toContain('@client.request(');
    expect(content).toContain('method: :get');
    expect(content).toContain('request_options: request_options');
    // Should NOT use the two-layer execute_request(X_request(...)) pattern
    expect(content).not.toContain('execute_request(');
    expect(content).not.toContain('get_request(');
  });

  it('forwards request_options in POST methods', () => {
    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [
          makeOp({
            name: 'createOrganization',
            httpMethod: 'post',
            path: '/organizations',
            requestBody: { kind: 'model', name: 'CreateOrganizationRequest' },
          }),
        ],
      },
    ];
    const spec = makeSpec(services, [
      {
        name: 'CreateOrganizationRequest',
        fields: [{ name: 'name', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ]);
    const files = generateResources(services, makeCtx(spec));
    const content = files[0].content;

    expect(content).toContain('@client.request(');
    expect(content).toContain('method: :post');
    expect(content).toContain('body: body');
    expect(content).toContain('request_options: request_options');
  });

  // ── P0-2: pagination cursor direction ──────────────────────────────────

  it('uses after cursor for fetch_next lambda (not before)', () => {
    const listModel: Model = {
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
    };
    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [
          makeOp({
            name: 'listOrganizations',
            httpMethod: 'get',
            path: '/organizations',
            queryParams: [
              { name: 'before', type: { kind: 'primitive', type: 'string' }, required: false },
              { name: 'after', type: { kind: 'primitive', type: 'string' }, required: false },
              { name: 'limit', type: { kind: 'primitive', type: 'integer' }, required: false },
            ],
            response: { kind: 'model', name: 'OrganizationList' },
            pagination: {
              strategy: 'cursor',
              param: 'before',
              dataPath: 'data',
              itemType: { kind: 'model', name: 'Organization' },
            },
          }),
        ],
      },
    ];
    const spec = makeSpec(services, [
      listModel,
      {
        name: 'ListMetadata',
        fields: [
          { name: 'before', type: { kind: 'nullable', inner: { kind: 'primitive', type: 'string' } }, required: false },
          { name: 'after', type: { kind: 'nullable', inner: { kind: 'primitive', type: 'string' } }, required: false },
        ],
      },
    ]);
    const files = generateResources(services, makeCtx(spec));
    const content = files[0].content;

    // fetch_next lambda receives cursor string; the recursive call passes after: cursor
    expect(content).toContain('after: cursor');
    // Must NOT pass before: cursor in the recursive call
    expect(content).not.toMatch(/before: cursor/);
    // Should use ListStruct.from_response
    expect(content).toContain('ListStruct.from_response(');
  });

  // ── P0-3: paginated response shape detection ──────────────────────────

  it('generates ListStruct for paginated endpoints with array response type', () => {
    const services: Service[] = [
      {
        name: 'UserManagement',
        operations: [
          makeOp({
            name: 'listSessions',
            httpMethod: 'get',
            path: '/user_management/users/{id}/sessions',
            pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
            queryParams: [
              { name: 'before', type: { kind: 'primitive', type: 'string' }, required: false },
              { name: 'after', type: { kind: 'primitive', type: 'string' }, required: false },
              { name: 'limit', type: { kind: 'primitive', type: 'integer' }, required: false },
            ],
            // Response is typed as array in IR, but endpoint is actually paginated
            response: { kind: 'array', items: { kind: 'model', name: 'Session' } },
            pagination: {
              strategy: 'cursor',
              param: 'after',
              dataPath: 'data',
              itemType: { kind: 'model', name: 'Session' },
            },
          }),
        ],
      },
    ];
    const spec = makeSpec(services);
    const files = generateResources(services, makeCtx(spec));
    const content = files[0].content;

    // Should generate ListStruct.from_response, not bare array mapping
    expect(content).toContain('ListStruct.from_response(');
    // Should NOT be treating response as bare array
    expect(content).not.toContain('(parsed || []).map');
  });

  it('preserves bare array handling for non-paginated array endpoints', () => {
    const services: Service[] = [
      {
        name: 'UserManagement',
        operations: [
          makeOp({
            name: 'getUserIdentities',
            httpMethod: 'get',
            path: '/user_management/users/{id}/identities',
            pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
            // Array response, no pagination
            response: { kind: 'array', items: { kind: 'model', name: 'Identity' } },
          }),
        ],
      },
    ];
    const spec = makeSpec(services, [
      { name: 'Identity', fields: [{ name: 'type', type: { kind: 'primitive', type: 'string' }, required: true }] },
    ]);
    const files = generateResources(services, makeCtx(spec));
    const content = files[0].content;

    // Should be bare array mapping (no pagination)
    expect(content).toContain('(parsed || []).map');
    expect(content).not.toContain('ListStruct');
  });

  // ── P0-4: DELETE with body ─────────────────────────────────────────────

  it('generates body for DELETE endpoints with requestBody', () => {
    const services: Service[] = [
      {
        name: 'Authorization',
        operations: [
          makeOp({
            name: 'removeRole',
            httpMethod: 'delete',
            path: '/authorization/memberships/{id}/role_assignments',
            pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
            requestBody: { kind: 'model', name: 'RemoveRoleRequest' },
            response: { kind: 'primitive', type: 'unknown' },
          }),
        ],
      },
    ];
    const spec = makeSpec(services, [
      {
        name: 'RemoveRoleRequest',
        fields: [
          { name: 'role_slug', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'resource_id', type: { kind: 'primitive', type: 'string' }, required: false },
        ],
      },
    ]);
    const files = generateResources(services, makeCtx(spec));
    const content = files[0].content;

    // Should construct a body hash
    expect(content).toContain('body = {');
    expect(content).toContain("'role_slug' => role_slug");
    // Should pass body to the request helper
    expect(content).toContain('@client.request(');
    expect(content).toContain('body: body');
  });

  it('does not generate body for DELETE without requestBody', () => {
    const services: Service[] = [
      {
        name: 'Items',
        operations: [
          makeOp({
            name: 'deleteItem',
            httpMethod: 'delete',
            path: '/items/{id}',
            pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
            response: { kind: 'primitive', type: 'unknown' },
          }),
        ],
      },
    ];
    const spec = makeSpec(services);
    const files = generateResources(services, makeCtx(spec));
    const content = files[0].content;

    // No body construction
    expect(content).not.toContain('body = {');
    expect(content).toContain('method: :delete');
  });

  // ── P0-5: path/body parameter name collision ───────────────────────────

  it('disambiguates colliding path and body parameter names', () => {
    const services: Service[] = [
      {
        name: 'Authorization',
        operations: [
          makeOp({
            name: 'createRolePermission',
            httpMethod: 'post',
            path: '/authorization/roles/{slug}/permissions',
            pathParams: [{ name: 'slug', type: { kind: 'primitive', type: 'string' }, required: true }],
            requestBody: { kind: 'model', name: 'CreateRolePermissionRequest' },
          }),
        ],
      },
    ];
    const spec = makeSpec(services, [
      {
        name: 'CreateRolePermissionRequest',
        fields: [{ name: 'slug', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ]);
    const files = generateResources(services, makeCtx(spec));
    const content = files[0].content;

    // Should have both slug: (path) and body_slug: (body) in signature
    expect(content).toContain('slug:');
    expect(content).toContain('body_slug:');

    // Path interpolation uses slug (the path param) with Util.encode_path
    expect(content).toContain('WorkOS::Util.encode_path(slug)');

    // Body hash uses body_slug for the wire name "slug"
    expect(content).toContain("'slug' => body_slug");

    // YARD doc should mention both params
    expect(content).toContain('@param slug');
    expect(content).toContain('@param body_slug');
  });

  it('does not rename body fields that do not collide with path params', () => {
    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [
          makeOp({
            name: 'createOrganization',
            httpMethod: 'post',
            path: '/organizations',
            requestBody: { kind: 'model', name: 'CreateOrganizationRequest' },
          }),
        ],
      },
    ];
    const spec = makeSpec(services, [
      {
        name: 'CreateOrganizationRequest',
        fields: [{ name: 'name', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ]);
    const files = generateResources(services, makeCtx(spec));
    const content = files[0].content;

    // name: should be used directly (no body_ prefix)
    expect(content).toContain('name:');
    expect(content).not.toContain('body_name');
  });
});
