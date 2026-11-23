import { defaultSdkBehavior, type ApiSpec, type EmitterContext, type Model, type Service } from '@workos/oagen';

/**
 * The two shapes in which an operation sends `client_secret` from client
 * config: a union-split wrapper (`authenticate_with_password`) and an
 * operation-level hint (`get_profile_and_token`). Each emitter's
 * client-secret test generates from this one fixture, so they all hold the
 * same guarantee: the secret comes from the client's accessor, never from a
 * direct read of the API key.
 */
const str = { kind: 'primitive', type: 'string' } as const;

export const clientSecretModels: Model[] = [
  { name: 'AuthenticateResponse', fields: [{ name: 'access_token', type: str, required: true }] },
  { name: 'SSOTokenResponse', fields: [{ name: 'access_token', type: str, required: true }] },
  {
    name: 'PasswordSessionAuthenticateRequest',
    fields: [
      { name: 'client_id', type: str, required: true },
      { name: 'client_secret', type: str, required: false },
      { name: 'grant_type', type: str, required: true },
      { name: 'email', type: str, required: true },
      { name: 'password', type: str, required: true },
    ],
  },
  {
    name: 'TokenQuery',
    fields: [
      { name: 'client_id', type: str, required: true },
      { name: 'client_secret', type: str, required: true },
      { name: 'grant_type', type: str, required: true },
      { name: 'code', type: str, required: false },
    ],
  },
];

export const clientSecretServices: Service[] = [
  {
    name: 'UserManagement',
    operations: [
      {
        name: 'authenticate',
        httpMethod: 'post',
        path: '/user_management/authenticate',
        pathParams: [],
        queryParams: [],
        headerParams: [],
        requestBody: { kind: 'model', name: 'PasswordSessionAuthenticateRequest' },
        response: { kind: 'model', name: 'AuthenticateResponse' },
        errors: [],
        injectIdempotencyKey: false,
      },
    ],
  },
  {
    name: 'SSO',
    operations: [
      {
        name: 'getProfileAndToken',
        httpMethod: 'post',
        path: '/sso/token',
        pathParams: [],
        queryParams: [],
        headerParams: [],
        requestBody: { kind: 'model', name: 'TokenQuery' },
        response: { kind: 'model', name: 'SSOTokenResponse' },
        errors: [],
        injectIdempotencyKey: false,
      },
    ],
  },
];

export const clientSecretSpec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: 'https://api.workos.com',
  services: clientSecretServices,
  models: clientSecretModels,
  enums: [],
  sdk: defaultSdkBehavior(),
};

/** Resolved operations carrying the `inferFromClient` hints under test. */
export const clientSecretResolvedOperations = [
  {
    service: clientSecretServices[0],
    operation: clientSecretServices[0].operations[0],
    methodName: 'authenticate',
    mountOn: 'UserManagement',
    wrappers: [
      {
        name: 'authenticate_with_password',
        targetVariant: 'PasswordSessionAuthenticateRequest',
        defaults: { grant_type: 'password' },
        inferFromClient: ['client_id', 'client_secret'],
        exposedParams: ['email', 'password'],
        optionalParams: [],
        responseModelName: 'AuthenticateResponse',
      },
    ],
  },
  {
    service: clientSecretServices[1],
    operation: clientSecretServices[1].operations[0],
    methodName: 'get_profile_and_token',
    mountOn: 'SSO',
    defaults: { grant_type: 'authorization_code' },
    inferFromClient: ['client_id', 'client_secret'],
  },
] as never as NonNullable<EmitterContext['resolvedOperations']>;

/** Emitter context for the fixture. `namespacePascal` differs per language. */
export function clientSecretContext(namespacePascal = 'WorkOS'): EmitterContext {
  return {
    namespace: 'workos',
    namespacePascal,
    spec: clientSecretSpec,
    resolvedOperations: clientSecretResolvedOperations,
  };
}

/**
 * A URL builder that infers `client_secret` into its query string. No spec
 * operation does this today; it exercises the query-string emission path.
 */
export function clientSecretUrlBuilderContext(namespacePascal = 'WorkOS'): {
  services: Service[];
  ctx: EmitterContext;
} {
  const services: Service[] = [
    {
      name: 'SSO',
      operations: [
        {
          name: 'getAuthorizationUrl',
          httpMethod: 'get',
          path: '/sso/authorize',
          pathParams: [],
          queryParams: [
            { name: 'client_id', type: str, required: true },
            { name: 'client_secret', type: str, required: true },
            { name: 'redirect_uri', type: str, required: true },
          ],
          headerParams: [],
          response: { kind: 'primitive', type: 'unknown' },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    },
  ];
  const ctx: EmitterContext = {
    namespace: 'workos',
    namespacePascal,
    spec: { ...clientSecretSpec, services, models: [] },
    resolvedOperations: [
      {
        service: services[0],
        operation: services[0].operations[0],
        methodName: 'get_authorization_url',
        mountOn: 'SSO',
        inferFromClient: ['client_id', 'client_secret'],
        urlBuilder: true,
      },
    ] as never,
  };
  return { services, ctx };
}
