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
  it('generates client files for empty spec', () => {
    const spec = makeSpec([]);
    const files = generateClient(spec, makeCtx(spec));
    // Should produce: workos.go, client.go, pagination.go, go.mod
    expect(files.length).toBe(4);
    const paths = files.map((f) => f.path);
    expect(paths).toContain('workos.go');
    expect(paths).toContain('client.go');
    expect(paths).toContain('pagination.go');
    expect(paths).toContain('go.mod');
  });

  it('generates NewClient constructor', () => {
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
    expect(content).toContain('func NewClient(apiKey string, opts ...ClientOption) *Client {');
    expect(content).toContain('organizations *organizationsService');
    expect(content).toContain('func (c *Client) Organizations() *organizationsService {');
  });

  it('generates functional options', () => {
    const spec = makeSpec([]);
    const files = generateClient(spec, makeCtx(spec));
    const workosFile = files.find((f) => f.path === 'workos.go')!;
    const content = workosFile.content;

    expect(content).toContain('type ClientOption func(*Client)');
    expect(content).toContain('func WithBaseURL(url string) ClientOption {');
    expect(content).toContain('func WithHTTPClient(client *http.Client) ClientOption {');
    expect(content).toContain('func WithMaxRetries(n int) ClientOption {');
  });

  it('generates RequestOption type', () => {
    const spec = makeSpec([]);
    const files = generateClient(spec, makeCtx(spec));
    const workosFile = files.find((f) => f.path === 'workos.go')!;
    const content = workosFile.content;

    expect(content).toContain('type RequestOption func(*requestConfig)');
    expect(content).toContain('func WithExtraHeaders(h http.Header) RequestOption {');
    expect(content).toContain('func WithIdempotencyKey(key string) RequestOption {');
    expect(content).toContain('func WithTimeout(d time.Duration) RequestOption {');
  });

  it('generates client.go with retry logic', () => {
    const spec = makeSpec([]);
    const files = generateClient(spec, makeCtx(spec));
    const clientFile = files.find((f) => f.path === 'client.go')!;
    const content = clientFile.content;

    expect(content).toContain('func (c *Client) request(');
    expect(content).toContain('retryableStatuses');
    expect(content).toContain('func backoff(attempt int');
    expect(content).toContain('func parseAPIError(resp *http.Response) error {');
    expect(content).toContain('AuthenticationError');
    expect(content).toContain('RateLimitExceededError');
  });

  it('generates go.mod', () => {
    const spec = makeSpec([]);
    const files = generateClient(spec, makeCtx(spec));
    const goMod = files.find((f) => f.path === 'go.mod')!;

    expect(goMod.content).toContain('module github.com/workos/workos-go/v2');
    expect(goMod.content).toContain('go 1.22');
    expect(goMod.content).toContain('github.com/stretchr/testify');
  });

  it('generates pagination.go with Iterator', () => {
    const spec = makeSpec([]);
    const files = generateClient(spec, makeCtx(spec));
    const paginationFile = files.find((f) => f.path === 'pagination.go')!;
    const content = paginationFile.content;

    expect(content).toContain('type Iterator[T any] struct {');
    expect(content).toContain('func (it *Iterator[T]) Next() bool {');
    expect(content).toContain('func (it *Iterator[T]) Current() *T {');
    expect(content).toContain('func (it *Iterator[T]) Err() error {');
  });
});
