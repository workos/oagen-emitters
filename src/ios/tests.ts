import type { ApiSpec, EmitterContext, GeneratedFile, Model, Enum, TypeRef, ResolvedOperation } from '@workos/oagen';
import { planOperation, toCamelCase } from '@workos/oagen';
import { scopedMountGroups } from '../shared/resolved-ops.js';
import { enrichModelsFromSpec, getSyntheticEnums } from '../shared/model-utils.js';
import { flattenDiscriminatedUnionFields } from '../shared/union-flatten.js';
import { parsePathTemplate } from '../shared/path-template.js';
import {
  moduleName,
  clientClassName,
  errorTypeName,
  typeName,
  accessorName,
  resourceTypeName,
  resolveMethodName,
  withResolvedOps,
} from './naming.js';
import {
  collectMethodParams,
  orderMethodParams,
  planAutoPaging,
  autoPagingMethodName,
  resolvePaginatedItemName,
} from './resources.js';
import type { RenderedParam } from './resources.js';
import { generateModelFixture, swiftRawString } from './fixtures.js';

/**
 * Generate the SDK's own behavioral test target:
 *
 * - `MockURLProtocol` — a host-keyed, parallel-safe URLProtocol stub that
 *   queues canned responses and records every outgoing request.
 * - `makeTestClient` — builds a client (unique mock host per call, so Swift
 *   Testing's parallel execution never cross-talks) plus a request recorder.
 * - One suite per mount group with one wire-level test per operation: each
 *   test calls the real generated method against a fixture response and
 *   asserts the HTTP method, the rendered path, the encoded body/query, and
 *   that the response decodes into the expected type.
 * - `TransportBehaviorTests` — auth header, per-request options, typed error
 *   mapping, retry policy, and idempotency behavior.
 * - One multi-page auto-pagination test driving `AutoPagingSequence` through
 *   two stubbed pages.
 *
 * Live wire parity is covered separately by the oagen smoke runner
 * (`smoke/sdk-ios.ts`).
 */
export function generateTests(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const module = moduleName(ctx);
  const rctx = withResolvedOps(ctx);
  const groups = [...scopedMountGroups(rctx).values()].sort((a, b) => a.name.localeCompare(b.name));

  // Fixtures must decode into the emitted structs, so mirror the exact model
  // pipeline the model generator runs (enrich + union-flatten).
  const enriched = enrichModelsFromSpec(spec.models, spec.enums);
  const originalByName = new Map(spec.models.map((m) => [m.name, m]));
  const flatModels = flattenDiscriminatedUnionFields(
    enriched.map((m) => {
      if ((m as { discriminator?: unknown }).discriminator && m.fields.length === 0) {
        const original = originalByName.get(m.name);
        if (original && original.fields.length > 0) return { ...m, fields: original.fields };
      }
      return m;
    }),
  );
  const modelMap = new Map(flatModels.map((m) => [m.name, m]));
  const enumMap = new Map([...spec.enums, ...getSyntheticEnums()].map((e) => [e.name, e]));

  const files: GeneratedFile[] = [
    { path: `Tests/${module}Tests/Support/MockURLProtocol.swift`, content: mockURLProtocol() },
    { path: `Tests/${module}Tests/Support/TestClient.swift`, content: testClient(module, clientClassName(ctx)) },
    { path: `Tests/${module}Tests/TransportBehaviorTests.swift`, content: transportBehaviorTests(module, ctx) },
  ];

  // Generate the multi-page auto-pagination test exactly once, on the first
  // paginated operation (deterministic: groups and ops are sorted).
  let autoPagingEmitted = false;

  for (const group of groups) {
    const gen = new SuiteGenerator(module, rctx, modelMap, enumMap);
    const suite = typeName(group.name);
    const accessor = accessorName(group.name);
    const resource = resourceTypeName(group.name, rctx);
    const tests: string[] = [
      `    @Test func resourceIsReachable() {`,
      `        let (client, _) = makeTestClient()`,
      `        _ = client.${accessor}`,
      `        #expect(client.configuration.apiKey == "sk_test_123")`,
      `    }`,
    ];
    const seen = new Set<string>();
    for (const resolved of [...group.resolvedOps].sort((a, b) => a.operation.path.localeCompare(b.operation.path))) {
      if (resolved.urlBuilder) continue;
      if (resolved.wrappers && resolved.wrappers.length > 0) continue;
      const method = resolveMethodName(resolved.operation, group.name, rctx);
      if (seen.has(method)) continue;
      seen.add(method);
      const test = gen.operationTest(resolved, accessor, method);
      if (test) tests.push('', test);
      if (!autoPagingEmitted) {
        const autoTest = gen.autoPagingTest(resolved, accessor, method);
        if (autoTest) {
          tests.push('', autoTest);
          autoPagingEmitted = true;
        }
      }
    }

    const lines: string[] = [];
    lines.push('import Foundation');
    lines.push('import Testing');
    lines.push('');
    lines.push(`@testable import ${module}`);
    lines.push('');
    lines.push(`/// Wire-level tests for the ${resource} resource: each test performs a real`);
    lines.push('/// call through the mocked transport and asserts the request that went out');
    lines.push('/// and the decoded response that came back.');
    lines.push(`@Suite struct ${suite}Tests {`);
    lines.push(tests.join('\n'));
    lines.push('}');
    files.push({ path: `Tests/${module}Tests/${suite}Tests.swift`, content: lines.join('\n') });
  }

  return files;
}

