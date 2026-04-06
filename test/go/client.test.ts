import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Service } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateClient } from '../../src/go/client.js';

function makeSpec(services: Service[]): ApiSpec {
  return {
    name: 'Test',
    version: '1.0.0',
    baseUrl: 'https://api.workos.com',
    services,
    models: [],
    enums: [],
    sdk: defaultSdkBehavior(),
  };
}

function makeCtx(spec: ApiSpec): EmitterContext {
  return {
    namespace: 'workos',
    namespacePascal: 'WorkOS',
    spec,
  };
}

describe('go/client', () => {
  it('generates only workos.go', () => {
    const spec = makeSpec([]);
    const files = generateClient(spec, makeCtx(spec));
    expect(files.length).toBe(1);
    expect(files[0].path).toBe('workos.go');
  });

  it('generates Client struct with service fields', () => {
    const spec = makeSpec([
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
    ]);
    const files = generateClient(spec, makeCtx(spec));
    const workosFile = files.find((f) => f.path === 'workos.go')!;
    const content = workosFile.content;

    expect(content).toContain('package workos');
    expect(content).toContain('organizations *organizationService');
    expect(content).toContain('func NewClient(apiKey string, opts ...ClientOption) *Client {');
    expect(content).toContain('func (c *Client) Organizations() *organizationService {');
  });

  it('does not emit static options or HTTP infrastructure', () => {
    const spec = makeSpec([]);
    const files = generateClient(spec, makeCtx(spec));
    const workosFile = files.find((f) => f.path === 'workos.go')!;
    const content = workosFile.content;

    // These definitions are now in hand-maintained options.go
    expect(content).not.toContain('type ClientOption func(*Client)');
    expect(content).not.toContain('func WithBaseURL');
    expect(content).not.toContain('type RequestOption');
    expect(content).not.toContain('type requestConfig struct');
    // Constants are defined in options.go, but referenced in NewClient
    expect(content).not.toContain('defaultBaseURL    =');
  });

  it('uses acronym-aware service accessors and fields', () => {
    const spec = makeSpec([
      { name: 'ApiKeys', operations: [] },
      { name: 'SSO', operations: [] },
    ]);
    const files = generateClient(spec, makeCtx(spec));
    const workosFile = files.find((f) => f.path === 'workos.go')!;
    const content = workosFile.content;

    expect(content).toContain('apiKeys *apiKeyService');
    expect(content).toContain('sso *ssoService');
    expect(content).toContain('func (c *Client) APIKeys() *apiKeyService {');
    expect(content).toContain('func (c *Client) SSO() *ssoService {');
  });
});
