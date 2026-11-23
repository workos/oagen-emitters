import { describe, expect, it } from 'vitest';
import { generateResources } from '../../src/python/resources.js';
import {
  clientSecretContext,
  clientSecretServices,
  clientSecretUrlBuilderContext,
} from '../shared/client-secret-fixture.js';

function generate(): Record<string, string> {
  const files = generateResources(clientSecretServices, clientSecretContext());
  return Object.fromEntries(files.map((f) => [f.path, f.content]));
}

/** Number of non-overlapping occurrences of `needle`. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('python/client secret', () => {
  it('fills client_secret from the client accessor in a wrapper, sync and async', () => {
    const content = generate()['src/workos/user_management/_resource.py'];
    const block = [
      '        client_secret = self._client._client_secret("authenticate_with_password")',
      '        if client_secret is not None:',
      '            body["client_secret"] = client_secret',
    ].join('\n');

    expect(count(content, block)).toBe(2);
    expect(content).not.toContain('self._client._api_key');
    expect(content).not.toContain('_require_api_key');
    // client_id is still read directly.
    expect(content).toContain('        if self._client.client_id is not None:');
  });

  it('fills client_secret from the client accessor on an operation-level hint', () => {
    const content = generate()['src/workos/sso/_resource.py'];
    const block = [
      '        client_secret = self._client._client_secret("get_profile_and_token")',
      '        if client_secret is not None:',
      '            body["client_secret"] = client_secret',
    ].join('\n');

    expect(count(content, block)).toBe(2);
    expect(content).not.toContain('self._client._api_key');
    // The accessor runs before the request is made.
    expect(content.indexOf('self._client._client_secret(')).toBeLessThan(content.indexOf('self._client.request('));
  });

  it('does not call the accessor when the caller passed client_secret to a URL builder', () => {
    const { services, ctx } = clientSecretUrlBuilderContext();
    const content = generateResources(services, ctx)[0].content;

    expect(content).toContain(
      [
        '        if "client_secret" not in params:',
        '            client_secret = self._client._client_secret("get_authorization_url")',
        '            if client_secret is not None:',
        '                params["client_secret"] = client_secret',
      ].join('\n'),
    );
    expect(content).toContain('        if "client_id" not in params and self._client.client_id is not None:');
    expect(content).not.toContain('self._client._api_key');
  });
});
