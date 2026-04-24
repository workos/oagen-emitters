import { describe, it, expect } from 'vitest';
import { generateClient } from '../../src/python/client.js';
import type { EmitterContext, ApiSpec, Service, Model } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';

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
  sdk: defaultSdkBehavior(),
};

const ctx: EmitterContext = {
  namespace: 'workos',
  namespacePascal: 'WorkOS',
  spec,
};

describe('generateClient', () => {
  it('generates slim client that subclasses _base_client', () => {
    const files = generateClient(spec, ctx);

    const clientFile = files.find((f) => f.path === 'src/workos/_client.py');
    expect(clientFile).toBeDefined();

    const content = clientFile!.content;
    // Imports from _base_client
    expect(content).toContain('from ._base_client import');
    expect(content).toContain('WorkOSClient as _SyncBase');
    expect(content).toContain('AsyncWorkOSClient as _AsyncBase');
    // Subclass definitions
    expect(content).toContain('class WorkOSClient(_SyncBase):');
    expect(content).toContain('class AsyncWorkOSClient(_AsyncBase):');
    // Lazy resource accessors via cached_property
    expect(content).toContain('@functools.cached_property');
    expect(content).toContain('def organizations(self) -> Organizations:');
  });

  it('does not contain static HTTP infrastructure', () => {
    const files = generateClient(spec, ctx);
    const clientFile = files.find((f) => f.path === 'src/workos/_client.py');
    const content = clientFile!.content;

    // Static code should NOT be in the generated file
    expect(content).not.toContain('class _BaseWorkOSClient:');
    expect(content).not.toContain('def request(');
    expect(content).not.toContain('def request_page(');
    expect(content).not.toContain('RETRY_STATUS_CODES');
    expect(content).not.toContain('Idempotency-Key');
    expect(content).not.toContain('def _parse_retry_after(');
    expect(content).not.toContain('def _raise_error(');
    expect(content).not.toContain('def close(self)');
    expect(content).not.toContain('def __enter__');
    expect(content).not.toContain('import httpx');
  });

  it('does not generate barrel __init__.py (now @oagen-ignore-file)', () => {
    const files = generateClient(spec, ctx);
    const barrel = files.find((f) => f.path === 'src/workos/__init__.py');
    expect(barrel).toBeUndefined();
  });

  it('does not generate pyproject.toml or py.typed (now in target)', () => {
    const files = generateClient(spec, ctx);
    expect(files.find((f) => f.path === 'pyproject.toml')).toBeUndefined();
    expect(files.find((f) => f.path === 'src/workos/py.typed')).toBeUndefined();
  });

  it('generates service __init__.py', () => {
    const files = generateClient(spec, ctx);

    const serviceInit = files.find((f) => f.path === 'src/workos/organizations/__init__.py');
    expect(serviceInit).toBeDefined();
    expect(serviceInit!.content).toContain('from ._resource import Organizations, AsyncOrganizations');
  });

  it('generates flat directory structure for services (no nested namespaces)', () => {
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

    // Service gets its own flat directory (no nesting)
    const serviceInit = files.find((f) => f.path === 'src/workos/organizations_api_keys/__init__.py');
    expect(serviceInit).toBeDefined();

    // Client should import from the flat path
    const clientFile = files.find((f) => f.path === 'src/workos/_client.py');
    expect(clientFile!.content).toContain('OrganizationsApiKeys');
  });

  it('re-exports parameter group classes from service __init__.py', () => {
    const groupSpec: ApiSpec = {
      ...spec,
      services: [
        {
          name: 'UserManagement',
          operations: [
            {
              name: 'createOrganizationMembership',
              httpMethod: 'post',
              path: '/user_management/organization_memberships',
              pathParams: [],
              queryParams: [],
              headerParams: [],
              requestBody: { kind: 'model', name: 'CreateOrganizationMembershipRequest' },
              parameterGroups: [
                {
                  name: 'role',
                  optional: false,
                  variants: [
                    {
                      name: 'single',
                      parameters: [{ name: 'role_slug', type: { kind: 'primitive', type: 'string' }, required: true }],
                    },
                    {
                      name: 'multiple',
                      parameters: [
                        {
                          name: 'role_slugs',
                          type: { kind: 'array', items: { kind: 'primitive', type: 'string' } },
                          required: true,
                        },
                      ],
                    },
                  ],
                },
              ],
              response: { kind: 'model', name: 'Organization' },
              errors: [],
              injectIdempotencyKey: false,
            },
          ],
        },
      ],
    };

    const files = generateClient(groupSpec, { ...ctx, spec: groupSpec });
    const serviceInit = files.find((f) => f.path === 'src/workos/user_management/__init__.py');
    expect(serviceInit).toBeDefined();
    expect(serviceInit!.content).toContain('RoleSingle');
    expect(serviceInit!.content).toContain('RoleMultiple');
    expect(serviceInit!.content).toContain(
      'from ._resource import UserManagement, AsyncUserManagement, RoleSingle, RoleMultiple',
    );
  });

  it('does not generate compat shim modules', () => {
    const files = generateClient(spec, ctx);

    expect(files.find((f) => f.path === 'src/workos/client.py')).toBeUndefined();
    expect(files.find((f) => f.path === 'src/workos/async_client.py')).toBeUndefined();
    expect(files.find((f) => f.path === 'src/workos/exceptions.py')).toBeUndefined();
  });

  it('does not generate user_management helper methods but generates types barrels', () => {
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
    // load_sealed_session is now added via @oagen-ignore in the target SDK, not emitter-generated
    expect(clientFile!.content).not.toContain('def load_sealed_session');
    // Client has flat accessors, no methods from child services
    expect(clientFile!.content).not.toContain('def get_authorization_url');
    expect(clientFile!.content).not.toContain('def get_user(');
    expect(clientFile!.content).not.toContain('def create_user(');
  });
});
