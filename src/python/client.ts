import type { ApiSpec, EmitterContext, GeneratedFile } from '@workos/oagen';
import { resolveServiceDir, servicePropertyName } from './naming.js';
import { resolveResourceClassName } from './resources.js';

/**
 * Generate the main Python client class, barrel __init__.py files,
 * and project scaffolding (pyproject.toml, py.typed).
 */
export function generateClient(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  files.push(...generateWorkOSClient(spec, ctx));
  files.push(...generateServiceInits(spec, ctx));
  files.push(...generateBarrel(spec, ctx));
  files.push(...generatePyProjectToml(ctx));
  files.push(...generatePyTyped(ctx));

  return files;
}

function generateWorkOSClient(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const lines: string[] = [];

  lines.push('from __future__ import annotations');
  lines.push('');
  lines.push('import os');
  lines.push('import time');
  lines.push('import uuid');
  lines.push('import random');
  lines.push('from typing import Any, Dict, Optional, Type, cast, overload');
  lines.push('');
  lines.push('import httpx');
  lines.push('');
  lines.push('from ._errors import (');
  lines.push('    WorkOSError,');
  lines.push('    AuthenticationError,');
  lines.push('    BadRequestError,');
  lines.push('    ConflictError,');
  lines.push('    ConfigurationError,');
  lines.push('    NotFoundError,');
  lines.push('    RateLimitExceededError,');
  lines.push('    ServerError,');
  lines.push('    UnprocessableEntityError,');
  lines.push('    STATUS_CODE_TO_ERROR,');
  lines.push(')');
  lines.push('from ._pagination import SyncPage');
  lines.push('from ._types import D, Deserializable, RequestOptions');

  // Import resource classes
  for (const service of spec.services) {
    const resolvedName = resolveResourceClassName(service, ctx);
    const dirName = resolveServiceDir(resolvedName);
    lines.push(`from .${dirName}._resource import ${resolvedName}`);
  }

  lines.push('');
  lines.push('RETRY_STATUS_CODES = {429, 500, 502, 503, 504}');
  lines.push('MAX_RETRIES = 3');
  lines.push('INITIAL_RETRY_DELAY = 0.5');
  lines.push('MAX_RETRY_DELAY = 8.0');
  lines.push('RETRY_MULTIPLIER = 2.0');
  lines.push('');
  lines.push('');
  lines.push('class WorkOS:');
  lines.push(`    """${ctx.namespacePascal} API client."""`);
  lines.push('');
  lines.push('    def __init__(');
  lines.push('        self,');
  lines.push('        *,');
  lines.push('        api_key: Optional[str] = None,');
  lines.push(`        base_url: str = "${spec.baseUrl}",`);
  lines.push('        timeout: float = 30.0,');
  lines.push('        max_retries: int = MAX_RETRIES,');
  lines.push('    ) -> None:');
  lines.push('        self._api_key = api_key or os.environ.get("WORKOS_API_KEY")');
  lines.push('        if not self._api_key:');
  lines.push('            raise ConfigurationError(');
  lines.push('                "No API key provided. Pass it to the WorkOS constructor "');
  lines.push('                "or set the WORKOS_API_KEY environment variable."');
  lines.push('            )');
  lines.push('        self._base_url = base_url.rstrip("/")');
  lines.push('        self._timeout = timeout');
  lines.push('        self._max_retries = max_retries');
  lines.push('        self._client = httpx.Client(timeout=timeout)');
  lines.push('');

  // Resource accessors
  for (const service of spec.services) {
    const resolvedName = resolveResourceClassName(service, ctx);
    const propName = servicePropertyName(resolvedName);
    lines.push(`        self.${propName} = ${resolvedName}(self)`);
  }

  // _request overloads for type safety
  lines.push('');
  lines.push('    @overload');
  lines.push('    def _request(');
  lines.push('        self,');
  lines.push('        method: str,');
  lines.push('        path: str,');
  lines.push('        *,');
  lines.push('        model: Type[D],');
  lines.push('        params: Optional[Dict[str, Any]] = ...,');
  lines.push('        body: Optional[Dict[str, Any]] = ...,');
  lines.push('        idempotency_key: Optional[str] = ...,');
  lines.push('        request_options: Optional[RequestOptions] = ...,');
  lines.push('    ) -> D: ...');
  lines.push('');
  lines.push('    @overload');
  lines.push('    def _request(');
  lines.push('        self,');
  lines.push('        method: str,');
  lines.push('        path: str,');
  lines.push('        *,');
  lines.push('        model: None = ...,');
  lines.push('        params: Optional[Dict[str, Any]] = ...,');
  lines.push('        body: Optional[Dict[str, Any]] = ...,');
  lines.push('        idempotency_key: Optional[str] = ...,');
  lines.push('        request_options: Optional[RequestOptions] = ...,');
  lines.push('    ) -> Optional[Dict[str, Any]]: ...');
  lines.push('');
  lines.push('    def _request(');
  lines.push('        self,');
  lines.push('        method: str,');
  lines.push('        path: str,');
  lines.push('        *,');
  lines.push('        params: Optional[Dict[str, Any]] = None,');
  lines.push('        body: Optional[Dict[str, Any]] = None,');
  lines.push('        model: Optional[Type[Deserializable]] = None,');
  lines.push('        idempotency_key: Optional[str] = None,');
  lines.push('        request_options: Optional[RequestOptions] = None,');
  lines.push('    ) -> Any:');
  lines.push('        """Make an HTTP request with retry logic."""');
  lines.push('        url = f"{self._base_url}/{path}"');
  lines.push('        headers: Dict[str, str] = {');
  lines.push('            "Authorization": f"Bearer {self._api_key}",');
  lines.push('            "Content-Type": "application/json",');
  lines.push('            "User-Agent": f"{self.__class__.__name__}/python",');
  lines.push('        }');
  lines.push('');
  lines.push('        if idempotency_key is None and method.lower() == "post":');
  lines.push('            idempotency_key = str(uuid.uuid4())');
  lines.push('        if idempotency_key:');
  lines.push('            headers["Idempotency-Key"] = idempotency_key');
  lines.push('');
  lines.push('        timeout = self._timeout');
  lines.push('        if request_options:');
  lines.push('            extra = request_options.get("extra_headers")');
  lines.push('            if isinstance(extra, dict):');
  lines.push('                headers.update(extra)');
  lines.push('            t = request_options.get("timeout")');
  lines.push('            if isinstance(t, (int, float)):');
  lines.push('                timeout = float(t)');
  lines.push('');
  lines.push('        last_error: Optional[Exception] = None');
  lines.push('        for attempt in range(self._max_retries + 1):');
  lines.push('            try:');
  lines.push('                response = self._client.request(');
  lines.push('                    method=method.upper(),');
  lines.push('                    url=url,');
  lines.push('                    params=params,');
  lines.push('                    json=body if body else None,');
  lines.push('                    headers=headers,');
  lines.push('                    timeout=timeout,');
  lines.push('                )');
  lines.push('');
  lines.push('                if response.status_code in RETRY_STATUS_CODES and attempt < self._max_retries:');
  lines.push('                    retry_after = response.headers.get("Retry-After")');
  lines.push('                    if retry_after:');
  lines.push('                        delay = float(retry_after)');
  lines.push('                    else:');
  lines.push('                        delay = min(');
  lines.push('                            INITIAL_RETRY_DELAY * (RETRY_MULTIPLIER ** attempt),');
  lines.push('                            MAX_RETRY_DELAY,');
  lines.push('                        )');
  lines.push('                        delay = delay * (0.5 + random.random())');
  lines.push('                    time.sleep(delay)');
  lines.push('                    continue');
  lines.push('');
  lines.push('                if response.status_code >= 400:');
  lines.push('                    self._raise_error(response)');
  lines.push('');
  lines.push('                if response.status_code == 204 or not response.content:');
  lines.push('                    return None');
  lines.push('');
  lines.push('                data: Dict[str, Any] = response.json()');
  lines.push('                if model is not None:');
  lines.push('                    return model.from_dict(data)');
  lines.push('                return data');
  lines.push('');
  lines.push('            except httpx.HTTPError as e:');
  lines.push('                last_error = e');
  lines.push('                if attempt < self._max_retries:');
  lines.push('                    delay = min(');
  lines.push('                        INITIAL_RETRY_DELAY * (RETRY_MULTIPLIER ** attempt),');
  lines.push('                        MAX_RETRY_DELAY,');
  lines.push('                    )');
  lines.push('                    delay = delay * (0.5 + random.random())');
  lines.push('                    time.sleep(delay)');
  lines.push('                    continue');
  lines.push('                raise WorkOSError(f"Network error: {e}") from e');
  lines.push('');
  lines.push('        raise WorkOSError("Max retries exceeded") from last_error');

  // _request_page method
  lines.push('');
  lines.push('    def _request_page(');
  lines.push('        self,');
  lines.push('        method: str,');
  lines.push('        path: str,');
  lines.push('        *,');
  lines.push('        model: Type[D],');
  lines.push('        params: Optional[Dict[str, Any]] = None,');
  lines.push('        request_options: Optional[RequestOptions] = None,');
  lines.push('    ) -> SyncPage[D]:');
  lines.push('        """Make an HTTP request that returns a paginated response."""');
  lines.push('        raw = self._request(');
  lines.push('            method=method,');
  lines.push('            path=path,');
  lines.push('            params=params,');
  lines.push('            request_options=request_options,');
  lines.push('        )');
  lines.push('        data: Dict[str, Any] = raw if isinstance(raw, dict) else {}');
  lines.push('        items: list[D] = [');
  lines.push('            cast(D, model.from_dict(item))');
  lines.push('            for item in (data.get("data") or [])');
  lines.push('        ]');
  lines.push('        list_metadata: Dict[str, Any] = data.get("list_metadata", {})');
  lines.push('        return SyncPage(');
  lines.push('            data=items,');
  lines.push('            list_metadata=list_metadata,');
  lines.push('            _fetch_page=lambda **kw: self._request_page(');
  lines.push('                method=method,');
  lines.push('                path=path,');
  lines.push('                model=model,');
  lines.push('                params={**(params or {}), **kw},');
  lines.push('                request_options=request_options,');
  lines.push('            ),');
  lines.push('        )');

  // _raise_error method
  lines.push('');
  lines.push('    @staticmethod');
  lines.push('    def _raise_error(response: httpx.Response) -> None:');
  lines.push('        """Raise an appropriate error based on the response status code."""');
  lines.push('        request_id = response.headers.get("x-request-id", "")');
  lines.push('        try:');
  lines.push('            body: Dict[str, Any] = response.json()');
  lines.push('            message: str = str(body.get("message", response.text))');
  lines.push('            code: Optional[str] = str(body["code"]) if "code" in body else None');
  lines.push('        except Exception:');
  lines.push('            message = response.text');
  lines.push('            code = None');
  lines.push('');
  lines.push('        error_class = STATUS_CODE_TO_ERROR.get(response.status_code)');
  lines.push('        if error_class:');
  lines.push('            if error_class is RateLimitExceededError:');
  lines.push('                retry_after = response.headers.get("Retry-After")');
  lines.push('                raise RateLimitExceededError(');
  lines.push('                    message,');
  lines.push('                    retry_after=float(retry_after) if retry_after else None,');
  lines.push('                    request_id=request_id,');
  lines.push('                    code=code,');
  lines.push('                )');
  lines.push('            raise error_class(message, request_id=request_id, code=code)');
  lines.push('');
  lines.push('        if response.status_code >= 500:');
  lines.push('            raise ServerError(');
  lines.push('                message, status_code=response.status_code, request_id=request_id, code=code');
  lines.push('            )');
  lines.push('');
  lines.push('        raise WorkOSError(');
  lines.push('            message, status_code=response.status_code, request_id=request_id, code=code');
  lines.push('        )');

  return [
    {
      path: `${ctx.namespace}/_client.py`,
      content: lines.join('\n'),
    },
  ];
}

