import type { ApiSpec, EmitterContext, GeneratedFile } from '@workos/oagen';
import { scopedMountGroups } from '../shared/resolved-ops.js';
import { moduleName, clientClassName, typeName, accessorName, withResolvedOps } from './naming.js';

/**
 * Generate the SDK's own test target: `MockURLProtocol` + a `makeTestClient`
 * helper (URLSession backed by the mock), plus one Swift Testing suite per mount
 * group verifying the resource accessor is reachable through a mocked client.
 *
 * Comprehensive wire-level parity is covered separately by the oagen smoke
 * runner (`smoke/sdk-ios.ts`); these generated tests guarantee the SDK compiles
 * and its public surface is exercised under `swift test`.
 */
export function generateTests(_spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const module = moduleName(ctx);
  const rctx = withResolvedOps(ctx);
  const groups = [...scopedMountGroups(rctx).values()].sort((a, b) => a.name.localeCompare(b.name));

  const files: GeneratedFile[] = [
    { path: `Tests/${module}Tests/Support/MockURLProtocol.swift`, content: mockURLProtocol() },
    { path: `Tests/${module}Tests/Support/TestClient.swift`, content: testClient(module, clientClassName(ctx)) },
  ];

  for (const group of groups) {
    files.push({
      path: `Tests/${module}Tests/${typeName(group.name)}Tests.swift`,
      content: resourceTest(module, typeName(group.name), accessorName(group.name)),
    });
  }

  return files;
}

function mockURLProtocol(): string {
  return `import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// A URLProtocol that returns a canned response and records the outgoing request,
/// so tests can assert wire-level behavior without hitting the network.
final class MockURLProtocol: URLProtocol {
    struct Stub {
        let statusCode: Int
        let data: Data
        let headers: [String: String]
    }

    private static let lock = NSLock()
    private static var stub = Stub(statusCode: 200, data: Data("{}".utf8), headers: [:])
    private static var storedRequest: URLRequest?
    private static var storedBody: Data?

    static func setStub(_ newStub: Stub) {
        lock.lock(); defer { lock.unlock() }
        stub = newStub
        storedRequest = nil
        storedBody = nil
    }

    static var lastRequest: URLRequest? {
        lock.lock(); defer { lock.unlock() }
        return storedRequest
    }

    static var lastBody: Data? {
        lock.lock(); defer { lock.unlock() }
        return storedBody
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        MockURLProtocol.record(request)
        let current = MockURLProtocol.snapshot()
        let response = HTTPURLResponse(
            url: request.url ?? URL(string: "https://example.test")!,
            statusCode: current.statusCode,
            httpVersion: nil,
            headerFields: current.headers
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: current.data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func snapshot() -> Stub {
        lock.lock(); defer { lock.unlock() }
        return stub
    }

    private static func record(_ request: URLRequest) {
        lock.lock(); defer { lock.unlock() }
        storedRequest = request
        if let body = request.httpBody {
            storedBody = body
        } else if let stream = request.httpBodyStream {
            storedBody = readStream(stream)
        }
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

/// Build a client whose URLSession is backed by MockURLProtocol.
func makeTestClient(
    statusCode: Int = 200,
    responding body: String = "{}",
    headers: [String: String] = [:]
) -> ${clientName} {
    let sessionConfig = URLSessionConfiguration.ephemeral
    sessionConfig.protocolClasses = [MockURLProtocol.self]
    let session = URLSession(configuration: sessionConfig)
    MockURLProtocol.setStub(MockURLProtocol.Stub(statusCode: statusCode, data: Data(body.utf8), headers: headers))
    let configuration = Configuration(apiKey: "sk_test_123", baseURL: URL(string: "https://api.example.test")!)
    return ${clientName}(configuration: configuration, transport: Transport(configuration: configuration, session: session))
}
`;
}

function resourceTest(module: string, resource: string, accessor: string): string {
  return `import Testing
import Foundation
@testable import ${module}

@Suite struct ${resource}Tests {
    @Test func resourceIsReachable() {
        let client = makeTestClient()
        _ = client.${accessor}
        #expect(client.configuration.apiKey == "sk_test_123")
    }
}
`;
}
