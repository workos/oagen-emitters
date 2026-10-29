import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Service } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateResources } from '../../src/ios/resources.js';
import { buildOperationsMap } from '../../src/ios/manifest.js';

const spec: ApiSpec = {
  name: 'WorkOS',
  version: '1.0.0',
  baseUrl: 'https://api.workos.com',
  services: [
    {
      name: 'Organizations',
      operations: [
        {
          name: 'list_organizations',
          httpMethod: 'get',
          path: '/organizations',
          pathParams: [],
          queryParams: [{ name: 'limit', type: { kind: 'primitive', type: 'integer' }, required: false }],
          headerParams: [],
          response: { kind: 'array', items: { kind: 'model', name: 'Organization' } },
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
          name: 'create_organization',
          httpMethod: 'post',
          path: '/organizations',
          pathParams: [],
          queryParams: [],
          headerParams: [],
          requestBody: { kind: 'model', name: 'CreateOrganizationOptions' },
          response: { kind: 'model', name: 'Organization' },
          errors: [],
          injectIdempotencyKey: true,
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
    },
  ],
  models: [
    { name: 'Organization', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
    {
      name: 'CreateOrganizationOptions',
      fields: [
        { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
        { name: 'domains', type: { kind: 'array', items: { kind: 'primitive', type: 'string' } }, required: false },
      ],
    },
  ],
  enums: [],
  sdk: defaultSdkBehavior(),
};

const ctx: EmitterContext = {
  namespace: 'workos',
  namespacePascal: 'WorkOS',
  spec,
};

describe('ios/resources', () => {
  it('generates a resource struct per mount group', () => {
    const files = generateResources(spec.services, ctx);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('Sources/WorkOS/Resources/Organizations.swift');
    const content = files[0].content;
    expect(content).toContain('public struct Organizations: Sendable {');
    expect(content).toContain('let transport: Transport');
  });

  it('trims the mount resource from method names and emits async throws', () => {
    const content = generateResources(spec.services, ctx)[0].content;
    expect(content).toContain('public func list(');
    expect(content).toContain('public func get(');
    expect(content).toContain('public func create(');
    expect(content).toContain('public func delete(');
    expect(content).toContain(') async throws -> [Organization] {');
    expect(content).toContain(') async throws -> Organization {');
  });

  it('percent-encodes path params and passes required args', () => {
    const content = generateResources(spec.services, ctx)[0].content;
    expect(content).toContain('let path = "organizations/\\(PathEncoding.segment(id))"');
    expect(content).toContain('id: String');
  });

  it('builds a request body from model fields', () => {
    const content = generateResources(spec.services, ctx)[0].content;
    expect(content).toContain('var body = EncodableBody()');
    expect(content).toContain('body.set("name", name)');
    expect(content).toContain('body.set("domains", domains)');
    expect(content).toContain('name: String');
    expect(content).toContain('domains: [String]? = nil');
  });

  it('appends optional query params', () => {
    const content = generateResources(spec.services, ctx)[0].content;
    expect(content).toContain('var query: [URLQueryItem] = []');
    expect(content).toContain('if let limit {');
    expect(content).toContain('query.append(URLQueryItem(name: "limit", value: "\\(limit)"))');
  });

  it('emits a string-valued literal query param without redundant interpolation', () => {
    // A `literal` TypeRef (e.g. the spec's `prompt: "login"` or
    // `code_challenge_method: "S256"`) renders as Swift `String`, so wrapping
    // it in `"\(value)"` is redundant. Mirrors the android-emitter regression
    // for the SSO/UserManagement authorize params.
    const service: Service = {
      name: 'Sso',
      operations: [
        {
          name: 'get_authorization_url',
          httpMethod: 'get',
          path: '/sso/authorize',
          pathParams: [],
          queryParams: [
            { name: 'prompt', type: { kind: 'literal', value: 'login' }, required: false },
            { name: 'code_challenge_method', type: { kind: 'literal', value: 'S256' }, required: false },
          ],
          headerParams: [],
          response: { kind: 'model', name: 'Organization' },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    };
    const literalCtx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec: { ...spec, services: [service] },
    };
    const content = generateResources([service], literalCtx)[0].content;
    expect(content).toContain('query.append(URLQueryItem(name: "prompt", value: prompt))');
    expect(content).toContain('query.append(URLQueryItem(name: "code_challenge_method", value: codeChallengeMethod))');
    expect(content).not.toContain('value: "\\(prompt)"');
    expect(content).not.toContain('value: "\\(codeChallengeMethod)"');
  });

  it('uses requestVoid for delete operations', () => {
    const content = generateResources(spec.services, ctx)[0].content;
    expect(content).toContain('try await transport.requestVoid(');
    expect(content).toContain('method: "DELETE"');
  });

  it('builds an operations manifest with resolved method names', () => {
    const map = buildOperationsMap(spec, ctx);
    expect(map['GET /organizations']).toEqual({ sdkMethod: 'list', service: 'organizations' });
    expect(map['GET /organizations/{id}']).toEqual({ sdkMethod: 'get', service: 'organizations' });
    expect(map['POST /organizations']).toEqual({ sdkMethod: 'create', service: 'organizations' });
    expect(map['DELETE /organizations/{id}']).toEqual({ sdkMethod: 'delete', service: 'organizations' });
  });

  it('emits an auto-paging companion for cursor-paginated operations', () => {
    const paginatedSpec: ApiSpec = {
      ...spec,
      services: [
        {
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
              pagination: {
                strategy: 'cursor',
                param: 'after',
                limitParam: 'limit',
                itemType: { kind: 'model', name: 'Organization' },
              },
              errors: [],
              injectIdempotencyKey: false,
            },
          ],
        },
      ],
    };
    const content = generateResources(paginatedSpec.services, { ...ctx, spec: paginatedSpec })[0].content;
    expect(content).toContain('public func listAutoPaging(');
    expect(content).toContain(') -> AutoPagingSequence<Organization> {');
    expect(content).toContain('AutoPagingSequence { cursor in');
    expect(content).toContain('after: cursor');
    // The companion drops the cursor from its own signature.
    expect(content).not.toContain('public func listAutoPaging(\n        after:');
  });
});

// ---------------------------------------------------------------------------
// Signature stability across requiredness changes (issue #240)
// ---------------------------------------------------------------------------

/**
 * `beta` is declared before `alpha` but `alpha` is required, so the old
 * optionality sort hoisted `alpha` ahead of it. Flipping `alpha` to optional
 * then dropped it back behind `beta` — a reorder of Swift's order-sensitive
 * labeled arguments, i.e. a source break, from a purely additive API change.
 */
function orderingSpec(alphaRequired: boolean): ApiSpec {
  const service: Service = {
    name: 'Widgets',
    operations: [
      {
        name: 'list_widgets',
        httpMethod: 'get',
        path: '/widgets/{id}',
        pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
        queryParams: [
          { name: 'beta', type: { kind: 'primitive', type: 'string' }, required: false },
          { name: 'alpha', type: { kind: 'primitive', type: 'string' }, required: alphaRequired },
        ],
        headerParams: [],
        response: { kind: 'array', items: { kind: 'primitive', type: 'string' } },
        errors: [],
        injectIdempotencyKey: false,
      },
    ],
  };
  return { ...spec, services: [service] };
}

/** Parameter labels of the emitted `get` signature, in order. */
function signatureLabels(apiSpec: ApiSpec): string[] {
  const content = generateResources(apiSpec.services, { ...ctx, spec: apiSpec })[0].content;
  const start = content.indexOf('public func get(');
  const body = content.slice(start, content.indexOf(') async throws', start));
  return [...body.matchAll(/^\s{8}(\w+):/gm)].map((m) => m[1]);
}

describe('iOS signature order', () => {
  it('keeps spec order rather than hoisting required params', () => {
    expect(signatureLabels(orderingSpec(true))).toEqual(['id', 'beta', 'alpha', 'requestOptions']);
  });

  it('does not move a parameter when it flips required -> optional', () => {
    expect(signatureLabels(orderingSpec(false))).toEqual(signatureLabels(orderingSpec(true)));
  });
});

describe('ios/resources date-time wire format', () => {
  // oagen-emitters#293: a `Date` interpolated as `"\(rangeStart)"` renders
  // Foundation's description (`2026-10-29 12:34:56 +0000`), which the API
  // rejects. Every date reaching a query item or a path segment goes through
  // the SDK's own ISO 8601 formatter instead.
  const service: Service = {
    name: 'Events',
    operations: [
      {
        name: 'list_events',
        httpMethod: 'get',
        path: '/events',
        pathParams: [],
        queryParams: [
          { name: 'range_start', type: { kind: 'primitive', type: 'string', format: 'date-time' }, required: false },
          { name: 'range_end', type: { kind: 'primitive', type: 'string', format: 'date-time' }, required: true },
          { name: 'on', type: { kind: 'primitive', type: 'string', format: 'date' }, required: false },
          {
            name: 'stamps',
            type: { kind: 'array', items: { kind: 'primitive', type: 'string', format: 'date-time' } },
            required: false,
          },
        ],
        headerParams: [],
        response: { kind: 'array', items: { kind: 'model', name: 'Organization' } },
        errors: [],
        injectIdempotencyKey: false,
      },
      {
        name: 'get_snapshot',
        httpMethod: 'get',
        path: '/snapshots/{at}',
        pathParams: [{ name: 'at', type: { kind: 'primitive', type: 'string', format: 'date-time' }, required: true }],
        queryParams: [],
        headerParams: [],
        response: { kind: 'model', name: 'Organization' },
        errors: [],
        injectIdempotencyKey: false,
      },
    ],
  };
  const dateCtx: EmitterContext = {
    namespace: 'workos',
    namespacePascal: 'WorkOS',
    spec: { ...spec, services: [service] },
  };
  const content = generateResources([service], dateCtx)[0].content;

  it('renders date-time query params through Coding.iso8601Fractional', () => {
    expect(content).toContain(
      'query.append(URLQueryItem(name: "range_start", value: Coding.iso8601Fractional.string(from: rangeStart)))',
    );
    expect(content).toContain(
      'query.append(URLQueryItem(name: "range_end", value: Coding.iso8601Fractional.string(from: rangeEnd)))',
    );
    expect(content).toContain(
      'query.append(URLQueryItem(name: "stamps", value: Coding.iso8601Fractional.string(from: value)))',
    );
    expect(content).not.toContain('value: "\\(rangeStart)"');
    expect(content).not.toContain('value: "\\(rangeEnd)"');
  });

  it('renders date query params through Coding.dateOnly', () => {
    expect(content).toContain('query.append(URLQueryItem(name: "on", value: Coding.dateOnly.string(from: on)))');
  });

  it('renders a date-time path segment through the formatter before percent-encoding it', () => {
    expect(content).toContain(
      'let path = "snapshots/\\(PathEncoding.segment(Coding.iso8601Fractional.string(from: at)))"',
    );
  });
});