// --- per-operation test generation -------------------------------------------

interface SampleArg {
  /** Swift argument expression. */
  expr: string;
  /** For path params: the literal value interpolated into the URL path. */
  pathValue?: string;
  /** For query params: the expected serialized query value. */
  queryValue?: string;
}

class SuiteGenerator {
  constructor(
    private module: string,
    private ctx: EmitterContext,
    private modelMap: Map<string, Model>,
    private enumMap: Map<string, Enum>,
  ) {}

  /** Build a wire-level test for one operation, or null when a required
   * parameter cannot be sample-constructed (nested model bodies etc.). */
  operationTest(resolved: ResolvedOperation, accessor: string, method: string): string | null {
    const op = resolved.operation;
    const params = collectMethodParams(resolved, this.ctx);
    const ordered = orderMethodParams(params);

    const args: string[] = [];
    const pathValues = new Map<string, string>();
    let firstBodyWire: string | null = null;
    for (const p of ordered) {
      if (p.optional) continue;
      const sample = this.sampleArg(p);
      if (!sample) return null;
      args.push(`${p.name}: ${sample.expr}`);
      if (p.kind === 'path' && sample.pathValue) pathValues.set(p.wire, sample.pathValue);
      if (p.kind === 'body' && firstBodyWire === null) firstBodyWire = p.wire;
    }

    const expectedPath = this.expectedPath(op.path, pathValues);
    if (expectedPath === null) return null;
    const fixture = this.responseFixture(resolved);
    if (fixture === null) return null;

    const lines: string[] = [];
    lines.push(`    @Test func ${method}SendsExpectedRequest() async throws {`);
    lines.push(`        let (client, recorder) = makeTestClient(responding: ${swiftRawString(fixture.json)})`);
    const call = `client.${accessor}.${method}(${args.join(', ')})`;
    if (fixture.binding) {
      lines.push(`        let result = try await ${call}`);
    } else {
      lines.push(`        try await ${call}`);
    }
    lines.push('');
    lines.push('        let request = try #require(recorder.lastRequest)');
    lines.push(`        #expect(request.httpMethod == "${op.httpMethod.toUpperCase()}")`);
    lines.push(`        #expect(request.url?.path == "${expectedPath}")`);
    if (firstBodyWire) {
      lines.push('        let body = try #require(recorder.lastBody)');
      lines.push('        let json = try JSONSerialization.jsonObject(with: body) as? [String: Any]');
      lines.push(`        #expect(json?[${JSON.stringify(firstBodyWire)}] != nil)`);
    }
    for (const q of ordered) {
      if (q.kind !== 'query' || q.optional) continue;
      const sample = this.sampleArg(q);
      if (!sample?.queryValue) continue;
      lines.push(
        '        let query = URLComponents(url: try #require(request.url), resolvingAgainstBaseURL: false)?.queryItems ?? []',
      );
      lines.push(
        `        #expect(query.contains(URLQueryItem(name: ${JSON.stringify(q.wire)}, value: ${JSON.stringify(sample.queryValue)})))`,
      );
      break;
    }
    for (const assertion of fixture.assertions) {
      lines.push(`        ${assertion}`);
    }
    lines.push('    }');
    return lines.join('\n');
  }

