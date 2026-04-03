import { describe, it, expect } from 'vitest';
import { generateErrors } from '../../src/python/errors.js';
import type { EmitterContext, ApiSpec } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';

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

describe('generateErrors', () => {
  it('generates error hierarchy', () => {
    const files = generateErrors(ctx);
    expect(files.length).toBe(2);
    expect(files[0].path).toBe('src/workos/_errors.py');

    const content = files[0].content;

    // Base error + API error
    expect(content).toContain('class WorkOSError(Exception):');
    expect(content).toContain('class APIError(WorkOSError):');
    expect(content).toContain('self.status_code = status_code');
    expect(content).toContain('self.request_id = request_id');

    // HTTP errors inherit from APIError
    expect(content).toContain('class BadRequestError(APIError):');
    expect(content).toContain('class AuthenticationError(APIError):');
    expect(content).toContain('class AuthorizationError(APIError):');
    expect(content).toContain('class NotFoundError(APIError):');
    expect(content).toContain('class ConflictError(APIError):');
    expect(content).toContain('class UnprocessableEntityError(APIError):');
    expect(content).toContain('class RateLimitExceededError(APIError):');
    expect(content).toContain('class ServerError(APIError):');

    // Non-HTTP errors inherit from WorkOSError
    expect(content).toContain('class ConfigurationError(WorkOSError):');
    expect(content).toContain('class WorkOSConnectionError(WorkOSError):');
    expect(content).toContain('class WorkOSTimeoutError(WorkOSError):');
    expect(content).toContain('class EmailVerificationRequiredError(AuthorizationError):');

    // Status code mapping
    expect(content).toContain('STATUS_CODE_TO_ERROR');
    expect(content).toContain('400: BadRequestError');
    expect(content).toContain('403: AuthorizationError');
    expect(content).toContain('429: RateLimitExceededError');

    // Backwards-compatible aliases
    expect(content).toContain('BaseRequestException = WorkOSError');
    expect(content).toContain('BadRequestException = BadRequestError');
  });

  it('generates exceptions.py re-export module', () => {
    const files = generateErrors(ctx);
    const exceptionsFile = files.find((f) => f.path === 'src/workos/exceptions.py');
    expect(exceptionsFile).toBeDefined();
    expect(exceptionsFile!.integrateTarget).toBe(true);
    expect(exceptionsFile!.overwriteExisting).toBe(true);

    const content = exceptionsFile!.content;
    expect(content).toContain('from ._errors import (');
    expect(content).toContain('WorkOSError as WorkOSError');
    expect(content).toContain('APIError as APIError');
    expect(content).toContain('AuthenticationError as AuthenticationError');
    expect(content).toContain('ServerError as ServerError');
    expect(content).toContain('STATUS_CODE_TO_ERROR as STATUS_CODE_TO_ERROR');
    // Backwards-compat aliases are also re-exported
    expect(content).toContain('BaseRequestException as BaseRequestException');
    expect(content).toContain('STATUS_CODE_TO_EXCEPTION as STATUS_CODE_TO_EXCEPTION');
  });

  it('marks files as overwriteExisting', () => {
    const files = generateErrors(ctx);
    expect(files[0].overwriteExisting).toBe(true);
    expect(files[0].integrateTarget).toBe(true);
  });
});
