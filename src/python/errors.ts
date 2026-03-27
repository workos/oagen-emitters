import type { EmitterContext, GeneratedFile } from '@workos/oagen';

/**
 * Generate Python error/exception classes.
 */
export function generateErrors(ctx?: EmitterContext): GeneratedFile[] {
  const namespace = ctx?.namespace ?? 'workos';
  const files: GeneratedFile[] = [];

  const errorsContent = `from __future__ import annotations

from typing import Optional


class WorkOSError(Exception):
    """Base exception for all WorkOS errors."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        request_id: str | None = None,
        code: str | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.request_id = request_id
        self.code = code


class BadRequestError(WorkOSError):
    """400 Bad Request."""

    def __init__(self, message: str = "Bad request", **kwargs) -> None:
        super().__init__(message, status_code=400, **kwargs)


class AuthenticationError(WorkOSError):
    """401 Unauthorized."""

    def __init__(self, message: str = "Unauthorized", **kwargs) -> None:
        super().__init__(message, status_code=401, **kwargs)


class NotFoundError(WorkOSError):
    """404 Not Found."""

    def __init__(self, message: str = "Not found", **kwargs) -> None:
        super().__init__(message, status_code=404, **kwargs)


class ConflictError(WorkOSError):
    """409 Conflict."""

    def __init__(self, message: str = "Conflict", **kwargs) -> None:
        super().__init__(message, status_code=409, **kwargs)


class UnprocessableEntityError(WorkOSError):
    """422 Unprocessable Entity."""

    def __init__(self, message: str = "Unprocessable entity", **kwargs) -> None:
        super().__init__(message, status_code=422, **kwargs)


class RateLimitExceededError(WorkOSError):
    """429 Rate Limited."""

    def __init__(
        self, message: str = "Too many requests", *, retry_after: float | None = None, **kwargs
    ) -> None:
        super().__init__(message, status_code=429, **kwargs)
        self.retry_after = retry_after


class ServerError(WorkOSError):
    """500+ Server Error."""

    def __init__(self, message: str = "Server error", *, status_code: int = 500, **kwargs) -> None:
        super().__init__(message, status_code=status_code, **kwargs)


class ConfigurationError(WorkOSError):
    """Missing or invalid configuration."""

    def __init__(self, message: str = "Configuration error") -> None:
        super().__init__(message)


STATUS_CODE_TO_ERROR = {
    400: BadRequestError,
    401: AuthenticationError,
    404: NotFoundError,
    409: ConflictError,
    422: UnprocessableEntityError,
    429: RateLimitExceededError,
}`;

  files.push({
    path: `${namespace}/_errors.py`,
    content: errorsContent,
    skipIfExists: true,
    integrateTarget: false,
  });

  return files;
}