  /** A two-page auto-pagination test for the first eligible paginated op. */
  autoPagingTest(resolved: ResolvedOperation, accessor: string, method: string): string | null {
    const auto = planAutoPaging(resolved, this.ctx);
    if (!auto) return null;
    // Only all-optional signatures keep this test simple and deterministic.
    if (auto.params.some((p) => !p.optional)) return null;
    const itemModel = this.modelMap.get(
      resolvePaginatedItemName(planOperation(resolved.operation).paginatedItemModelName!, this.ctx),
    );
    if (!itemModel || itemModel.fields.length === 0) return null;
    const item = generateModelFixture(itemModel, this.modelMap, this.enumMap);
    const itemJson = JSON.stringify(item);
    const page1 = `{"data":[${itemJson}],"list_metadata":{"before":null,"after":"cursor_2"}}`;
    const page2 = `{"data":[${itemJson}],"list_metadata":{"before":null,"after":null}}`;

    const lines: string[] = [];
    lines.push(`    @Test func ${autoPagingMethodName(method)}FetchesAllPages() async throws {`);
    lines.push('        let (client, recorder) = makeTestClient(stubs: [');
    lines.push(`            .init(statusCode: 200, data: Data(${swiftRawString(page1)}.utf8), headers: [:]),`);
    lines.push(`            .init(statusCode: 200, data: Data(${swiftRawString(page2)}.utf8), headers: [:]),`);
    lines.push('        ])');
    lines.push(`        var items: [${auto.itemType}] = []`);
    lines.push(`        for try await item in client.${accessor}.${autoPagingMethodName(method)}() {`);
    lines.push('            items.append(item)');
    lines.push('        }');
    lines.push('');
    lines.push('        #expect(items.count == 2)');
    lines.push('        #expect(recorder.allRequests.count == 2)');
    lines.push('        let second = try #require(recorder.allRequests.last?.url)');
    lines.push('        let query = URLComponents(url: second, resolvingAgainstBaseURL: false)?.queryItems ?? []');
    lines.push(
      `        #expect(query.contains(URLQueryItem(name: ${JSON.stringify(auto.cursorWire)}, value: "cursor_2")))`,
    );
    lines.push('    }');
    return lines.join('\n');
  }

  /** Render the expected URL path for a template with sample path values. */
  private expectedPath(template: string, pathValues: Map<string, string>): string | null {
    const segments = parsePathTemplate(template, { stripLeadingSlash: true });
    let path = '';
    for (const seg of segments) {
      if (seg.kind === 'literal') {
        path += seg.value;
      } else {
        const value = pathValues.get(seg.name);
        if (!value) return null; // hidden/unsampled path param
        path += value;
      }
    }
    return `/${path}`;
  }

  /** Sample Swift expression for a required parameter, or null if unsupported. */
  private sampleArg(p: RenderedParam): SampleArg | null {
    if (p.kind === 'bodyRaw') return null;
    return this.sampleForRef(p.ref, p.wire, p.kind);
  }

  private sampleForRef(ref: TypeRef, wire: string, kind: RenderedParam['kind']): SampleArg | null {
    switch (ref.kind) {
      case 'nullable':
        return this.sampleForRef(ref.inner, wire, kind);
      case 'primitive':
        switch (ref.type) {
          case 'string': {
            if (ref.format === 'date-time' || ref.format === 'date') {
              return { expr: 'Date(timeIntervalSince1970: 1_672_531_200)' };
            }
            if (ref.format === 'byte' || ref.format === 'binary') {
              return { expr: 'Data("test".utf8)' };
            }
            const value = kind === 'path' ? `sample-${wire.replace(/[^a-zA-Z0-9]+/g, '-')}` : `test_${wire}`;
            return { expr: JSON.stringify(value), pathValue: value, queryValue: value };
          }
          case 'integer':
            return { expr: '1', pathValue: '1', queryValue: '1' };
          case 'number':
            return { expr: '1.5', queryValue: '1.5' };
          case 'boolean':
            return { expr: 'true', queryValue: 'true' };
          case 'unknown':
            return { expr: 'AnyCodable.string("test")' };
          default:
            return null;
        }
      case 'literal':
        return typeof ref.value === 'string'
          ? { expr: JSON.stringify(ref.value), queryValue: ref.value }
          : typeof ref.value === 'number' || typeof ref.value === 'boolean'
            ? { expr: String(ref.value), queryValue: String(ref.value) }
            : null;
      case 'enum': {
        const e = this.enumMap.get(ref.name);
        const first = e?.values[0]?.value;
        if (first === undefined) return null;
        const literal = typeof first === 'string' ? JSON.stringify(first) : String(first);
        return { expr: `${typeName(ref.name)}(rawValue: ${literal})`, queryValue: String(first) };
      }
      case 'array': {
        const inner = this.sampleForRef(ref.items, wire, 'body');
        return inner ? { expr: `[${inner.expr}]` } : null;
      }
      case 'map': {
        const inner = this.sampleForRef(ref.valueType, wire, 'body');
        return inner ? { expr: `["key": ${inner.expr}]` } : null;
      }
      default:
        // model / union bodies need nested construction — skip those operations.
        return null;
    }
  }

