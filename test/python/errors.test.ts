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
    expect(content).toContain('class BaseRequestException(Exception):');
    expect(content).toContain('self.status_code = status_code');
    expect(content).toContain('self.request_id = request_id');

    // Specific errors
    expect(content).toContain('class BadRequestException(BaseRequestException):');
    expect(content).toContain('class AuthenticationException(BaseRequestException):');
    expect(content).toContain('class AuthorizationException(BaseRequestException):');
    expect(content).toContain('class NotFoundException(BaseRequestException):');
    expect(content).toContain('class ConflictException(BaseRequestException):');
    expect(content).toContain('class UnprocessableEntityException(BaseRequestException):');
    expect(content).toContain('class RateLimitExceededException(BaseRequestException):');
    expect(content).toContain('class ServerException(BaseRequestException):');
    expect(content).toContain('class ConfigurationException(BaseRequestException):');
    expect(content).toContain('class WorkOSConnectionException(BaseRequestException):');
    expect(content).toContain('class WorkOSTimeoutException(BaseRequestException):');
    expect(content).toContain('class EmailVerificationRequiredException(AuthorizationException):');

    // Status code mapping
    expect(content).toContain('STATUS_CODE_TO_EXCEPTION');
    expect(content).toContain('400: BadRequestException');
    expect(content).toContain('403: AuthorizationException');
    expect(content).toContain('429: RateLimitExceededException');
  });

  it('marks files as overwriteExisting', () => {
    const files = generateErrors(ctx);
    expect(files[0].overwriteExisting).toBe(true);
    expect(files[0].integrateTarget).toBe(true);
  });
});
