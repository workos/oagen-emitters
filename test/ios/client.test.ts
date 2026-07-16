import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateClient } from '../../src/ios/client.js';

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
  auth: [{ kind: 'bearer' }],
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

describe('ios/client', () => {
  it('emits Package.swift with the configured platform baseline', () => {
    const files = generateClient(spec, ctx);
    const pkg = fileByPath(files, 'Package.swift');
    expect(pkg).toContain('// swift-tools-version: 6.2');
    expect(pkg).toContain('name: "WorkOS"');
    expect(pkg).toContain('.iOS(.v17)');
    expect(pkg).toContain('.macCatalyst(.v17)');
    expect(pkg).toContain('.macOS(.v14)');
    expect(pkg).toContain('.watchOS(.v10)');
    expect(pkg).toContain('.tvOS(.v17)');
    expect(pkg).toContain('.visionOS(.v1)');
    expect(pkg).toContain('.testTarget(name: "WorkOSTests"');
    expect(pkg).toContain('swiftLanguageModes: [.v5]');
  });

  it('emits the client class with a resource accessor', () => {
    const files = generateClient(spec, ctx);
    const client = fileByPath(files, 'Sources/WorkOS/WorkOSClient.swift');
    expect(client).toContain('public final class WorkOSClient: Sendable {');
    expect(client).toContain('public convenience init(apiKey: String, baseURL: URL? = nil)');
    expect(client).toContain('public var organizations: Organizations { Organizations(transport: transport) }');
  });

  it('emits Configuration with policy defaults', () => {
    const files = generateClient(spec, ctx);
    const config = fileByPath(files, 'Sources/WorkOS/Configuration.swift');
    expect(config).toContain('public struct Configuration: Sendable {');
    expect(config).toContain('public static let defaultBaseURL = URL(string: "https://api.workos.com")!');
    expect(config).toContain('retryableStatusCodes: Set<Int>');
  });

  it('emits a URLSession-based transport with bearer auth and retries', () => {
    const files = generateClient(spec, ctx);
    const transport = fileByPath(files, 'Sources/WorkOS/Internal/Transport.swift');
    expect(transport).toContain('public struct Transport: Sendable {');
    expect(transport).toContain('let session: URLSession');
    expect(transport).toContain(
      'request.setValue("Bearer \\(configuration.apiKey)", forHTTPHeaderField: "Authorization")',
    );
    expect(transport).toContain('func backoffNanoseconds(');
    expect(transport).toContain('WorkOSError.from(statusCode: statusCode, apiError: apiError)');
  });

  it('emits the static runtime support files', () => {
    const files = generateClient(spec, ctx);
    const paths = files.map((f) => f.path);
    expect(paths).toContain('Sources/WorkOS/Internal/AnyCodable.swift');
    expect(paths).toContain('Sources/WorkOS/Internal/RequestBody.swift');
    expect(paths).toContain('Sources/WorkOS/Internal/PathEncoding.swift');
    expect(paths).toContain('Sources/WorkOS/Internal/Coding.swift');
    expect(paths).toContain('Sources/WorkOS/Internal/Pagination.swift');
    expect(paths).toContain('Sources/WorkOS/RequestOptions.swift');
    expect(paths).toContain('.swift-format');
  });
});
