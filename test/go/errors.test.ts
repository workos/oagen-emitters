import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateErrors } from '../../src/go/errors.js';

const emptySpec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: '',
  services: [],
  models: [],
  enums: [],
  sdk: defaultSdkBehavior(),
};

const ctx: EmitterContext = {
  namespace: 'workos',
  namespacePascal: 'WorkOS',
  spec: emptySpec,
};

describe('go/errors', () => {
  it('generates error types file', () => {
    const files = generateErrors(ctx);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('errors.go');
    const content = files[0].content;
    expect(content).toContain('package workos');
    expect(content).toContain('type APIError struct {');
    expect(content).toContain('func (e *APIError) Error() string {');
    expect(content).toContain('type AuthenticationError struct {');
    expect(content).toContain('type NotFoundError struct {');
    expect(content).toContain('type RateLimitExceededError struct {');
    expect(content).toContain('type UnprocessableEntityError struct {');
    expect(content).toContain('type ServerError struct {');
    expect(content).toContain('type NetworkError struct {');
  });
});
