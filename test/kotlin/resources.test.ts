import { describe, expect, it } from 'vitest';
import { defaultSdkBehavior, type ApiSpec, type EmitterContext, type Service } from '@workos/oagen';
import { generateResources } from '../../src/kotlin/resources.js';
import { generateEnums } from '../../src/kotlin/enums.js';

const baseSpec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: 'https://api.workos.com',
  services: [],
  models: [
    {
      name: 'AuthenticateResponse',
      fields: [{ name: 'access_token', type: { kind: 'primitive', type: 'string' }, required: true }],
    },
    {
      name: 'SSOTokenResponse',
      fields: [{ name: 'access_token', type: { kind: 'primitive', type: 'string' }, required: true }],
    },
  ],
  enums: [],
  sdk: defaultSdkBehavior(),
};

function ctxFor(services: Service[], enums = baseSpec.enums): EmitterContext {
  return {
    namespace: 'workos',
    namespacePascal: 'WorkOS',
    spec: { ...baseSpec, services, enums },
    resolvedOperations: services.flatMap((service) =>
      service.operations.map((operation) => ({
        service,
        operation,
        methodName: operation.name,
        mountOn: service.name,
        defaults: {},
        inferFromClient: [],
        urlBuilder: false,
      })),
    ),
  };
}

describe('kotlin/resources', () => {
  it('wraps every path-template interpolation in encodePathSegment', () => {
    const services: Service[] = [
      {
        name: 'Users',
        operations: [
          {
            name: 'getUser',
            httpMethod: 'get',
            path: '/users/{id}/groups/{groupId}',
            pathParams: [
              { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
              { name: 'groupId', type: { kind: 'primitive', type: 'string' }, required: true },
            ],
            queryParams: [],
            headerParams: [],
            response: { kind: 'primitive', type: 'unknown' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];
    const files = generateResources(services, ctxFor(services));
    const file = files.find((f) => f.path.endsWith('/Users.kt'))!;
    expect(file.content).toContain('import com.workos.common.http.encodePathSegment');
    expect(file.content).toContain('path = "/users/${encodePathSegment(id)}/groups/${encodePathSegment(groupId)}"');
    expect(file.content).not.toMatch(/path = "[^"]*\$id[^{]/);
  });

  it('collapses duplicated query/body params into a single Kotlin parameter', () => {
    const services: Service[] = [
      {
        name: 'SSO',
        operations: [
          {
            name: 'getProfileAndToken',
            httpMethod: 'post',
            path: '/sso/token',
            pathParams: [],
            queryParams: [{ name: 'code', type: { kind: 'primitive', type: 'string' }, required: true }],
            headerParams: [],
            requestBody: { kind: 'model', name: 'GetProfileAndTokenRequest' },
            response: { kind: 'model', name: 'SSOTokenResponse' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];
    const spec = {
      ...baseSpec,
      services,
      models: [
        ...baseSpec.models,
        {
          name: 'GetProfileAndTokenRequest',
          fields: [{ name: 'code', type: { kind: 'primitive', type: 'string' }, required: true }],
        },
      ],
    };
    const files = generateResources(services, { ...ctxFor(services), spec: spec as ApiSpec });
    const ssoFile = files.find((file) => file.path.endsWith('/SSO.kt'));
    expect(ssoFile).toBeDefined();
    expect(ssoFile!.content).toContain('fun getProfileAndToken(');
    expect(ssoFile!.content).toContain('code: String');
    expect(ssoFile!.content).not.toContain('bodyCode');
    expect(ssoFile!.content).toContain('params += "code" to code');
    expect(ssoFile!.content).toContain('"code" to code');
  });

  it('emits a shared authenticate helper for user management authenticate variants', () => {
    const services: Service[] = [
      {
        name: 'UserManagement',
        operations: [
          {
            name: 'authenticateWithPassword',
            httpMethod: 'post',
            path: '/user_management/authenticate',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            requestBody: { kind: 'model', name: 'AuthenticatePasswordRequest' },
            response: { kind: 'model', name: 'AuthenticateResponse' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];
    const spec = {
      ...baseSpec,
      services,
      models: [
        ...baseSpec.models,
        {
          name: 'AuthenticatePasswordRequest',
          fields: [
            { name: 'email', type: { kind: 'primitive', type: 'string' }, required: true },
            { name: 'password', type: { kind: 'primitive', type: 'string' }, required: true },
          ],
        },
      ],
    };
    const files = generateResources(services, { ...ctxFor(services), spec: spec as ApiSpec });
    const userManagementFile = files.find((file) => file.path.endsWith('/UserManagement.kt'));
    expect(userManagementFile).toBeDefined();
    expect(userManagementFile!.content).toContain('private fun authenticate(');
    expect(userManagementFile!.content).toContain('grantType = "authorization_code"');
  });

  it('renames package-level parameter group helpers to avoid Role/Password collisions', () => {
    const services: Service[] = [
      {
        name: 'UserManagement',
        operations: [
          {
            name: 'createUser',
            httpMethod: 'post',
            path: '/users',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            requestBody: { kind: 'model', name: 'CreateUserRequest' },
            response: { kind: 'model', name: 'AuthenticateResponse' },
            errors: [],
            injectIdempotencyKey: false,
            parameterGroups: [
              {
                name: 'Password',
                optional: true,
                variants: [
                  {
                    name: 'Plaintext',
                    parameters: [{ name: 'password', type: { kind: 'primitive', type: 'string' }, required: true }],
                  },
                ],
              },
              {
                name: 'Role',
                optional: true,
                variants: [
                  {
                    name: 'Single',
                    parameters: [{ name: 'role_slug', type: { kind: 'primitive', type: 'string' }, required: true }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];
    const spec = {
      ...baseSpec,
      services,
      models: [
        ...baseSpec.models,
        {
          name: 'CreateUserRequest',
          fields: [
            { name: 'password', type: { kind: 'primitive', type: 'string' }, required: false },
            { name: 'role_slug', type: { kind: 'primitive', type: 'string' }, required: false },
          ],
        },
      ],
    };
    const files = generateResources(services, { ...ctxFor(services), spec: spec as ApiSpec });
    const userManagementFile = files.find((file) => file.path.endsWith('/UserManagement.kt'));
    expect(userManagementFile).toBeDefined();
    expect(userManagementFile!.content).toContain('sealed class CreateUserPassword');
    expect(userManagementFile!.content).toContain('sealed class CreateUserRole');
  });

  it('collapses asc/desc order enums into SortOrder', () => {
    const enums = [
      {
        name: 'EventsOrder',
        values: [{ value: 'asc' }, { value: 'desc' }],
      },
      {
        name: 'OrganizationsOrder',
        values: [{ value: 'asc' }, { value: 'desc' }],
      },
    ];

    const files = generateEnums(enums as never, ctxFor([], enums as never));
    const sortOrder = files.find((file) => file.path.endsWith('/SortOrder.kt'));
    const aliases = files.filter((file) => file.path.endsWith('Order.kt') && !file.path.endsWith('/SortOrder.kt'));

    expect(sortOrder).toBeDefined();
    expect(sortOrder!.content).toContain('enum class SortOrder');
    expect(aliases.length).toBeLessThanOrEqual(1);
  });

  it('emits a coroutine-friendly suspend overload alongside every blocking method', () => {
    const services: Service[] = [
      {
        name: 'Users',
        operations: [
          {
            name: 'getUser',
            httpMethod: 'get',
            path: '/users/{id}',
            pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
            queryParams: [],
            headerParams: [],
            response: { kind: 'primitive', type: 'unknown' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];
    const files = generateResources(services, ctxFor(services));
    const file = files.find((f) => f.path.endsWith('/Users.kt'))!;
    expect(file.content).toContain('import kotlinx.coroutines.Dispatchers');
    expect(file.content).toContain('import kotlinx.coroutines.withContext');
    expect(file.content).toContain('@JvmName("getSuspend")');
    expect(file.content).toMatch(/suspend fun getSuspend\([\s\S]*?withContext\(Dispatchers\.IO\)/);
  });

  it('emits Java-friendly per-variant overloads for sealed-class parameter groups', () => {
    const services: Service[] = [
      {
        name: 'Authorization',
        operations: [
          {
            name: 'check',
            httpMethod: 'post',
            path: '/authorization/check',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            requestBody: { kind: 'model', name: 'CheckRequest' },
            response: { kind: 'primitive', type: 'unknown' },
            errors: [],
            injectIdempotencyKey: false,
            parameterGroups: [
              {
                name: 'resource_target',
                optional: false,
                variants: [
                  {
                    name: 'ById',
                    parameters: [{ name: 'resource_id', type: { kind: 'primitive', type: 'string' }, required: true }],
                  },
                  {
                    name: 'ByExternalId',
                    parameters: [
                      { name: 'resource_external_id', type: { kind: 'primitive', type: 'string' }, required: true },
                      { name: 'resource_type_slug', type: { kind: 'primitive', type: 'string' }, required: true },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];
    const spec = {
      ...baseSpec,
      services,
      models: [
        ...baseSpec.models,
        {
          name: 'CheckRequest',
          fields: [],
        },
      ],
    };
    const files = generateResources(services, { ...ctxFor(services), spec: spec as ApiSpec });
    const file = files.find((f) => f.path.endsWith('/Authorization.kt'))!;
    // The canonical method still takes the sealed class.
    expect(file.content).toMatch(/fun check\([\s\S]*?resourceTarget: ResourceTarget[\s\S]*?\)/);
    // Java-friendly ById overload — keeps the base method name and takes the
    // flat resource_id field.
    expect(file.content).toMatch(/fun check\([\s\S]*?resourceId: String[\s\S]*?\) = check\(/);
    // Java-friendly ByExternalId overload — uses the variant suffix.
    expect(file.content).toMatch(/fun checkByExternalId\([\s\S]*?resourceExternalId: String/);
    expect(file.content).toContain('ResourceTarget.ById(resourceId = resourceId)');
    expect(file.content).toContain('Java-friendly overload');
    // The sealed class itself carries Kotlin + Java construction examples.
    expect(file.content).toContain('Usage from Kotlin:');
    expect(file.content).toContain('Usage from Java:');
  });
});
