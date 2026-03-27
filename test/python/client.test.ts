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

    const clientFile = files.find((f) => f.path === 'workos/_client.py');
    expect(clientFile).toBeDefined();

    const content = clientFile!.content;
    expect(content).toContain('class WorkOS:');
    expect(content).toContain('self.organizations = Organizations(self)');
    expect(content).toContain('def _request(');
    expect(content).toContain('def _request_page(');
    expect(content).toContain('RETRY_STATUS_CODES');
    expect(content).toContain('Idempotency-Key');
  });

  it('generates barrel __init__.py', () => {
    const files = generateClient(spec, ctx);

    const barrel = files.find((f) => f.path === 'workos/__init__.py');
    expect(barrel).toBeDefined();
    expect(barrel!.content).toContain('from ._client import WorkOS');
    expect(barrel!.content).toContain('from ._errors import');
    expect(barrel!.content).toContain('from ._pagination import SyncPage');
  });

  it('generates service __init__.py', () => {
    const files = generateClient(spec, ctx);

    const serviceInit = files.find((f) => f.path === 'workos/organizations/__init__.py');
    expect(serviceInit).toBeDefined();
    expect(serviceInit!.content).toContain('from ._resource import Organizations');
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

    const pyTyped = files.find((f) => f.path === 'workos/py.typed');
    expect(pyTyped).toBeDefined();
  });

  it('uses base URL from spec', () => {
    const files = generateClient(spec, ctx);
    const clientFile = files.find((f) => f.path === 'workos/_client.py');
    expect(clientFile!.content).toContain('base_url: str = "https://api.workos.com"');
  });
});