  /** Fixture JSON + decode assertions for the operation's response. */
  private responseFixture(
    resolved: ResolvedOperation,
  ): { json: string; binding: boolean; assertions: string[] } | null {
    const op = resolved.operation;
    const plan = planOperation(op);
    if (plan.isPaginated && plan.paginatedItemModelName) {
      const itemModel = this.modelMap.get(resolvePaginatedItemName(plan.paginatedItemModelName, this.ctx));
      if (!itemModel || itemModel.fields.length === 0) return null;
      const item = generateModelFixture(itemModel, this.modelMap, this.enumMap);
      const json = `{"data":[${JSON.stringify(item)}],"list_metadata":{"before":null,"after":null}}`;
      const assertions = [
        '#expect(result.data.count == 1)',
        ...this.idAssertion(itemModel, item, 'result.data.first?'),
      ];
      return { json, binding: true, assertions };
    }
    if (plan.isArrayResponse && plan.responseModelName) {
      const model = this.modelMap.get(plan.responseModelName);
      if (!model || model.fields.length === 0) return null;
      const item = generateModelFixture(model, this.modelMap, this.enumMap);
      return { json: `[${JSON.stringify(item)}]`, binding: true, assertions: ['#expect(result.count == 1)'] };
    }
    if (plan.responseModelName) {
      const model = this.modelMap.get(plan.responseModelName);
      if (!model) return null;
      const fixture = generateModelFixture(model, this.modelMap, this.enumMap);
      return {
        json: JSON.stringify(fixture),
        binding: true,
        assertions: model.fields.length === 0 ? ['_ = result'] : this.idAssertion(model, fixture, 'result'),
      };
    }
    return { json: '{}', binding: false, assertions: [] };
  }

  /** Assert the decoded `id` when the model has a plain required string id. */
  private idAssertion(model: Model, fixture: Record<string, unknown>, target: string): string[] {
    const idField = model.fields.find(
      (f) => f.name === 'id' && f.required && f.type.kind === 'primitive' && f.type.type === 'string' && !f.type.format,
    );
    const value = fixture['id'];
    if (!idField || typeof value !== 'string') return [`_ = ${target.replace(/\?$/, '')}`];
    return [`#expect(${target}.id == ${JSON.stringify(value)})`];
  }
}

// --- static support + transport behavior --------------------------------------

