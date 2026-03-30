import type { EmitterContext, GeneratedFile } from '@workos/oagen';

/**
 * Generate Python error/exception classes.
 */
export function generateErrors(ctx?: EmitterContext): GeneratedFile[] {
  const namespace = ctx?.namespace ?? 'workos';
  const files: GeneratedFile[] = [];

  const errorsContent = `from __future__ import annotations

from typing import Any, Dict, Optional, Type


class WorkOSError(Exception):
    """Base exception for all WorkOS errors."""

    message: str
    status_code: Optional[int]
    request_id: Optional[str]
    code: Optional[str]

    def __init__(
        self,
        message: str,
        *,
        status_code: Optional[int] = None,
        request_id: Optional[str] = None,
        code: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.request_id = request_id
        self.code = code


class BadRequestError(WorkOSError):
    """400 Bad Request."""

    def __init__(
        self,
        message: str = "Bad request",
        *,
        request_id: Optional[str] = None,
        code: Optional[str] = None,
    ) -> None:
        super().__init__(message, status_code=400, request_id=request_id, code=code)


class AuthenticationError(WorkOSError):
    """401 Unauthorized."""

    def __init__(
        self,
        message: str = "Unauthorized",
        *,
        request_id: Optional[str] = None,
        code: Optional[str] = None,
    ) -> None:
        super().__init__(message, status_code=401, request_id=request_id, code=code)


class ForbiddenError(WorkOSError):
    """403 Forbidden."""

    def __init__(
        self,
        message: str = "Forbidden",
        *,
        request_id: Optional[str] = None,
        code: Optional[str] = None,
    ) -> None:
        super().__init__(message, status_code=403, request_id=request_id, code=code)


class NotFoundError(WorkOSError):
    """404 Not Found."""

    def __init__(
        self,
        message: str = "Not found",
        *,
        request_id: Optional[str] = None,
        code: Optional[str] = None,
    ) -> None:
        super().__init__(message, status_code=404, request_id=request_id, code=code)


class ConflictError(WorkOSError):
    """409 Conflict."""

    def __init__(
        self,
        message: str = "Conflict",
        *,
        request_id: Optional[str] = None,
        code: Optional[str] = None,
    ) -> None:
        super().__init__(message, status_code=409, request_id=request_id, code=code)


class UnprocessableEntityError(WorkOSError):
    """422 Unprocessable Entity."""

    def __init__(
        self,
        message: str = "Unprocessable entity",
        *,
        request_id: Optional[str] = None,
        code: Optional[str] = None,
    ) -> None:
        super().__init__(message, status_code=422, request_id=request_id, code=code)


class RateLimitExceededError(WorkOSError):
    """429 Rate Limited."""

    retry_after: Optional[float]

    def __init__(
        self,
        message: str = "Too many requests",
        *,
        retry_after: Optional[float] = None,
        request_id: Optional[str] = None,
        code: Optional[str] = None,
    ) -> None:
        super().__init__(message, status_code=429, request_id=request_id, code=code)
        self.retry_after = retry_after


class ServerError(WorkOSError):
    """500+ Server Error."""

    def __init__(
        self,
        message: str = "Server error",
        *,
        status_code: int = 500,
        request_id: Optional[str] = None,
        code: Optional[str] = None,
    ) -> None:
        super().__init__(message, status_code=status_code, request_id=request_id, code=code)


class ConfigurationError(WorkOSError):
    """Missing or invalid configuration."""

    def __init__(self, message: str = "Configuration error") -> None:
        super().__init__(message)


class WorkOSConnectionError(WorkOSError):
    """Raised when the SDK cannot connect to the API (DNS failure, connection refused, etc.)."""

    def __init__(self, message: str = "Connection failed") -> None:
        super().__init__(message)


class WorkOSTimeoutError(WorkOSError):
    """Raised when the API request times out."""

    def __init__(self, message: str = "Request timed out") -> None:
        super().__init__(message)


STATUS_CODE_TO_ERROR: Dict[int, Type[WorkOSError]] = {
    400: BadRequestError,
    401: AuthenticationError,
    403: ForbiddenError,
    404: NotFoundError,
    409: ConflictError,
    422: UnprocessableEntityError,
    429: RateLimitExceededError,
}`;

  files.push({
    path: `src/${namespace}/_errors.py`,
    content: errorsContent,
    integrateTarget: true,
    overwriteExisting: true,
  });

  return files;
}
