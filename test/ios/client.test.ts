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
  it('emits only the accessor extension and the smoke plan', () => {
    const files = generateClient(ctx);
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual(['.oagen-ios-smoke.json', 'Sources/WorkOS/WorkOSClient+Resources.swift']);
  });

  it('emits one resource accessor per mount group as a client extension', () => {
    const files = generateClient(ctx);
    const accessors = fileByPath(files, 'Sources/WorkOS/WorkOSClient+Resources.swift');
    expect(accessors).toContain('extension WorkOSClient {');
    expect(accessors).toContain('public var organizations: Organizations { Organizations(transport: transport) }');
    // The client class core is hand-maintained in the SDK repo — the extension
    // must not redeclare it.
    expect(accessors).not.toContain('public final class WorkOSClient');
    expect(accessors).not.toContain('init(');
  });

  it('does not emit the hand-maintained runtime or repo resources', () => {
    const paths = generateClient(ctx).map((f) => f.path);
    for (const handMaintained of [
      'Sources/WorkOS/WorkOSClient.swift',
      'Sources/WorkOS/Configuration.swift',
      'Sources/WorkOS/RequestOptions.swift',
      'Sources/WorkOS/Internal/Transport.swift',
      'Sources/WorkOS/Internal/AnyCodable.swift',
      'Sources/WorkOS/Internal/RequestBody.swift',
      'Sources/WorkOS/Internal/PathEncoding.swift',
      'Sources/WorkOS/Internal/Coding.swift',
      'Sources/WorkOS/Internal/Pagination.swift',
      'Package.swift',
      '.swift-format',
      'script/ci',
      '.gitignore',
    ]) {
      expect(paths).not.toContain(handMaintained);
    }
  });

  it('marks the smoke plan staging-only', () => {
    const smoke = generateClient(ctx).find((f) => f.path === '.oagen-ios-smoke.json');
    expect(smoke?.integrateTarget).toBe(false);
  });
});
