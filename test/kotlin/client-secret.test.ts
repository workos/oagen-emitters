import { describe, expect, it } from 'vitest';
import type { EmitterContext, Service } from '@workos/oagen';
import { generateResources } from '../../src/kotlin/resources.js';
import { clientSecretContext, clientSecretServices, clientSecretSpec } from '../shared/client-secret-fixture.js';

function generate(ctx: EmitterContext = clientSecretContext()): Record<string, string> {
  const files = generateResources(ctx.spec.services, ctx);
  return Object.fromEntries(files.map((f) => [f.path, f.content]));
}

describe('kotlin/client secret', () => {
  it('fills client_secret from the client accessor in the shared authenticate helper', () => {
    const content = generate()['src/main/kotlin/com/workos/usermanagement/UserManagement.kt'];

    // The helper takes the calling method's name and hands it to the accessor.
    expect(content).toContain(
      [
        '  private fun authenticate(',
        '    caller: String,',
        '    grantType: String,',
        '    requestOptions: RequestOptions?,',
        '    vararg entries: Pair<String, Any?>',
        '  ): AuthenticateResponse {',
      ].join('\n'),
    );
    expect(content).toContain('        "client_secret" to workos.clientSecret(caller)');
    expect(content).toContain(
      ['    return authenticate(', '      caller = "authenticateWithPassword",', '      grantType = "password",'].join(
        '\n',
      ),
    );
    expect(content).not.toContain('workos.apiKey');
  });

  it('fills client_secret from the client accessor on an operation-level hint', () => {
    const content = generate()['src/main/kotlin/com/workos/sso/SSO.kt'];

    expect(content).toContain('        "client_id" to workos.clientId,');
    expect(content).toContain('        "client_secret" to workos.clientSecret("getProfileAndToken")');
    expect(content).not.toContain('workos.apiKey');
  });

  it('fills client_secret from the client accessor in a wrapper that does not use the helper', () => {
    // Only /user_management/authenticate routes through the shared helper.
    const services: Service[] = [
      {
        ...clientSecretServices[0],
        operations: [{ ...clientSecretServices[0].operations[0], path: '/user_management/token' }],
      },
    ];
    const base = clientSecretContext();
    const ctx: EmitterContext = {
      ...base,
      spec: { ...clientSecretSpec, services },
      resolvedOperations: [
        { ...base.resolvedOperations![0], service: services[0], operation: services[0].operations[0] },
      ] as never,
    };
    const content = generate(ctx)['src/main/kotlin/com/workos/usermanagement/UserManagement.kt'];

    expect(content).toContain('        "client_secret" to workos.clientSecret("authenticateWithPassword")');
    expect(content).not.toContain('private fun authenticate(');
    expect(content).not.toContain('workos.apiKey');
  });

  it('fills an inferred client_secret query parameter from the client accessor', () => {
    const services: Service[] = [
      {
        name: 'SSO',
        operations: [
          {
            name: 'getProfile',
            httpMethod: 'get',
            path: '/sso/profile',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model', name: 'SSOTokenResponse' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];
    const ctx: EmitterContext = {
      ...clientSecretContext(),
      spec: { ...clientSecretSpec, services },
      resolvedOperations: [
        {
          service: services[0],
          operation: services[0].operations[0],
          methodName: 'get_profile',
          mountOn: 'SSO',
          inferFromClient: ['client_secret'],
        },
      ] as never,
    };
    const content = generate(ctx)['src/main/kotlin/com/workos/sso/SSO.kt'];

    expect(content).toContain('    workos.clientSecret("getProfile")?.let { params += "client_secret" to it }');
    expect(content).not.toContain('workos.apiKey');
  });
});