function mockURLProtocol(): string {
  return `import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// A URLProtocol that serves queued canned responses and records outgoing
/// requests, keyed by request host. Every test client uses a unique mock host,
/// so parallel Swift Testing execution never observes another test's traffic.
final class MockURLProtocol: URLProtocol {
    struct Stub {
        let statusCode: Int
        let data: Data
        let headers: [String: String]
    }

    private static let lock = NSLock()
    private static var stubQueues: [String: [Stub]] = [:]
    private static var recordedRequests: [String: [URLRequest]] = [:]
    private static var recordedBodies: [String: [Data]] = [:]

    /// Register a queue of responses for a mock host. Each request pops the
    /// next stub; the final stub is reused once the queue is exhausted.
    static func register(host: String, stubs: [Stub]) {
        lock.lock()
        defer { lock.unlock() }
        stubQueues[host] = stubs
        recordedRequests[host] = []
        recordedBodies[host] = []
    }

    static func requests(forHost host: String) -> [URLRequest] {
        lock.lock()
        defer { lock.unlock() }
        return recordedRequests[host] ?? []
    }

    static func bodies(forHost host: String) -> [Data] {
        lock.lock()
        defer { lock.unlock() }
        return recordedBodies[host] ?? []
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let host = request.url?.host ?? ""
        let stub = MockURLProtocol.consume(host: host, request: request)
        let response = HTTPURLResponse(
            url: request.url ?? URL(string: "https://example.test")!,
            statusCode: stub.statusCode,
            httpVersion: nil,
            headerFields: stub.headers
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: stub.data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func consume(host: String, request: URLRequest) -> Stub {
        lock.lock()
        defer { lock.unlock() }
        recordedRequests[host, default: []].append(request)
        if let body = request.httpBody {
            recordedBodies[host, default: []].append(body)
        } else if let stream = request.httpBodyStream {
            recordedBodies[host, default: []].append(readStream(stream))
        }
        var queue = stubQueues[host] ?? []
        let stub = queue.isEmpty ? Stub(statusCode: 200, data: Data("{}".utf8), headers: [:]) : queue.removeFirst()
        if queue.isEmpty {
            stubQueues[host] = [stub]
        } else {
            stubQueues[host] = queue
        }
        return stub
    }

    private static func readStream(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        let bufferSize = 4096
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
        defer { buffer.deallocate() }
        while stream.hasBytesAvailable {
            let read = stream.read(buffer, maxLength: bufferSize)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }
}
`;
}

function testClient(module: string, clientName: string): string {
  return `import Foundation
@testable import ${module}

/// Reads back the requests a mocked client sent.
struct RequestRecorder {
    let host: String

    var allRequests: [URLRequest] { MockURLProtocol.requests(forHost: host) }
    var lastRequest: URLRequest? { allRequests.last }
    var lastBody: Data? { MockURLProtocol.bodies(forHost: host).last }
}

/// Build a client whose URLSession is backed by MockURLProtocol, serving the
/// given response queue from a unique per-client mock host.
func makeTestClient(stubs: [MockURLProtocol.Stub]) -> (${clientName}, RequestRecorder) {
    let host = "mock-\\(UUID().uuidString.lowercased()).example.test"
    MockURLProtocol.register(host: host, stubs: stubs)
    let sessionConfig = URLSessionConfiguration.ephemeral
    sessionConfig.protocolClasses = [MockURLProtocol.self]
    let session = URLSession(configuration: sessionConfig)
    let configuration = Configuration(apiKey: "sk_test_123", baseURL: URL(string: "https://\\(host)")!)
    let client = ${clientName}(configuration: configuration, transport: Transport(configuration: configuration, session: session))
    return (client, RequestRecorder(host: host))
}

/// Convenience: a single canned response.
func makeTestClient(
    statusCode: Int = 200,
    responding body: String = "{}",
    headers: [String: String] = [:]
) -> (${clientName}, RequestRecorder) {
    makeTestClient(stubs: [MockURLProtocol.Stub(statusCode: statusCode, data: Data(body.utf8), headers: headers)])
}
`;
}