function generateServiceInits(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  for (const service of spec.services) {
    const resolvedName = resolveResourceClassName(service, ctx);
    const dirName = resolveServiceDir(resolvedName);
    const lines: string[] = [];

    lines.push(`from ._resource import ${resolvedName}`);
    lines.push('from .models import *  # noqa: F401,F403');

    files.push({
      path: `${ctx.namespace}/${dirName}/__init__.py`,
      content: lines.join('\n'),
    });

    // Ensure models/__init__.py exists even if no models are assigned to this service
    files.push({
      path: `${ctx.namespace}/${dirName}/models/__init__.py`,
      content: '',
      skipIfExists: true,
    });
  }

  return files;
}

function generateBarrel(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const lines: string[] = [];

  lines.push(`"""${ctx.namespacePascal} Python SDK."""`);
  lines.push('');
  lines.push('from ._client import WorkOS');
  lines.push('from ._errors import (');
  lines.push('    WorkOSError,');
  lines.push('    AuthenticationError,');
  lines.push('    BadRequestError,');
  lines.push('    ConflictError,');
  lines.push('    ConfigurationError,');
  lines.push('    NotFoundError,');
  lines.push('    RateLimitExceededError,');
  lines.push('    ServerError,');
  lines.push('    UnprocessableEntityError,');
  lines.push(')');
  lines.push('from ._pagination import SyncPage');

  // Re-export all models and enums
  for (const service of spec.services) {
    const resolvedName = resolveResourceClassName(service, ctx);
    const dirName = resolveServiceDir(resolvedName);
    lines.push(`from .${dirName} import *  # noqa: F401,F403`);
  }

  lines.push('');
  lines.push('__all__ = [');
  lines.push('    "WorkOS",');
  lines.push('    "WorkOSError",');
  lines.push('    "AuthenticationError",');
  lines.push('    "BadRequestError",');
  lines.push('    "ConflictError",');
  lines.push('    "ConfigurationError",');
  lines.push('    "NotFoundError",');
  lines.push('    "RateLimitExceededError",');
  lines.push('    "ServerError",');
  lines.push('    "UnprocessableEntityError",');
  lines.push('    "SyncPage",');
  lines.push(']');

  return [
    {
      path: `${ctx.namespace}/__init__.py`,
      content: lines.join('\n'),
    },
  ];
}

function generatePyProjectToml(ctx: EmitterContext): GeneratedFile[] {
  const content = `[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[project]
name = "${ctx.namespace}"
version = "0.1.0"
description = "${ctx.namespacePascal} Python SDK"
requires-python = ">=3.11"
dependencies = [
    "httpx>=0.25.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=7.0",
    "pytest-httpx>=0.30.0",
    "ruff>=0.4.0",
]

[tool.ruff]
line-length = 100
target-version = "py311"

[tool.ruff.lint]
select = ["E", "F", "I"]

[tool.pytest.ini_options]
testpaths = ["tests"]`;

  return [
    {
      path: 'pyproject.toml',
      content,
      skipIfExists: true,
      integrateTarget: false,
      headerPlacement: 'skip',
    },
  ];
}

function generatePyTyped(ctx: EmitterContext): GeneratedFile[] {
  return [
    {
      path: `${ctx.namespace}/py.typed`,
      content: '',
      skipIfExists: true,
      integrateTarget: false,
      headerPlacement: 'skip',
    },
  ];
}
