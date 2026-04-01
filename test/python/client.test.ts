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
    expect(content).toContain('class _BaseWorkOSClient:');
    expect(content).toContain('class WorkOSClient(_BaseWorkOSClient):');
    // Lazy resource accessors via cached_property
    expect(content).toContain('@functools.cached_property');
    expect(content).toContain('def organizations(self) -> Organizations:');
    expect(content).toContain('def request(');
    expect(content).toContain('def request_page(');
    expect(content).toContain('RETRY_STATUS_CODES');
    expect(content).toContain('Idempotency-Key');
    expect(content).toContain('def _parse_retry_after(');
    expect(content).toContain('def _calculate_retry_delay(');
    // P1-1: Async client
    expect(content).toContain('class AsyncWorkOSClient(_BaseWorkOSClient):');
    // P0-4: Context manager
    expect(content).toContain('def close(self)');
    expect(content).toContain('def __enter__');
    // P2-3: client_id
    expect(content).toContain('client_id: Optional[str] = None,');
    expect(content).toContain('request_timeout: Optional[int] = None,');
    expect(content).toContain('jwt_leeway: float = 0.0,');
    expect(content).toContain('WorkOS requires either an API key or a client ID.');
    expect(content).toContain('def _require_api_key(self) -> str:');
    expect(content).toContain('def _require_client_id(self) -> str:');
    expect(content).toContain('if self._api_key:');
    expect(content).not.toContain('WorkOS client ID must be provided when instantiating the client');
    expect(content).toContain('request_options.get("idempotency_key")');
    expect(content).toContain('request_options.get("max_retries")');
    expect(content).toContain('request_options.get("base_url")');
    expect(content).toContain('WORKOS_BASE_URL');
    expect(content).toContain('WORKOS_REQUEST_TIMEOUT');
    expect(content).toContain('request_url = str(request.url) if request is not None else None');
    expect(content).toContain('request_method = request.method if request is not None else None');
    expect(content).toContain('follow_redirects=True');
    // P3-4: Versioned User-Agent
    expect(content).toContain('workos-python/{VERSION}');
    expect(content).not.toContain('def directory_sync(self)');
    expect(content).not.toContain('def connect(self)');
    expect(content).not.toContain('def portal(self)');
    expect(content).not.toContain('def mfa(self)');
    expect(content).not.toContain('def fga(self)');
  });

  it('generates barrel __init__.py', () => {
    const files = generateClient(spec, ctx);

    const barrel = files.find((f) => f.path === 'src/workos/__init__.py');
    expect(barrel).toBeDefined();
    expect(barrel!.content).toContain('from ._client import AsyncWorkOSClient, WorkOSClient');
    expect(barrel!.content).toContain('from ._errors import');
    expect(barrel!.content).toContain('from ._pagination import AsyncPage, SyncPage');
    expect(barrel!.content).not.toContain('WorkOSListResource');
    expect(barrel!.content).toContain('"WorkOS"');
    expect(barrel!.content).toContain('"AsyncWorkOS"');
    expect(barrel!.content).toContain('"AuthorizationException"');
    expect(barrel!.content).toContain('"WorkOSConnectionException"');
    expect(barrel!.content).toContain('"WorkOSTimeoutException"');
    expect(barrel!.overwriteExisting).toBe(true);
  });

  it('generates service __init__.py', () => {
    const files = generateClient(spec, ctx);

    const serviceInit = files.find((f) => f.path === 'src/workos/organizations/__init__.py');
    expect(serviceInit).toBeDefined();
    expect(serviceInit!.content).toContain('from ._resource import Organizations, AsyncOrganizations');
  });

  it('generates nested directory structure for namespace sub-services', () => {
    const nestedSpec: ApiSpec = {
      ...spec,
      services: [
        ...services,
        {
          name: 'OrganizationsApiKeys',
          operations: [
            {
              name: 'listOrganizationApiKeys',
              httpMethod: 'get',
              path: '/organizations/api_keys',
              pathParams: [],
              queryParams: [],
              headerParams: [],
              response: { kind: 'model', name: 'Organization' },
              errors: [],
              injectIdempotencyKey: false,
            },
          ],
        },
      ],
    };

    const files = generateClient(nestedSpec, { ...ctx, spec: nestedSpec });

    // Sub-service lives directly in the nested directory
    const subServiceInit = files.find((f) => f.path === 'src/workos/organizations/api_keys/__init__.py');
    expect(subServiceInit).toBeDefined();
    // Should contain the resource re-export directly (not an alias to a flat dir)
    expect(subServiceInit!.content).toContain('from ._resource import OrganizationsApiKeys');

    // Client should import from the nested path
    const clientFile = files.find((f) => f.path === 'src/workos/_client.py');
    expect(clientFile!.content).toContain('from .organizations.api_keys._resource import OrganizationsApiKeys');
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
    expect(clientFile!.content).toContain('os.environ.get("WORKOS_BASE_URL", "https://api.workos.com")');
  });

  it('does not generate compat shim modules', () => {
    const files = generateClient(spec, ctx);

    expect(files.find((f) => f.path === 'src/workos/client.py')).toBeUndefined();
    expect(files.find((f) => f.path === 'src/workos/async_client.py')).toBeUndefined();
    expect(files.find((f) => f.path === 'src/workos/exceptions.py')).toBeUndefined();
  });

  it('does not generate user_management helper methods or types compat barrels', () => {
    const compatSpec: ApiSpec = {
      ...spec,
      services: [
        {
          name: 'UserManagementUsers',
          operations: [
            {
              name: 'listUsers',
              httpMethod: 'get',
              path: '/user_management/users',
              pathParams: [],
              queryParams: [],
              headerParams: [],
              response: { kind: 'model', name: 'Organization' },
              errors: [],
              injectIdempotencyKey: false,
            },
          ],
        },
        {
          name: 'UserManagementAuthentication',
          operations: [
            {
              name: 'authorize',
              httpMethod: 'get',
              path: '/user_management/authorize',
              pathParams: [],
              queryParams: [],
              headerParams: [],
              response: { kind: 'model', name: 'Organization' },
              errors: [],
              injectIdempotencyKey: false,
            },
          ],
        },
      ],
    };

    const files = generateClient(compatSpec, { ...ctx, spec: compatSpec });
    const clientFile = files.find((f) => f.path === 'src/workos/_client.py');
    expect(clientFile!.content).toContain('def load_sealed_session');
    expect(clientFile!.content).not.toContain('def get_authorization_url');
    expect(clientFile!.content).not.toContain('def get_user(');
    expect(clientFile!.content).not.toContain('def create_user(');

    const typesInit = files.find((f) => f.path === 'src/workos/types/user_management/__init__.py');
    expect(typesInit).toBeUndefined();
  });
});
