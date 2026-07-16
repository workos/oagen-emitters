import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec } from '@workos/oagen';
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
});
