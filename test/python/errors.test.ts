import { describe, it, expect } from 'vitest';
import { generateErrors } from '../../src/python/errors.js';
import type { EmitterContext, ApiSpec } from '@workos/oagen';

const emptySpec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: '',
  services: [],
  models: [],
  enums: [],
};

const ctx: EmitterContext = {
  namespace: 'workos',
  namespacePascal: 'WorkOS',
  spec: emptySpec,
};

describe('generateErrors', () => {
  it('generates error hierarchy', () => {
    const files = generateErrors(ctx);
    expect(files.length).toBe(1);
    expect(files[0].path).toBe('src/workos/_errors.py');

    const content = files[0].content;

    // Base error
    expect(content).toContain('class WorkOSError(Exception):');
    expect(content).toContain('self.status_code = status_code');
    expect(content).toContain('self.request_id = request_id');

    // Specific errors
    expect(content).toContain('class BadRequestError(WorkOSError):');
    expect(content).toContain('class AuthenticationError(WorkOSError):');
    expect(content).toContain('class ForbiddenError(WorkOSError):');
    expect(content).toContain('class NotFoundError(WorkOSError):');
    expect(content).toContain('class ConflictError(WorkOSError):');
    expect(content).toContain('class UnprocessableEntityError(WorkOSError):');
    expect(content).toContain('class RateLimitExceededError(WorkOSError):');
    expect(content).toContain('class ServerError(WorkOSError):');
    expect(content).toContain('class ConfigurationError(WorkOSError):');
    expect(content).toContain('class WorkOSConnectionError(WorkOSError):');
    expect(content).toContain('class WorkOSTimeoutError(WorkOSError):');

    // Status code mapping
    expect(content).toContain('STATUS_CODE_TO_ERROR');
    expect(content).toContain('400: BadRequestError');
    expect(content).toContain('403: ForbiddenError');
    expect(content).toContain('429: RateLimitExceededError');
  });

  it('marks files as overwriteExisting', () => {
    const files = generateErrors(ctx);
    expect(files[0].overwriteExisting).toBe(true);
    expect(files[0].integrateTarget).toBe(true);
  });
});
