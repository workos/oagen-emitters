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
    // Host-keyed registry so parallel Swift Testing runs never cross-talk.
    expect(mock).toContain('static func register(host: String, stubs: [Stub]) {');

    const testClient = fileByPath(files, 'Tests/WorkOSTests/Support/TestClient.swift');
    expect(testClient).toContain(
      'func makeTestClient(stubs: [MockURLProtocol.Stub]) -> (WorkOSClient, RequestRecorder)',
    );
    expect(testClient).toContain('sessionConfig.protocolClasses = [MockURLProtocol.self]');
    expect(testClient).toContain('struct RequestRecorder {');
  });

  it('emits a wire-level test per operation in each mount-group suite', () => {
    const files = generateTests(spec, ctx);
    const suite = fileByPath(files, 'Tests/WorkOSTests/OrganizationsTests.swift');
    expect(suite).toContain('import Testing');
    expect(suite).toContain('@Suite struct OrganizationsTests {');
    expect(suite).toContain('@Test func resourceIsReachable() {');
    // Behavioral test: performs the call and asserts the outgoing request
    // and the decoded response, not just type existence.
    expect(suite).toContain('SendsExpectedRequest() async throws {');
    expect(suite).toContain('#expect(request.httpMethod == "GET")');
    expect(suite).toContain('#expect(request.url?.path == "/organizations")');
    expect(suite).toContain('#expect(result.count == 1)');
  });

  it('emits transport behavior tests (auth, options, typed errors, idempotency)', () => {
    const files = generateTests(spec, ctx);
    const transport = fileByPath(files, 'Tests/WorkOSTests/TransportBehaviorTests.swift');
    expect(transport).toContain('@Suite struct TransportBehaviorTests {');
    expect(transport).toContain('#expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer sk_test_123")');
    expect(transport).toContain('@Test func requestOptionsOverrideHeadersAndTimeout() async throws {');
    expect(transport).toContain('@Test func mapsErrorStatusToTypedError() async throws {');
    expect(transport).toContain('catch let error as WorkOSError {');
    expect(transport).toContain('@Test func retriesRetryableStatusThenSucceeds() async throws {');
    expect(transport).toContain('@Test func explicitIdempotencyKeyIsHonored() async throws {');
  });

  it('emits a multi-page auto-pagination test for a paginated operation', () => {
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
    const files = generateTests(paginatedSpec, { ...ctx, spec: paginatedSpec });
    const suite = fileByPath(files, 'Tests/WorkOSTests/OrganizationsTests.swift');
    expect(suite).toContain('AutoPagingFetchesAllPages() async throws {');
    expect(suite).toContain('"list_metadata":{"before":null,"after":"cursor_2"}');
    expect(suite).toContain('#expect(items.count == 2)');
    expect(suite).toContain('#expect(recorder.allRequests.count == 2)');
    expect(suite).toContain('#expect(query.contains(URLQueryItem(name: "after", value: "cursor_2")))');
  });
});
