import { describe, expect, it } from 'vitest';
import { defaultSdkBehavior, type ApiSpec, type EmitterContext, type Service } from '@workos/oagen';
import { generateWrapperMethods } from '../../src/kotlin/wrappers.js';
import { generateTests } from '../../src/kotlin/tests.js';
import { generateEnums } from '../../src/kotlin/enums.js';

// Regression: a required wrapper param that appears after optional params in
// the spec (e.g. pending_authentication_token after verification_id and
// phone_number in the Radar SMS challenge grant) must be sorted before the
// `= null` defaulted params, or positional callers — including the generated
// tests — cannot bind it (Kotlin: "No value passed for parameter ...").

const services: Service[] = [
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
        response: { kind: 'model', name: 'AuthenticateResponse' },
        errors: [],
        injectIdempotencyKey: false,
      },
    ],
  },
];

const spec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: 'https://api.workos.com',
  services,
  models: [
    {
      name: 'AuthenticateResponse',
      fields: [{ name: 'access_token', type: { kind: 'primitive', type: 'string' }, required: true }],
    },
    {
      name: 'RadarSmsChallengeAuthenticateRequest',
      fields: [
        { name: 'code', type: { kind: 'primitive', type: 'string' }, required: true },
        { name: 'verification_id', type: { kind: 'primitive', type: 'string' }, required: false },
        { name: 'phone_number', type: { kind: 'primitive', type: 'string' }, required: false },
        { name: 'pending_authentication_token', type: { kind: 'primitive', type: 'string' }, required: true },
      ],
    },
  ],
  enums: [],
  sdk: defaultSdkBehavior(),
};

const resolvedOp = {
  service: services[0],
  operation: services[0].operations[0],
  methodName: 'authenticate',
  mountOn: 'UserManagement',
  wrappers: [
    {
      name: 'authenticate_with_radar_sms_challenge',
      targetVariant: 'RadarSmsChallengeAuthenticateRequest',
      defaults: { grant_type: 'urn:workos:oauth:grant-type:radar-sms-challenge' },
      inferFromClient: ['client_id', 'client_secret'],
      exposedParams: ['code', 'verification_id', 'phone_number', 'pending_authentication_token'],
      responseModelName: 'AuthenticateResponse',
    },
  ],
} as never;

const ctx: EmitterContext = {
  namespace: 'workos',
  namespacePascal: 'WorkOS',
  spec,
  resolvedOperations: [resolvedOp],
};

describe('kotlin/wrappers', () => {
  it('sorts required wrapper params before optional defaulted params', () => {
    const lines = generateWrapperMethods(resolvedOp, ctx).join('\n');

    expect(lines).toContain(
      [
        '  fun authenticateWithRadarSmsChallenge(',
        '    code: String,',
        '    pendingAuthenticationToken: String,',
        '    verificationId: String? = null,',
        '    phoneNumber: String? = null,',
        '    requestOptions: RequestOptions? = null',
      ].join('\n'),
    );
  });

  it('generates wrapper test whose positional args match the sorted signature', () => {
    generateEnums([], ctx);
    const files = generateTests(spec, ctx);
    const testFile = files.find((f) => f.path.includes('UserManagementTest.kt'))!;

    // Two positional args bind the two required params (code,
    // pendingAuthenticationToken) now that they lead the signature.
    expect(testFile.content).toContain('api().authenticateWithRadarSmsChallenge("sample-arg", "sample-arg")');
  });
});
