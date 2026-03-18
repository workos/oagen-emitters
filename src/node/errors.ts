import type { GeneratedFile } from "@workos/oagen";

export function generateErrors(): GeneratedFile[] {
  return [
    {
      path: "src/common/exceptions/bad-request.exception.ts",
      content: `export class BadRequestException extends Error {
  readonly status = 400;
  readonly name = 'BadRequestException';
  readonly requestID: string;
  readonly code?: string;

  constructor({
    code,
    message,
    requestID,
  }: {
    code?: string;
    message?: string;
    requestID: string;
  }) {
    super();
    this.message = message ?? 'Bad request';
    this.requestID = requestID;
    if (code) this.code = code;
  }
}`,
      skipIfExists: true,
    },
    {
      path: "src/common/exceptions/unauthorized.exception.ts",
      content: `export class UnauthorizedException extends Error {
  readonly status = 401;
  readonly name = 'UnauthorizedException';
  readonly requestID: string;

  constructor(requestID: string) {
    super();
    this.message = 'Unauthorized';
    this.requestID = requestID;
  }
}`,
      skipIfExists: true,
    },
    {
      path: "src/common/exceptions/not-found.exception.ts",
      content: `export class NotFoundException extends Error {
  readonly status = 404;
  readonly name = 'NotFoundException';
  readonly requestID: string;
  readonly code?: string;

  constructor({
    code,
    message,
    path,
    requestID,
  }: {
    code?: string;
    message?: string;
    path: string;
    requestID: string;
  }) {
    super();
    this.message =
      message ?? \`The requested path '\${path}' could not be found.\`;
    this.requestID = requestID;
    if (code) this.code = code;
  }
}`,
      skipIfExists: true,
    },
    {
      path: "src/common/exceptions/conflict.exception.ts",
      content: `export class ConflictException extends Error {
  readonly status = 409;
  readonly name = 'ConflictException';
  readonly requestID: string;

  constructor({
    message,
    requestID,
  }: {
    message?: string;
    error?: string;
    requestID: string;
  }) {
    super();
    this.message = message ?? 'Conflict';
    this.requestID = requestID;
  }
}`,
      skipIfExists: true,
    },
    {
      path: "src/common/exceptions/unprocessable-entity.exception.ts",
      content: `export interface UnprocessableEntityError {
  code: string;
}

export class UnprocessableEntityException extends Error {
  readonly status = 422;
  readonly name = 'UnprocessableEntityException';
  readonly requestID: string;
  readonly code?: string;

  constructor({
    code,
    errors,
    message,
    requestID,
  }: {
    code?: string;
    errors?: UnprocessableEntityError[];
    message?: string;
    requestID: string;
  }) {
    super();
    this.requestID = requestID;
    this.message = message ?? 'Unprocessable entity';
    if (code) this.code = code;
    if (errors) {
      const requirement =
        errors.length === 1 ? 'requirement' : 'requirements';
      this.message = \`The following \${requirement} must be met:\\n\`;
      for (const { code: errCode } of errors) {
        this.message = this.message.concat(\`\\t\${errCode}\\n\`);
      }
    }
  }
}`,
      skipIfExists: true,
    },
    {
      path: "src/common/exceptions/rate-limit-exceeded.exception.ts",
      content: `export class RateLimitExceededException extends Error {
  readonly status = 429;
  readonly name = 'RateLimitExceededException';
  readonly requestID: string;
  readonly retryAfter?: number;

  constructor(message: string, requestID: string, retryAfter?: number) {
    super();
    this.message = message ?? 'Too many requests';
    this.requestID = requestID;
    this.retryAfter = retryAfter;
  }
}`,
      skipIfExists: true,
    },
    {
      path: "src/common/exceptions/generic-server.exception.ts",
      content: `export class GenericServerException extends Error {
  readonly status: number;
  readonly name = 'GenericServerException';
  readonly requestID: string;

  constructor(status: number, message: string, requestID: string) {
    super();
    this.status = status;
    this.message = message ?? 'Server error';
    this.requestID = requestID;
  }
}`,
      skipIfExists: true,
    },
    {
      path: "src/common/exceptions/no-api-key-provided.exception.ts",
      content: `export class NoApiKeyProvidedException extends Error {
  readonly name = 'NoApiKeyProvidedException';

  constructor() {
    super();
    this.message =
      'No API key provided. Pass it to the WorkOS constructor or set the WORKOS_API_KEY environment variable.';
  }
}`,
      skipIfExists: true,
    },
    {
      path: "src/common/exceptions/index.ts",
      content: `export { BadRequestException } from './bad-request.exception';
export { UnauthorizedException } from './unauthorized.exception';
export { NotFoundException } from './not-found.exception';
export { ConflictException } from './conflict.exception';
export {
  UnprocessableEntityException,
  type UnprocessableEntityError,
} from './unprocessable-entity.exception';
export { RateLimitExceededException } from './rate-limit-exceeded.exception';
export { GenericServerException } from './generic-server.exception';
export { NoApiKeyProvidedException } from './no-api-key-provided.exception';`,
      skipIfExists: true,
    },
  ];
}
