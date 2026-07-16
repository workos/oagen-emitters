import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateTests } from '../../src/ios/tests.js';

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
          queryParams: [],
          headerParams: [],
          response: { kind: 'array', items: { kind: 'model', name: 'Organization' } },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    },
  ],
  models: [
    { name: 'Organization', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
  ],
  enums: [],
  sdk: defaultSdkBehavior(),
};

const ctx: EmitterContext = {
  namespace: 'workos',
  namespacePascal: 'WorkOS',
  spec,
};

function fileByPath(files: { path: string; content: string }[], path: string): string {
  const f = files.find((f) => f.path === path);
  if (!f) throw new Error(`missing generated file: ${path}`);
  return f.content;
}

describe('ios/tests', () => {
  it('emits the mock protocol and test-client support files', () => {
    const files = generateTests(spec, ctx);
    const paths = files.map((f) => f.path);
    expect(paths).toContain('Tests/WorkOSTests/Support/MockURLProtocol.swift');
    expect(paths).toContain('Tests/WorkOSTests/Support/TestClient.swift');

    const mock = fileByPath(files, 'Tests/WorkOSTests/Support/MockURLProtocol.swift');
    expect(mock).toContain('final class MockURLProtocol: URLProtocol {');
    expect(mock).toContain('override func startLoading() {');

    const testClient = fileByPath(files, 'Tests/WorkOSTests/Support/TestClient.swift');
    expect(testClient).toContain('func makeTestClient(');
    expect(testClient).toContain('sessionConfig.protocolClasses = [MockURLProtocol.self]');
    expect(testClient).toContain('return WorkOSClient(configuration: configuration, transport:');
  });

  it('emits a Swift Testing suite per mount group', () => {
    const files = generateTests(spec, ctx);
    const suite = fileByPath(files, 'Tests/WorkOSTests/OrganizationsTests.swift');
    expect(suite).toContain('import Testing');
    expect(suite).toContain('@Suite struct OrganizationsTests {');
    expect(suite).toContain('@Test func resourceIsReachable() {');
    expect(suite).toContain('_ = client.organizations');
  });
});
