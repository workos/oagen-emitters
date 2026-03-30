import { describe, it, expect } from 'vitest';
import { generateClient } from '../../src/python/client.js';
import type { EmitterContext, ApiSpec, Service, Model } from '@workos/oagen';

const models: Model[] = [
  {
    name: 'Organization',
    fields: [
      { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
      { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
    ],
  },
];

const services: Service[] = [
  {
    name: 'Organizations',
    operations: [
      {
        name: 'listOrganizations',
        httpMethod: 'get',
        path: '/organizations',
        pathParams: [],
        queryParams: [],
        headerParams: [],
        response: { kind: 'model', name: 'Organization' },
        errors: [],
        injectIdempotencyKey: false,
      },
    ],
  },
];

const spec: ApiSpec = {
  name: 'TestAPI',
  version: '1.0.0',
  baseUrl: 'https://api.workos.com',
  services,
  models,
  enums: [],
};

const ctx: EmitterContext = {
  namespace: 'workos',
  namespacePascal: 'WorkOS',
  spec,
};

describe('generateClient', () => {
  it('generates client class with resource accessors', () => {
    const files = generateClient(spec, ctx);

    const clientFile = files.find((f) => f.path === 'src/workos/_client.py');
    expect(clientFile).toBeDefined();

    const content = clientFile!.content;
    expect(content).toContain('class WorkOS:');
    // Lazy resource accessors via cached_property
    expect(content).toContain('@functools.cached_property');
    expect(content).toContain('def organizations(self) -> Organizations:');
    expect(content).toContain('def request(');
    expect(content).toContain('def request_page(');
    expect(content).toContain('RETRY_STATUS_CODES');
    expect(content).toContain('Idempotency-Key');
    // P1-1: Async client
    expect(content).toContain('class AsyncWorkOS:');
    // P0-4: Context manager
    expect(content).toContain('def close(self)');
    expect(content).toContain('def __enter__');
    // P2-3: client_id
    expect(content).toContain('client_id: Optional[str] = None,');
    // P3-4: Versioned User-Agent
    expect(content).toContain('workos-python/{VERSION}');
  });

  it('generates barrel __init__.py', () => {
    const files = generateClient(spec, ctx);

    const barrel = files.find((f) => f.path === 'src/workos/__init__.py');
    expect(barrel).toBeDefined();
    expect(barrel!.content).toContain('from ._client import AsyncWorkOS, WorkOS');
    expect(barrel!.content).toContain('from ._errors import');
    expect(barrel!.content).toContain('from ._pagination import AsyncPage, SyncPage');
    expect(barrel!.content).toContain('"ForbiddenError"');
    expect(barrel!.content).toContain('"WorkOSConnectionError"');
    expect(barrel!.content).toContain('"WorkOSTimeoutError"');
  });

  it('generates service __init__.py', () => {
    const files = generateClient(spec, ctx);

    const serviceInit = files.find((f) => f.path === 'src/workos/organizations/__init__.py');
    expect(serviceInit).toBeDefined();
    expect(serviceInit!.content).toContain('from ._resource import Organizations, AsyncOrganizations');
  });

  it('generates pyproject.toml', () => {
    const files = generateClient(spec, ctx);

    const pyproject = files.find((f) => f.path === 'pyproject.toml');
    expect(pyproject).toBeDefined();
    expect(pyproject!.content).toContain('name = "workos"');
    expect(pyproject!.content).toContain('httpx');
    expect(pyproject!.content).toContain('hatchling');
    expect(pyproject!.headerPlacement).toBe('skip');
  });

  it('generates py.typed marker', () => {
    const files = generateClient(spec, ctx);

    const pyTyped = files.find((f) => f.path === 'src/workos/py.typed');
    expect(pyTyped).toBeDefined();
  });

  it('request_page accepts body parameter', () => {
    const files = generateClient(spec, ctx);
    const clientFile = files.find((f) => f.path === 'src/workos/_client.py');
    const content = clientFile!.content;

    // Signature should include body param
    expect(content).toContain('body: Optional[Dict[str, Any]] = None,');
    // Should forward body to self.request()
    expect(content).toContain('body=body,');
  });

  it('uses base URL from spec', () => {
    const files = generateClient(spec, ctx);
    const clientFile = files.find((f) => f.path === 'src/workos/_client.py');
    expect(clientFile!.content).toContain('base_url: str = "https://api.workos.com"');
  });
});
