import { describe, expect, it } from 'vitest';
import { generateResources } from '../../src/ruby/resources.js';
import {
  clientSecretContext,
  clientSecretServices,
  clientSecretUrlBuilderContext,
} from '../shared/client-secret-fixture.js';

function generate(): Record<string, string> {
  const files = generateResources(clientSecretServices, clientSecretContext());
  return Object.fromEntries(files.map((f) => [f.path, f.content]));
}

describe('ruby/client secret', () => {
  it('fills client_secret from the client accessor in a wrapper', () => {
    const content = generate()['lib/workos/user_management.rb'];

    expect(content).toContain("        'client_id' => @client.client_id,");
    expect(content).toContain("        'client_secret' => @client.client_secret('authenticate_with_password'),");
    expect(content).not.toContain('@client.api_key');
  });

  it('fills client_secret from the client accessor on an operation-level hint', () => {
    const content = generate()['lib/workos/sso.rb'];

    // A per-request api_key still wins, and then the accessor is not called.
    expect(content).toContain(
      "        'client_secret' => (request_options[:api_key] || @client.client_secret('get_profile_and_token')),",
    );
    expect(content).not.toContain('@client.api_key');
    // The accessor runs before the request is made.
    expect(content.indexOf('@client.client_secret(')).toBeLessThan(content.indexOf('@client.request('));
  });

  it('does not call the accessor when the caller passed client_secret to a URL builder', () => {
    const { services, ctx } = clientSecretUrlBuilderContext();
    const content = generateResources(services, ctx).find((f) => f.path === 'lib/workos/sso.rb')!.content;

    expect(content).toContain(
      [
        "      unless params.key?('client_secret')",
        "        client_secret = @client.client_secret('get_authorization_url')",
        "        params['client_secret'] = client_secret unless client_secret.nil?",
        '      end',
      ].join('\n'),
    );
    expect(content).toContain(
      "      params['client_id'] = @client.client_id if !params.key?('client_id') && !@client.client_id.nil?",
    );
    expect(content).not.toContain('@client.api_key');
  });

  it('resolves client_secret once in a URL builder that takes no override', () => {
    const { services, ctx } = clientSecretUrlBuilderContext();
    // Without the query parameters there is nothing for the caller to override.
    const bare = services.map((service) => ({
      ...service,
      operations: service.operations.map((op) => ({ ...op, queryParams: [] })),
    }));
    const bareCtx = {
      ...ctx,
      spec: { ...ctx.spec, services: bare },
      resolvedOperations: ctx.resolvedOperations!.map((r) => ({
        ...r,
        service: bare[0],
        operation: bare[0].operations[0],
      })) as never,
    };
    const content = generateResources(bare, bareCtx).find((f) => f.path === 'lib/workos/sso.rb')!.content;

    expect(content).toContain(
      [
        "      client_secret = @client.client_secret('get_authorization_url')",
        "      params['client_secret'] = client_secret unless client_secret.nil?",
      ].join('\n'),
    );
    expect(content).not.toContain("unless params.key?('client_secret')");
    expect(content).not.toContain('@client.api_key');
  });
});
