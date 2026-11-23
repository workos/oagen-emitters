import { describe, expect, it } from 'vitest';
import { generateResources } from '../../src/dotnet/resources.js';
import { primeEnumAliases } from '../../src/dotnet/enums.js';
import {
  clientSecretContext,
  clientSecretServices,
  clientSecretUrlBuilderContext,
} from '../shared/client-secret-fixture.js';

function generate(): Record<string, string> {
  primeEnumAliases([]);
  const files = generateResources(clientSecretServices, clientSecretContext());
  return Object.fromEntries(files.map((f) => [f.path, f.content]));
}

describe('dotnet/client secret', () => {
  it('fills ClientSecret from the client accessor in a wrapper', () => {
    const content = generate()['Services/UserManagement/UserManagementService.cs'];

    expect(content).toContain(
      [
        '            options.GrantType = "password";',
        '            options.ClientId = this.Client.RequireClientId();',
        '            options.ClientSecret = this.Client.GetClientSecret();',
        '            return await this.PostAsync<AuthenticateResponse>("/user_management/authenticate"',
      ].join('\n'),
    );
    expect(content).not.toContain('this.Client.ApiKey');
  });

  it('fills ClientSecret from the client accessor on an operation-level hint', () => {
    const content = generate()['Services/SSO/SSOService.cs'];

    expect(content).toContain(
      [
        '            options.ClientId = this.Client.RequireClientId();',
        '            options.ClientSecret = this.Client.GetClientSecret();',
        '            return await this.PostAsync<SSOTokenResponse>("/sso/token"',
      ].join('\n'),
    );
    expect(content).not.toContain('this.Client.ApiKey');
  });

  it('fills ClientSecret from the client accessor in a URL builder', () => {
    primeEnumAliases([]);
    const { services, ctx } = clientSecretUrlBuilderContext();
    const content = generateResources(services, ctx).find((f) => f.path === 'Services/SSO/SSOService.cs')!.content;

    expect(content).toContain('            options.ClientSecret = this.Client.GetClientSecret();');
    expect(content).not.toContain('this.Client.ApiKey');
  });
});
