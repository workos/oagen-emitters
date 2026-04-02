import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateErrors } from '../../src/php/errors.js';

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
  it('generates base ApiException', () => {
    const result = generateErrors(ctx);
    const base = result.find((f) => f.path === 'lib/Exception/ApiException.php');
    expect(base).toBeDefined();
    expect(base!.content).toContain('class ApiException extends \\Exception');
    expect(base!.content).toContain('namespace WorkOS\\Exception;');
    expect(base!.content).toContain('$statusCode');
    expect(base!.content).toContain('$requestId');
    expect(base!.content).toContain('fromResponse');
  });

  it('generates all HTTP exception classes', () => {
    const result = generateErrors(ctx);
    const names = result.map((f) => f.path);

    expect(names).toContain('lib/Exception/BadRequestException.php');
    expect(names).toContain('lib/Exception/AuthenticationException.php');
    expect(names).toContain('lib/Exception/AuthorizationException.php');
    expect(names).toContain('lib/Exception/NotFoundException.php');
    expect(names).toContain('lib/Exception/ConflictException.php');
    expect(names).toContain('lib/Exception/UnprocessableEntityException.php');
    expect(names).toContain('lib/Exception/RateLimitExceededException.php');
    expect(names).toContain('lib/Exception/ServerException.php');
  });

  it('generates non-HTTP exceptions', () => {
    const result = generateErrors(ctx);
    const names = result.map((f) => f.path);

    expect(names).toContain('lib/Exception/ConfigurationException.php');
    expect(names).toContain('lib/Exception/ConnectionException.php');
    expect(names).toContain('lib/Exception/TimeoutException.php');
  });

  it('RateLimitExceededException has retryAfter property', () => {
    const result = generateErrors(ctx);
    const rateLimit = result.find((f) => f.path.includes('RateLimitExceededException'));
    expect(rateLimit!.content).toContain('$retryAfter');
  });

  it('HTTP exceptions extend BaseRequestException', () => {
    const result = generateErrors(ctx);
    const statusExceptions = result.filter(
      (f) =>
        f.path.includes('Exception/') &&
        !f.path.includes('ApiException') &&
        !f.path.includes('BaseRequestException') &&
        !f.path.includes('ConfigurationException') &&
        !f.path.includes('ConnectionException') &&
        !f.path.includes('TimeoutException') &&
        !f.path.includes('WorkOSException') &&
        !f.path.includes('GenericException') &&
        !f.path.includes('UnexpectedValueException'),
    );
    for (const ex of statusExceptions) {
      expect(ex.content).toContain('extends BaseRequestException');
    }
  });
});
