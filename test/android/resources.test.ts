import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Service, Model } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateResources } from '../../src/android/resources.js';

const organizationModel: Model = {
  name: 'Organization',
  fields: [
    { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
    { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
  ],
};

const createBody: Model = {
  name: 'CreateOrganizationOptions',
  fields: [
    { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
    { name: 'domains', type: { kind: 'array', items: { kind: 'primitive', type: 'string' } }, required: false },
  ],
};

function makeCtx(services: Service[], models: Model[] = [organizationModel, createBody]): EmitterContext {
  const spec: ApiSpec = {
    name: 'Test',
    version: '1.0.0',
    baseUrl: 'https://api.example.com',
    services,
    models,
    enums: [],
    sdk: defaultSdkBehavior(),
  };
  return { namespace: 'workos', namespacePascal: 'WorkOS', spec };
}

const organizationsService: Service = {
  name: 'Organizations',
  operations: [
    {
      name: 'create_organization',
      description: 'Creates a new organization.',
      httpMethod: 'post',
      path: '/organizations',
      pathParams: [],
      queryParams: [],
      headerParams: [],
      requestBody: { kind: 'model', name: 'CreateOrganizationOptions' },
      response: { kind: 'model', name: 'Organization' },
      errors: [],
      injectIdempotencyKey: false,
    },
    {
      name: 'get_organization',
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
      name: 'delete_organization',
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
};

describe('android/resources', () => {
  it('generates one resource class per mount group at the Android source path', () => {
    const ctx = makeCtx([organizationsService]);
    const files = generateResources([organizationsService], ctx);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/main/kotlin/com/workos/android/resources/Organizations.kt');
    const content = files[0].content;
    expect(content).toContain('package com.workos.android.resources');
    expect(content).toContain('public class Organizations internal constructor(');
    expect(content).toContain('private val transport: Transport,');
  });

  it('emits suspend functions with flattened body params and a trailing requestOptions', () => {
    const ctx = makeCtx([organizationsService]);
    const content = generateResources([organizationsService], ctx)[0].content;
    expect(content).toContain('public suspend fun create(');
    expect(content).toContain('name: String,');
    // optional body field is nullable with a default so callers can omit it
    expect(content).toContain('domains: List<String>? = null,');
    expect(content).toContain('requestOptions: RequestOptions? = null,');
    expect(content).toContain('val payload = JsonBody()');
    expect(content).toContain('payload.set("name", name)');
    expect(content).toContain('payload.set("domains", domains)');
    expect(content).toContain('method = "POST",');
  });

  it('wraps path params in PathEncoding to prevent path traversal', () => {
    const ctx = makeCtx([organizationsService]);
    const content = generateResources([organizationsService], ctx)[0].content;
    expect(content).toContain('val path = "organizations/${PathEncoding.segment(id)}"');
    expect(content).toContain('import com.workos.android.internal.PathEncoding');
  });

  it('returns Unit (no return type) and calls requestVoid for a bodyless delete', () => {
    const ctx = makeCtx([organizationsService]);
    const content = generateResources([organizationsService], ctx)[0].content;
    expect(content).toContain('transport.requestVoid(');
    expect(content).toContain('method = "DELETE",');
  });

  it('builds a query list and a Page return type for a paginated list operation', () => {
    const listService: Service = {
      name: 'Organizations',
      operations: [
        {
          name: 'list_organizations',
          httpMethod: 'get',
          path: '/organizations',
          pathParams: [],
          queryParams: [
            { name: 'after', type: { kind: 'primitive', type: 'string' }, required: false },
            { name: 'limit', type: { kind: 'primitive', type: 'integer' }, required: false },
          ],
          headerParams: [],
          response: { kind: 'model', name: 'OrganizationList' },
          errors: [],
          injectIdempotencyKey: false,
          pagination: { strategy: 'cursor', param: 'after', itemType: { kind: 'model', name: 'Organization' } },
        },
      ],
    };
    const listModel: Model = {
      name: 'OrganizationList',
      fields: [
        { name: 'data', type: { kind: 'array', items: { kind: 'model', name: 'Organization' } }, required: true },
        { name: 'list_metadata', type: { kind: 'model', name: 'ListMetadata' }, required: true },
      ],
    };
    const ctx = makeCtx([listService], [organizationModel, listModel]);
    const content = generateResources([listService], ctx)[0].content;
    expect(content).toContain('): Page<Organization> {');
    expect(content).toContain('val query = mutableListOf<QueryParam>()');
    expect(content).toContain('after?.let { query.add(QueryParam("after", it)) }');
    // a non-string query value is stringified
    expect(content).toContain('limit?.let { query.add(QueryParam("limit", it.toString())) }');
  });

  it('emits an auto-paging Flow companion for a cursor-paginated operation', () => {
    const listService: Service = {
      name: 'Organizations',
      operations: [
        {
          name: 'list_organizations',
          httpMethod: 'get',
          path: '/organizations',
          pathParams: [],
          queryParams: [{ name: 'after', type: { kind: 'primitive', type: 'string' }, required: false }],
          headerParams: [],
          response: { kind: 'model', name: 'OrganizationList' },
          errors: [],
          injectIdempotencyKey: false,
          pagination: { strategy: 'cursor', param: 'after', itemType: { kind: 'model', name: 'Organization' } },
        },
      ],
    };
    const listModel: Model = {
      name: 'OrganizationList',
      fields: [
        { name: 'data', type: { kind: 'array', items: { kind: 'model', name: 'Organization' } }, required: true },
        { name: 'list_metadata', type: { kind: 'model', name: 'ListMetadata' }, required: true },
      ],
    };
    const ctx = makeCtx([listService], [organizationModel, listModel]);
    const content = generateResources([listService], ctx)[0].content;
    expect(content).toContain('public fun listAutoPaging(');
    expect(content).toContain('): Flow<Organization> =');
    expect(content).toContain('autoPagingFlow { cursor ->');
    expect(content).toContain('after = cursor,');
    expect(content).toContain('import kotlinx.coroutines.flow.Flow');
    // the auto-pager drives the cursor itself, so it is not a caller parameter
    expect(content).not.toMatch(/public fun listAutoPaging\([^)]*after:/s);
  });

  it('suffixes a resource whose name collides with a model type', () => {
    const service: Service = {
      name: 'Organization',
      operations: [
        {
          name: 'get_organization',
          httpMethod: 'get',
          path: '/organizations/{id}',
          pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
          queryParams: [],
          headerParams: [],
          response: { kind: 'model', name: 'Organization' },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    };
    const ctx = makeCtx([service], [organizationModel]);
    const files = generateResources([service], ctx);
    expect(files[0].path).toBe('src/main/kotlin/com/workos/android/resources/OrganizationResource.kt');
    expect(files[0].content).toContain('public class OrganizationResource internal constructor(');
  });

  it('routes a raw model body through setRaw with a named serializer', () => {
    // A field-less model body cannot be flattened, so it is passed whole. The
    // transport takes a JsonBody, so handing the model straight to `body =` would
    // not typecheck — it must go through `setRaw`.
    const rawModel: Model = { name: 'CreateApplicationSecret', fields: [] };
    const rawService: Service = {
      name: 'Connect',
      operations: [
        {
          name: 'create_application_client_secret',
          httpMethod: 'post',
          path: '/connect/applications/{id}/client_secrets',
          pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
          queryParams: [],
          headerParams: [],
          requestBody: { kind: 'model', name: 'CreateApplicationSecret' },
          response: { kind: 'model', name: 'Organization' },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    };
    const ctx = makeCtx([rawService], [organizationModel, rawModel]);
    const content = generateResources([rawService], ctx)[0].content;
    expect(content).toContain('body: CreateApplicationSecret,');
    expect(content).toContain('val payload = JsonBody()');
    expect(content).toContain('payload.setRaw(CreateApplicationSecret.serializer(), body)');
    expect(content).toContain('body = payload,');
    // the local must not shadow the `body` parameter it reads on the next line
    expect(content).not.toContain('val body = JsonBody()');
  });

  it('exposes a non-model raw body as JsonElement, which has no named serializer', () => {
    const rawService: Service = {
      name: 'Connect',
      operations: [
        {
          name: 'push_raw',
          httpMethod: 'post',
          path: '/raw',
          pathParams: [],
          queryParams: [],
          headerParams: [],
          requestBody: { kind: 'map', valueType: { kind: 'primitive', type: 'unknown' } },
          response: { kind: 'model', name: 'Organization' },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    };
    const ctx = makeCtx([rawService], [organizationModel]);
    const content = generateResources([rawService], ctx)[0].content;
    expect(content).toContain('body: JsonElement,');
    expect(content).toContain('payload.setRawJson(body)');
    expect(content).toContain('import kotlinx.serialization.json.JsonElement');
  });

  it('does not let a body field named `body` shadow the JsonBody local', () => {
    const collidingBody: Model = {
      name: 'SendOptions',
      fields: [{ name: 'body', type: { kind: 'primitive', type: 'string' }, required: true }],
    };
    const svc: Service = {
      name: 'Messages',
      operations: [
        {
          name: 'send_message',
          httpMethod: 'post',
          path: '/messages',
          pathParams: [],
          queryParams: [],
          headerParams: [],
          requestBody: { kind: 'model', name: 'SendOptions' },
          response: { kind: 'model', name: 'Organization' },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    };
    const ctx = makeCtx([svc], [organizationModel, collidingBody]);
    const content = generateResources([svc], ctx)[0].content;
    expect(content).toContain('body: String,');
    expect(content).toContain('val payload = JsonBody()');
    expect(content).toContain('payload.set("body", body)');
  });

  it('carries the parent operation description into split-wrapper docs', () => {
    // The variant name alone only restates the method name; dropping the spec
    // description leaves the KDoc saying nothing a reader could not already see.
    const splitService: Service = {
      name: 'Connect',
      operations: [
        {
          name: 'create_application',
          description: 'Create a Connect Application\n\nSupports both OAuth and M2M application types.',
          httpMethod: 'post',
          path: '/connect/applications',
          pathParams: [],
          queryParams: [],
          headerParams: [],
          requestBody: { kind: 'model', name: 'CreateOrganizationOptions' },
          response: { kind: 'model', name: 'Organization' },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    };
    const ctx = makeCtx([splitService], [organizationModel, createBody]);
    const resolved = {
      operation: splitService.operations[0],
      service: splitService,
      methodName: 'create_application',
      mountOn: 'Connect',
      defaults: {},
      inferFromClient: [],
      urlBuilder: false,
      wrappers: [
        {
          name: 'create_oauth_application',
          targetVariant: 'CreateOrganizationOptions',
          defaults: {},
          inferFromClient: [],
          exposedParams: ['name'],
          optionalParams: [],
          responseModelName: 'Organization',
        },
      ],
    };
    const content = generateResources([splitService], { ...ctx, resolvedOperations: [resolved] })[0].content ?? '';
    expect(content).toContain('public suspend fun createOAuthApplication(');
    // the variant line...
    expect(content).toContain('Create oauth application');
    // ...and the spec body beneath it. The spec's own short title is dropped as a
    // duplicate of the variant line.
    expect(content).toContain('Supports both OAuth and M2M application types.');
  });

  it('renders an array query param as a repeated key', () => {
    const service: Service = {
      name: 'Organizations',
      operations: [
        {
          name: 'list_organizations',
          httpMethod: 'get',
          path: '/organizations',
          pathParams: [],
          queryParams: [
            {
              name: 'domains',
              type: { kind: 'array', items: { kind: 'primitive', type: 'string' } },
              required: false,
            },
          ],
          headerParams: [],
          response: { kind: 'model', name: 'Organization' },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    };
    const ctx = makeCtx([service], [organizationModel]);
    const content = generateResources([service], ctx)[0].content;
    expect(content).toContain('domains?.let {');
    expect(content).toContain('for (value in it) {');
    expect(content).toContain('query.add(QueryParam("domains", value))');
  });

  /**
   * `before` must be sent on the first auto-paged request only.
   *
   * `after` and `before` are alternative windows into the list, not filters.
   * Re-sending `before` while `after` advances asks the server for a
   * contradictory range, which can return the same page forever — and
   * `autoPagingFlow` breaks only when `after` is null, so the failure mode is an
   * infinite flow emitting duplicates rather than one bad page. `cursor == null`
   * identifies the first page exactly, so the guard needs no runtime support.
   */
  it('sends the reverse cursor on the first auto-paged request only', () => {
    const service: Service = {
      name: 'Organizations',
      operations: [
        {
          name: 'list_organizations',
          httpMethod: 'get',
          path: '/organizations',
          pathParams: [],
          queryParams: [
            { name: 'before', type: { kind: 'primitive', type: 'string' }, required: false },
            { name: 'after', type: { kind: 'primitive', type: 'string' }, required: false },
            { name: 'limit', type: { kind: 'primitive', type: 'integer' }, required: false },
          ],
          headerParams: [],
          response: { kind: 'model', name: 'OrganizationList' },
          errors: [],
          injectIdempotencyKey: false,
          pagination: { strategy: 'cursor', param: 'after', itemType: { kind: 'model', name: 'Organization' } },
        },
      ],
    };
    const listModel: Model = {
      name: 'OrganizationList',
      fields: [
        { name: 'data', type: { kind: 'array', items: { kind: 'model', name: 'Organization' } }, required: true },
        { name: 'list_metadata', type: { kind: 'model', name: 'ListMetadata' }, required: true },
      ],
    };
    const ctx = makeCtx([service], [organizationModel, listModel]);
    const content = generateResources([service], ctx)[0].content ?? '';

    // the forward cursor is driven by the flow...
    expect(content).toContain('after = cursor');
    // ...and the reverse cursor is dropped once the walk starts.
    expect(content).toContain('before = if (cursor == null) before else null');
    // an unrelated filter is passed through unchanged on every page
    expect(content).toContain('limit = limit');
  });

  /**
   * The `requestOptions` doc must name the overrides `RequestOptions` actually
   * has. It previously claimed a per-request "API key" override — copied from the
   * iOS emitter — which no Kotlin `RequestOptions` field provides, while omitting
   * the retry and base-URL overrides that do exist. A doc promising a capability
   * the type lacks is worse than no doc, and it was replicated onto every
   * generated method, so it is pinned here.
   */
  it('documents requestOptions with the overrides RequestOptions actually provides', () => {
    const service: Service = {
      name: 'Organizations',
      operations: [
        {
          name: 'get_organization',
          httpMethod: 'get',
          path: '/organizations/{id}',
          pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
          queryParams: [],
          headerParams: [],
          response: { kind: 'model', name: 'Organization' },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    };
    const ctx = makeCtx([service], [organizationModel]);
    const content = generateResources([service], ctx)[0].content ?? '';

    for (const override of ['extra headers', 'timeout', 'retries', 'base URL', 'idempotency key']) {
      expect(content).toContain(override);
    }
    expect(content).not.toContain('API key');
  });
});