function transportBehaviorTests(module: string, ctx: EmitterContext): string {
  const errorName = errorTypeName(ctx);
  const sdk = ctx.spec.sdk;
  const notFoundKind = sdk.errors.statusCodeMap[404];
  const notFoundCase = notFoundKind ? toCamelCase(notFoundKind) : 'api';
  const retryable = sdk.retry.retryableStatusCodes[0] ?? 500;
  const emitRetryTest = sdk.retry.maxRetries >= 1 && sdk.retry.backoff.initialDelay <= 2;
  const idempotencyHeader = sdk.idempotency.headerName;
  const autoIdempotency = sdk.idempotency.autoGenerateForPost;

  const lines: string[] = [];
  lines.push('import Foundation');
  lines.push('import Testing');
  lines.push('');
  lines.push(`@testable import ${module}`);
  lines.push('');
  lines.push('private struct EmptyBody: Codable {}');
  lines.push('');
  lines.push('/// Behavioral tests for the shared transport: authentication, per-request');
  lines.push('/// options, typed error mapping, retries, and idempotency.');
  lines.push('@Suite struct TransportBehaviorTests {');
  lines.push('    @Test func sendsAuthorizationAndUserAgentHeaders() async throws {');
  lines.push('        let (client, recorder) = makeTestClient()');
  lines.push('        _ = try await client.transport.request(');
  lines.push('            method: "GET", path: "things", query: [], body: nil, options: nil, as: EmptyBody.self)');
  lines.push('');
  lines.push('        let request = try #require(recorder.lastRequest)');
  lines.push('        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer sk_test_123")');
  lines.push('        #expect(request.value(forHTTPHeaderField: "User-Agent")?.isEmpty == false)');
  lines.push('    }');
  lines.push('');
  lines.push('    @Test func requestOptionsOverrideHeadersAndTimeout() async throws {');
  lines.push('        let (client, recorder) = makeTestClient()');
  lines.push('        let options = RequestOptions(additionalHeaders: ["X-Test-Header": "test-value"], timeout: 5)');
  lines.push('        _ = try await client.transport.request(');
  lines.push('            method: "GET", path: "things", query: [], body: nil, options: options, as: EmptyBody.self)');
  lines.push('');
  lines.push('        let request = try #require(recorder.lastRequest)');
  lines.push('        #expect(request.value(forHTTPHeaderField: "X-Test-Header") == "test-value")');
  lines.push('        #expect(request.timeoutInterval == 5)');
  lines.push('    }');
  lines.push('');
  lines.push('    @Test func mapsErrorStatusToTypedError() async throws {');
  lines.push('        let errorBody = #"{"message":"Not found","code":"entity_not_found","request_id":"req_123"}"#');
  lines.push('        let (client, _) = makeTestClient(statusCode: 404, responding: errorBody)');
  lines.push('        do {');
  lines.push('            _ = try await client.transport.request(');
  lines.push(
    '                method: "GET", path: "things/thing_123", query: [], body: nil, options: nil, as: EmptyBody.self)',
  );
  lines.push('            Issue.record("expected a typed error to be thrown")');
  lines.push(`        } catch let error as ${errorName} {`);
  lines.push(`            guard case .${notFoundCase}(let apiError) = error else {`);
  lines.push(`                Issue.record("expected ${errorName}.${notFoundCase}, got \\(error)")`);
  lines.push('                return');
  lines.push('            }');
  lines.push('            #expect(apiError.statusCode == 404)');
  lines.push('            #expect(apiError.message == "Not found")');
  lines.push('            #expect(apiError.code == "entity_not_found")');
  lines.push('            #expect(apiError.requestID == "req_123")');
  lines.push('        }');
  lines.push('    }');
  if (emitRetryTest) {
    lines.push('');
    lines.push('    @Test func retriesRetryableStatusThenSucceeds() async throws {');
    lines.push('        let (client, recorder) = makeTestClient(stubs: [');
    lines.push(`            .init(statusCode: ${retryable}, data: Data("{}".utf8), headers: ["Retry-After": "0"]),`);
    lines.push('            .init(statusCode: 200, data: Data("{}".utf8), headers: [:]),');
    lines.push('        ])');
    lines.push('        _ = try await client.transport.request(');
    lines.push('            method: "GET", path: "things", query: [], body: nil, options: nil, as: EmptyBody.self)');
    lines.push('');
    lines.push('        #expect(recorder.allRequests.count == 2)');
    lines.push('    }');
  }
  lines.push('');
  if (autoIdempotency) {
    lines.push('    @Test func postRequestsCarryAnIdempotencyKey() async throws {');
    lines.push('        let (client, recorder) = makeTestClient()');
    lines.push('        _ = try await client.transport.request(');
    lines.push('            method: "POST", path: "things", query: [], body: nil, options: nil, as: EmptyBody.self)');
    lines.push('');
    lines.push('        let request = try #require(recorder.lastRequest)');
    lines.push(
      `        #expect(request.value(forHTTPHeaderField: ${JSON.stringify(idempotencyHeader)})?.isEmpty == false)`,
    );
    lines.push('    }');
    lines.push('');
  }
  lines.push('    @Test func explicitIdempotencyKeyIsHonored() async throws {');
  lines.push('        let (client, recorder) = makeTestClient()');
  lines.push('        let options = RequestOptions(idempotencyKey: "key_123")');
  lines.push('        _ = try await client.transport.request(');
  lines.push('            method: "POST", path: "things", query: [], body: nil, options: options, as: EmptyBody.self)');
  lines.push('');
  lines.push('        let request = try #require(recorder.lastRequest)');
  lines.push(`        #expect(request.value(forHTTPHeaderField: ${JSON.stringify(idempotencyHeader)}) == "key_123")`);
  lines.push('    }');
  lines.push('}');
  return lines.join('\n');
}
