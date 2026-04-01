import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec } from '@workos/oagen';
import { generateErrors } from '../../src/php/errors.js';

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
  it('generates base ApiException', () => {
    const result = generateErrors(ctx);
    const base = result.find((f) => f.path === 'src/Exceptions/ApiException.php');
    expect(base).toBeDefined();
    expect(base!.content).toContain('class ApiException extends \\Exception');
    expect(base!.content).toContain('namespace WorkOS\\Exceptions;');
    expect(base!.content).toContain('$statusCode');
    expect(base!.content).toContain('$requestId');
    expect(base!.content).toContain('fromResponse');
  });

  it('generates all HTTP exception classes', () => {
    const result = generateErrors(ctx);
    const names = result.map((f) => f.path);

    expect(names).toContain('src/Exceptions/BadRequestException.php');
    expect(names).toContain('src/Exceptions/AuthenticationException.php');
    expect(names).toContain('src/Exceptions/AuthorizationException.php');
    expect(names).toContain('src/Exceptions/NotFoundException.php');
    expect(names).toContain('src/Exceptions/ConflictException.php');
    expect(names).toContain('src/Exceptions/UnprocessableEntityException.php');
    expect(names).toContain('src/Exceptions/RateLimitExceededException.php');
    expect(names).toContain('src/Exceptions/ServerException.php');
  });

  it('generates non-HTTP exceptions', () => {
    const result = generateErrors(ctx);
    const names = result.map((f) => f.path);

    expect(names).toContain('src/Exceptions/ConfigurationException.php');
    expect(names).toContain('src/Exceptions/ConnectionException.php');
    expect(names).toContain('src/Exceptions/TimeoutException.php');
  });

  it('RateLimitExceededException has retryAfter property', () => {
    const result = generateErrors(ctx);
    const rateLimit = result.find((f) => f.path.includes('RateLimitExceededException'));
    expect(rateLimit!.content).toContain('$retryAfter');
  });

  it('all exceptions extend ApiException', () => {
    const result = generateErrors(ctx);
    const httpExceptions = result.filter(
      (f) =>
        f.path.includes('Exceptions/') &&
        !f.path.includes('ApiException') &&
        !f.path.includes('ConfigurationException') &&
        !f.path.includes('ConnectionException') &&
        !f.path.includes('TimeoutException'),
    );
    for (const ex of httpExceptions) {
      expect(ex.content).toContain('extends ApiException');
    }
  });
});
