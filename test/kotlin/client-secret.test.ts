import { describe, expect, it } from 'vitest';
import type { EmitterContext, Service } from '@workos/oagen';
import { generateResources } from '../../src/kotlin/resources.js';
import { clientSecretContext, clientSecretServices, clientSecretSpec } from '../shared/client-secret-fixture.js';

const ACCESSOR_IMPORT = 'import com.workos.clientSecret';

function generate(ctx: EmitterContext = clientSecretContext()): Record<string, string> {
  const files = generateResources(ctx.spec.services, ctx);
  return Object.fromEntries(files.map((f) => [f.path, f.content]));
}

/** The `import` lines of a generated Kotlin file, in file order. */
function importsOf(content: string): string[] {
  return content.split('\n').filter((line) => line.startsWith('import '));
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
    expect(importsOf(content)).toContain(ACCESSOR_IMPORT);
  });

  it('imports the accessor, an extension function in com.workos, where it is called', () => {
    // The generated class is in a service package, and Kotlin resolves an
    // extension function from another package only through an import.
    const content = generate()['src/main/kotlin/com/workos/sso/SSO.kt'];

    expect(content).toContain('package com.workos.sso');
    const imports = importsOf(content);
    expect(imports.filter((line) => line === ACCESSOR_IMPORT)).toHaveLength(1);
    // Sorted with the rest, as the SDK's lint requires.
    expect(imports).toEqual([...imports].sort());
    expect(imports.indexOf('import com.workos.WorkOS')).toBeLessThan(imports.indexOf(ACCESSOR_IMPORT));
    expect(imports.indexOf(ACCESSOR_IMPORT)).toBeLessThan(imports.indexOf('import com.workos.common.http.bodyOf'));
  });

  it('does not import the accessor into a class that never calls it', () => {
    // No inferred client_secret, but a body field and so a parameter named
    // `clientSecret`: the bare name is not a call, and an unused import fails
    // the SDK's lint.
    const base = clientSecretContext();
    const ctx: EmitterContext = {
      ...base,
      resolvedOperations: base.resolvedOperations!.map((r) => ({
        ...r,
        defaults: undefined,
        inferFromClient: undefined,
        wrappers: undefined,
      })) as never,
    };
    const content = generate(ctx)['src/main/kotlin/com/workos/sso/SSO.kt'];

    expect(content).toContain('    clientSecret: String,');
    expect(content).toContain('"client_secret" to clientSecret');
    expect(content).not.toContain('workos.clientSecret(');
    expect(importsOf(content)).not.toContain(ACCESSOR_IMPORT);
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
    expect(importsOf(content)).toContain(ACCESSOR_IMPORT);
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
    expect(importsOf(content)).toContain(ACCESSOR_IMPORT);
  });
});
