import type { ApiSpec, EmitterContext, GeneratedFile, Service, SdkBehavior } from '@workos/oagen';
import { toPascalCase, defaultSdkBehavior } from '@workos/oagen';
import { className, resolveServiceDir, servicePropertyName, buildMountDirMap, dirToModule } from './naming.js';
import { resolveResourceClassName } from './resources.js';
import { getMountTarget } from '../shared/resolved-ops.js';

/**
 * Generate the main Python client class, barrel __init__.py files,
 * and project scaffolding (pyproject.toml, py.typed).
 */
export function generateClient(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  assertPublicClientReachability(spec, ctx);

  const files: GeneratedFile[] = [];

  files.push(...generateWorkOSClient(spec, ctx));
  files.push(...generateServiceInits(spec, ctx));
  files.push(...generateBarrel(spec, ctx));
  files.push(...generateTypesBarrels(spec, ctx));
  files.push(...generatePyProjectToml(ctx));
  files.push(...generatePyTyped(ctx));

  return files;
}

/**
 * Deduplicate services by mount target. Multiple IR services may mount to the
 * same target (e.g., Applications + ApplicationClientSecrets -> Connect).
 * Returns one representative service per unique mount target, using the service
 * whose PascalCase name matches the target (if any), or the first one found.
 */
function deduplicateByMount(services: Service[], ctx: EmitterContext): Service[] {
  const byTarget = new Map<string, Service>();
  for (const s of services) {
    const target = getMountTarget(s, ctx);
    const existing = byTarget.get(target);
    if (!existing || toPascalCase(s.name) === target) {
      byTarget.set(target, s);
    }
  }
  return [...byTarget.values()];
}

export function buildServiceAccessPaths(services: Service[], ctx: EmitterContext): Map<string, string> {
  const topLevel = deduplicateByMount(services, ctx);
  const paths = new Map<string, string>();

  for (const service of topLevel) {
    const resolvedName = resolveResourceClassName(service, ctx);
    const prop = servicePropertyName(resolvedName);
    paths.set(service.name, prop);
  }

  // Build reverse map: mount target name -> access path
  const targetPaths = new Map<string, string>();
  for (const service of topLevel) {
    const target = getMountTarget(service, ctx);
    if (!targetPaths.has(target) && paths.has(service.name)) {
      targetPaths.set(target, paths.get(service.name)!);
    }
  }

  // Map mounted services to their mount target's access path
  for (const service of services) {
    if (paths.has(service.name)) continue;
    const mountTarget = getMountTarget(service, ctx);
    const targetPath = targetPaths.get(mountTarget) ?? paths.get(mountTarget);
    if (targetPath) paths.set(service.name, targetPath);
  }

  return paths;
}

function assertPublicClientReachability(spec: ApiSpec, ctx: EmitterContext): void {
  const topLevelServices = deduplicateByMount(spec.services, ctx);
  const accessPaths = buildServiceAccessPaths(spec.services, ctx);
  const unreachableServices = topLevelServices
    .filter((service) => service.operations.length > 0 && !accessPaths.has(service.name))
    .map((service) => service.name);

  if (unreachableServices.length > 0) {
    throw new Error(`Python emitter reachability audit failed for services: ${unreachableServices.join(', ')}`);
  }
}

function generateWorkOSClient(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const sdk: SdkBehavior = ctx.spec.sdk ?? defaultSdkBehavior();
  const lines: string[] = [];
  const topLevelServices = deduplicateByMount(spec.services, ctx);

  // --- Imports ---
  lines.push('from __future__ import annotations');
  lines.push('');
  lines.push('import asyncio');
  lines.push('import functools');
  lines.push('import os');
  lines.push('import platform');
  lines.push('import time');
  lines.push('import uuid');
  lines.push('import random');
  lines.push('from datetime import datetime, timezone');
  lines.push('from email.utils import parsedate_to_datetime');
  lines.push('from typing import Any, Dict, List, Literal, Optional, Type, Union, cast, overload');
  lines.push('');
  lines.push('import httpx');
  lines.push('');
  lines.push('from ._errors import (');
  lines.push('    APIError,');
  lines.push('    WorkOSError,');
  lines.push('    AuthenticationError,');
  lines.push('    BadRequestError,');
  lines.push('    ConflictError,');
  lines.push('    ConfigurationError,');
  lines.push('    AuthorizationError,');
  lines.push('    NotFoundError,');
  lines.push('    RateLimitExceededError,');
  lines.push('    ServerError,');
  lines.push('    UnprocessableEntityError,');
  lines.push('    WorkOSConnectionError,');
  lines.push('    WorkOSTimeoutError,');
  lines.push('    STATUS_CODE_TO_ERROR,');
  lines.push(')');
  lines.push('from ._pagination import AsyncPage, ListMetadata, SyncPage');
  lines.push('from ._types import D, Deserializable, RequestOptions');

  // Import resource classes (both sync and async)
  const serviceDirMap = buildMountDirMap(ctx);
  for (const service of topLevelServices) {
    const resolvedName = resolveResourceClassName(service, ctx);
    const clsName = className(resolvedName);
    const dirName = serviceDirMap.get(service.name) ?? resolveServiceDir(resolvedName);
    lines.push(`from .${dirToModule(dirName)}._resource import ${clsName}, Async${clsName}`);
  }
  lines.push('from .actions import Actions, AsyncActions');
  lines.push('from .passwordless import AsyncPasswordless, Passwordless');
  lines.push('from .pkce import PKCE');
  lines.push('from .session import AsyncSession, Session');
  lines.push('from .vault import AsyncVault, Vault');
  lines.push('');
  lines.push('try:');
  lines.push('    from importlib.metadata import version as _pkg_version');
  lines.push('    VERSION = _pkg_version("workos")');
  lines.push('except Exception:');
  lines.push('    VERSION = "0.0.0"');
  lines.push('');
  lines.push(`RETRY_STATUS_CODES = {${sdk.retry.retryableStatusCodes.join(', ')}}`);
  lines.push(`MAX_RETRIES = ${sdk.retry.maxRetries}`);
  lines.push(`INITIAL_RETRY_DELAY = ${sdk.retry.backoff.initialDelay}`);
  lines.push(`MAX_RETRY_DELAY = ${sdk.retry.backoff.maxDelay}`);
  lines.push(`RETRY_MULTIPLIER = ${sdk.retry.backoff.multiplier}`);

  lines.push('');
  lines.push('');
  lines.push('class _BaseWorkOS:');
  lines.push('    """Shared WorkOS client implementation."""');
  lines.push('');
  lines.push('    def __init__(');
  lines.push('        self,');
  lines.push('        *,');
  lines.push('        api_key: Optional[str] = None,');
  lines.push('        client_id: Optional[str] = None,');
  lines.push('        base_url: Optional[str] = None,');
  lines.push('        request_timeout: Optional[int] = None,');
  lines.push('        jwt_leeway: float = 0.0,');
  lines.push('        max_retries: int = MAX_RETRIES,');
  lines.push('    ) -> None:');
  lines.push('        self._api_key = api_key or os.environ.get("WORKOS_API_KEY")');
  lines.push('        self.client_id = client_id or os.environ.get("WORKOS_CLIENT_ID")');
  lines.push('        if not self._api_key and not self.client_id:');
  lines.push('            raise ValueError(');
  lines.push('                "WorkOS requires either an API key or a client ID. "');
  lines.push('                "Provide api_key / WORKOS_API_KEY for authenticated server-side usage, "');
  lines.push('                "or client_id / WORKOS_CLIENT_ID for flows that require a client ID."');
  lines.push('            )');
  lines.push(`        resolved_base_url = base_url or os.environ.get("WORKOS_BASE_URL", "${spec.baseUrl}")`);
  lines.push('        # Ensure base_url has a trailing slash for backward compatibility');
  lines.push('        self._base_url = resolved_base_url.rstrip("/") + "/"');
  const timeoutEnvVar = sdk.timeout.timeoutEnvVar ?? 'WORKOS_REQUEST_TIMEOUT';
  lines.push(
    `        self._request_timeout = request_timeout if request_timeout is not None else int(os.environ.get("${timeoutEnvVar}", "${sdk.timeout.defaultTimeoutSeconds}"))`,
  );
  lines.push('        self._max_retries = max_retries');
  lines.push('        self._jwt_leeway = jwt_leeway');
  lines.push('');
  lines.push('    @property');
  lines.push('    def base_url(self) -> str:');
  lines.push('        """The base URL for API requests."""');
  lines.push('        return self._base_url');
  lines.push('');
  lines.push('    def build_url(self, path: str, params: Optional[Dict[str, Any]] = None) -> str:');
  lines.push('        """Build a full URL with query parameters for redirect/authorization endpoints."""');
  lines.push('        from urllib.parse import urlencode');
  lines.push('        base = self._base_url.rstrip("/")');
  lines.push('        url = f"{base}/{path}"');
  lines.push('        if params:');
  lines.push('            url = f"{url}?{urlencode(params)}"');
  lines.push('        return url');
  lines.push('');
  lines.push('    @staticmethod');
  lines.push('    def _parse_retry_after(retry_after: Optional[str]) -> Optional[float]:');
  lines.push('        """Parse Retry-After as seconds or an HTTP-date."""');
  lines.push('        if not retry_after:');
  lines.push('            return None');
  lines.push('        value = retry_after.strip()');
  lines.push('        if not value:');
  lines.push('            return None');
  lines.push('        try:');
  lines.push('            return max(float(value), 0.0)');
  lines.push('        except ValueError:');
  lines.push('            pass');
  lines.push('        try:');
  lines.push('            retry_at = parsedate_to_datetime(value)');
  lines.push('        except (TypeError, ValueError, IndexError, OverflowError):');
  lines.push('            return None');
  lines.push('        if retry_at.tzinfo is None:');
  lines.push('            retry_at = retry_at.replace(tzinfo=timezone.utc)');
  lines.push('        return max((retry_at - datetime.now(timezone.utc)).total_seconds(), 0.0)');
  lines.push('');
  lines.push('    @staticmethod');
  lines.push('    def _calculate_retry_delay(attempt: int, retry_after: Optional[str] = None) -> float:');
  lines.push('        """Calculate retry delay with exponential backoff and jitter."""');
  lines.push('        parsed_retry_after = _BaseWorkOS._parse_retry_after(retry_after)');
  lines.push('        if parsed_retry_after is not None:');
  lines.push('            return parsed_retry_after');
  lines.push('        delay = min(INITIAL_RETRY_DELAY * (RETRY_MULTIPLIER ** attempt), MAX_RETRY_DELAY)');
  lines.push('        return delay * (0.5 + random.random())');
  lines.push('');
  lines.push('    def _resolve_base_url(self, request_options: Optional[RequestOptions]) -> str:');
  lines.push('        if request_options:');
  lines.push('            base_url = request_options.get("base_url")');
  lines.push('            if base_url:');
  lines.push('                return str(base_url).rstrip("/")');
  lines.push('        return self._base_url.rstrip("/")'); // Strip trailing slash for URL construction
  lines.push('');
  lines.push('    def _resolve_timeout(self, request_options: Optional[RequestOptions]) -> float:');
  lines.push('        timeout = self._request_timeout');
  lines.push('        if request_options:');
  lines.push('            t = request_options.get("timeout")');
  lines.push('            if isinstance(t, (int, float)):');
  lines.push('                timeout = float(t)');
  lines.push('        return timeout');
  lines.push('');
  lines.push('    def _resolve_max_retries(self, request_options: Optional[RequestOptions]) -> int:');
  lines.push('        if request_options:');
  lines.push('            retries = request_options.get("max_retries")');
  lines.push('            if isinstance(retries, int):');
  lines.push('                return retries');
  lines.push('        return self._max_retries');
  lines.push('');
  lines.push('    def _require_api_key(self) -> str:');
  lines.push('        if not self._api_key:');
  lines.push('            raise ConfigurationError(');
  lines.push(
    '                "This operation requires a WorkOS API key. Provide api_key when instantiating the client "',
  );
  lines.push('                "or via the WORKOS_API_KEY environment variable."');
  lines.push('            )');
  lines.push('        return self._api_key');
  lines.push('');
  lines.push('    def _require_client_id(self) -> str:');
  lines.push('        if not self.client_id:');
  lines.push('            raise ConfigurationError(');
  lines.push(
    '                "This operation requires a WorkOS client ID. Provide client_id when instantiating the client "',
  );
  lines.push('                "or via the WORKOS_CLIENT_ID environment variable."');
  lines.push('            )');
  lines.push('        return self.client_id');
  lines.push('');
  lines.push('    def _build_headers(');
  lines.push('        self,');
  lines.push('        method: str,');
  lines.push('        idempotency_key: Optional[str],');
  lines.push('        request_options: Optional[RequestOptions],');
  lines.push('    ) -> Dict[str, str]:');
  lines.push('        headers: Dict[str, str] = {');
  lines.push('            "Content-Type": "application/json",');
  lines.push('            "User-Agent": f"workos-python/{VERSION} python/{platform.python_version()}",');
  lines.push('        }');
  lines.push('        if self._api_key:');
  lines.push('            headers["Authorization"] = f"Bearer {self._api_key}"');
  lines.push('        effective_idempotency_key = idempotency_key');
  lines.push('        if effective_idempotency_key is None and request_options:');
  lines.push('            request_option_idempotency_key = request_options.get("idempotency_key")');
  lines.push('            if isinstance(request_option_idempotency_key, str):');
  lines.push('                effective_idempotency_key = request_option_idempotency_key');
  lines.push('        if effective_idempotency_key is None and method.lower() == "post":');
  lines.push('            effective_idempotency_key = str(uuid.uuid4())');
  lines.push('        if effective_idempotency_key:');
  lines.push('            headers["Idempotency-Key"] = effective_idempotency_key');
  lines.push('        if request_options:');
  lines.push('            extra = request_options.get("extra_headers")');
  lines.push('            if isinstance(extra, dict):');
  lines.push('                headers.update(cast(Dict[str, str], extra))');
  lines.push('        return headers');
  lines.push('');
  lines.push(
    '    def _deserialize_response(self, response: httpx.Response, model: Optional[Type[Deserializable]]) -> Any:',
  );
  lines.push('        if response.status_code == 204 or not response.content:');
  lines.push('            return None');
  lines.push('        data: Dict[str, Any] = cast(Dict[str, Any], response.json())');
  lines.push('        if model is not None:');
  lines.push('            return model.from_dict(data)');
  lines.push('        return data');
  lines.push('');
  emitRaiseError(lines, 1);

  lines.push('');
  lines.push('');
  lines.push('class WorkOS(_BaseWorkOS):');
  lines.push('    """Synchronous WorkOS API client."""');
  lines.push('');
  lines.push('    def __init__(');
  lines.push('        self,');
  lines.push('        *,');
  lines.push('        api_key: Optional[str] = None,');
  lines.push('        client_id: Optional[str] = None,');
  lines.push('        base_url: Optional[str] = None,');
  lines.push('        request_timeout: Optional[int] = None,');
  lines.push('        jwt_leeway: float = 0.0,');
  lines.push('        max_retries: int = MAX_RETRIES,');
  lines.push('    ) -> None:');
  lines.push('        """Initialize the WorkOS client.');
  lines.push('');
  lines.push('        Args:');
  lines.push('            api_key: WorkOS API key. Falls back to the WORKOS_API_KEY environment variable.');
  lines.push('            client_id: WorkOS client ID. Falls back to the WORKOS_CLIENT_ID environment variable.');
  lines.push(`            base_url: Base URL for API requests. Falls back to WORKOS_BASE_URL or "${spec.baseUrl}".`);
  lines.push(
    `            request_timeout: HTTP request timeout in seconds. Falls back to ${timeoutEnvVar} or ${sdk.timeout.defaultTimeoutSeconds}.`,
  );
  lines.push('            jwt_leeway: JWT clock skew leeway in seconds.');
  lines.push(
    `            max_retries: Maximum number of retries for failed requests. Defaults to ${sdk.retry.maxRetries}.`,
  );
  lines.push('');
  lines.push('        Raises:');
  lines.push(
    '            ValueError: If neither api_key nor client_id is provided, directly or via environment variables.',
  );
  lines.push('        """');
  lines.push('        super().__init__(');
  lines.push('            api_key=api_key,');
  lines.push('            client_id=client_id,');
  lines.push('            base_url=base_url,');
  lines.push('            request_timeout=request_timeout,');
  lines.push('            jwt_leeway=jwt_leeway,');
  lines.push('            max_retries=max_retries,');
  lines.push('        )');
  lines.push('        self._client = httpx.Client(timeout=self._request_timeout, follow_redirects=True)');
  lines.push('');
  lines.push('    def close(self) -> None:');
  lines.push('        """Close the underlying HTTP client and release resources."""');
  lines.push('        self._client.close()');
  lines.push('');
  lines.push('    def __enter__(self) -> "WorkOS":');
  lines.push('        return self');
  lines.push('');
  lines.push('    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:');
  lines.push('        self.close()');

  // Collect all generated property names
  const generatedProps = new Set<string>();
  for (const service of topLevelServices) {
    const resolvedName = resolveResourceClassName(service, ctx);
    const clsName = className(resolvedName);
    const prop = servicePropertyName(resolvedName);
    lines.push('');
    lines.push('    @functools.cached_property');
    lines.push(`    def ${prop}(self) -> ${clsName}:`);
    lines.push(`        return ${clsName}(self)`);
    generatedProps.add(prop);
  }
  emitCompatClientPropertyAliases(lines, generatedProps);
  emitCompatClientAccessors(lines, false);

  lines.push('');
  lines.push('    @overload');
  lines.push('    def request(');
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
  lines.push('    def request(');
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
  lines.push('    def request(');
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
  lines.push('        url = f"{self._resolve_base_url(request_options)}/{path}"');
  lines.push('        headers = self._build_headers(method, idempotency_key, request_options)');
  lines.push('        timeout = self._resolve_timeout(request_options)');
  lines.push('        max_retries = self._resolve_max_retries(request_options)');
  lines.push('        last_error: Optional[Exception] = None');
  lines.push('        for attempt in range(max_retries + 1):');
  lines.push('            try:');
  lines.push('                response = self._client.request(');
  lines.push('                    method=method.upper(),');
  lines.push('                    url=url,');
  lines.push('                    params=params,');
  lines.push('                    json=body if body is not None else None,');
  lines.push('                    headers=headers,');
  lines.push('                    timeout=timeout,');
  lines.push('                )');
  lines.push('                if response.status_code in RETRY_STATUS_CODES and attempt < max_retries:');
  lines.push('                    delay = self._calculate_retry_delay(attempt, response.headers.get("Retry-After"))');
  lines.push('                    time.sleep(delay)');
  lines.push('                    continue');
  lines.push('                if response.status_code >= 400:');
  lines.push('                    self._raise_error(response)');
  lines.push('                return self._deserialize_response(response, model)');
  lines.push('            except httpx.TimeoutException as e:');
  lines.push('                last_error = e');
  lines.push('                if attempt < max_retries:');
  lines.push('                    time.sleep(self._calculate_retry_delay(attempt))');
  lines.push('                    continue');
  lines.push('                raise WorkOSTimeoutError(f"Request timed out: {e}") from e');
  lines.push('            except httpx.ConnectError as e:');
  lines.push('                last_error = e');
  lines.push('                if attempt < max_retries:');
  lines.push('                    time.sleep(self._calculate_retry_delay(attempt))');
  lines.push('                    continue');
  lines.push('                raise WorkOSConnectionError(f"Connection failed: {e}") from e');
  lines.push('            except httpx.HTTPError as e:');
  lines.push('                last_error = e');
  lines.push('                if attempt < max_retries:');
  lines.push('                    time.sleep(self._calculate_retry_delay(attempt))');
  lines.push('                    continue');
  lines.push('                raise WorkOSError(f"Network error: {e}") from e');
  lines.push('        raise WorkOSError("Max retries exceeded") from last_error');
  lines.push('');
  lines.push('    def request_page(');
  lines.push('        self,');
  lines.push('        method: str,');
  lines.push('        path: str,');
  lines.push('        *,');
  lines.push('        model: Type[D],');
  lines.push('        params: Optional[Dict[str, Any]] = None,');
  lines.push('        body: Optional[Dict[str, Any]] = None,');
  lines.push('        request_options: Optional[RequestOptions] = None,');
  lines.push('    ) -> SyncPage[D]:');
  lines.push('        """Make an HTTP request that returns a paginated response."""');
  lines.push('        raw = self.request(');
  lines.push('            method=method,');
  lines.push('            path=path,');
  lines.push('            params=params,');
  lines.push('            body=body,');
  lines.push('            request_options=request_options,');
  lines.push('        )');
  lines.push('        data: Dict[str, Any] = raw if isinstance(raw, dict) else {}');
  lines.push('        raw_items: list[Any] = cast(list[Any], data.get("data") or [])');
  lines.push('        items: list[D] = [cast(D, model.from_dict(cast(Dict[str, Any], item))) for item in raw_items]');
  lines.push('        list_metadata = ListMetadata.from_dict(cast(Dict[str, Any], data.get("list_metadata", {})))');
  lines.push('');
  lines.push('        def _fetch(*, after: Optional[str] = None) -> SyncPage[D]:');
  lines.push('            next_params = {**(params or {}), "after": after}');
  lines.push('            return self.request_page(');
  lines.push('                method=method,');
  lines.push('                path=path,');
  lines.push('                model=model,');
  lines.push('                params=next_params,');
  lines.push('                body=body,');
  lines.push('                request_options=request_options,');
  lines.push('            )');
  lines.push('');
  lines.push('        return SyncPage(data=items, list_metadata=list_metadata, _fetch_page=_fetch)');

  lines.push('');
  lines.push('');
  lines.push('class AsyncWorkOS(_BaseWorkOS):');
  lines.push('    """Asynchronous WorkOS API client."""');
  lines.push('');
  lines.push('    def __init__(');
  lines.push('        self,');
  lines.push('        *,');
  lines.push('        api_key: Optional[str] = None,');
  lines.push('        client_id: Optional[str] = None,');
  lines.push('        base_url: Optional[str] = None,');
  lines.push('        request_timeout: Optional[int] = None,');
  lines.push('        jwt_leeway: float = 0.0,');
  lines.push('        max_retries: int = MAX_RETRIES,');
  lines.push('    ) -> None:');
  lines.push('        """Initialize the async WorkOS client.');
  lines.push('');
  lines.push('        Args:');
  lines.push('            api_key: WorkOS API key. Falls back to the WORKOS_API_KEY environment variable.');
  lines.push('            client_id: WorkOS client ID. Falls back to the WORKOS_CLIENT_ID environment variable.');
  lines.push(`            base_url: Base URL for API requests. Falls back to WORKOS_BASE_URL or "${spec.baseUrl}".`);
  lines.push(
    `            request_timeout: HTTP request timeout in seconds. Falls back to ${timeoutEnvVar} or ${sdk.timeout.defaultTimeoutSeconds}.`,
  );
  lines.push('            jwt_leeway: JWT clock skew leeway in seconds.');
  lines.push(
    `            max_retries: Maximum number of retries for failed requests. Defaults to ${sdk.retry.maxRetries}.`,
  );
  lines.push('');
  lines.push('        Raises:');
  lines.push(
    '            ValueError: If neither api_key nor client_id is provided, directly or via environment variables.',
  );
  lines.push('        """');
  lines.push('        super().__init__(');
  lines.push('            api_key=api_key,');
  lines.push('            client_id=client_id,');
  lines.push('            base_url=base_url,');
  lines.push('            request_timeout=request_timeout,');
  lines.push('            jwt_leeway=jwt_leeway,');
  lines.push('            max_retries=max_retries,');
  lines.push('        )');
  lines.push('        self._client = httpx.AsyncClient(timeout=self._request_timeout, follow_redirects=True)');
  lines.push('');
  lines.push('    async def close(self) -> None:');
  lines.push('        """Close the underlying HTTP client and release resources."""');
  lines.push('        await self._client.aclose()');
  lines.push('');
  lines.push('    async def __aenter__(self) -> "AsyncWorkOS":');
  lines.push('        return self');
  lines.push('');
  lines.push('    async def __aexit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:');
  lines.push('        await self.close()');

  const asyncGeneratedProps = new Set<string>();
  for (const service of topLevelServices) {
    const resolvedName = resolveResourceClassName(service, ctx);
    const clsName = className(resolvedName);
    const prop = servicePropertyName(resolvedName);
    lines.push('');
    lines.push('    @functools.cached_property');
    lines.push(`    def ${prop}(self) -> Async${clsName}:`);
    lines.push(`        return Async${clsName}(self)`);
    asyncGeneratedProps.add(prop);
  }
  emitCompatClientPropertyAliases(lines, asyncGeneratedProps);
  emitCompatClientAccessors(lines, true);

  lines.push('');
  lines.push('    @overload');
  lines.push('    async def request(');
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
  lines.push('    async def request(');
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
  lines.push('    async def request(');
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
  lines.push('        """Make an async HTTP request with retry logic."""');
  lines.push('        url = f"{self._resolve_base_url(request_options)}/{path}"');
  lines.push('        headers = self._build_headers(method, idempotency_key, request_options)');
  lines.push('        timeout = self._resolve_timeout(request_options)');
  lines.push('        max_retries = self._resolve_max_retries(request_options)');
  lines.push('        last_error: Optional[Exception] = None');
  lines.push('        for attempt in range(max_retries + 1):');
  lines.push('            try:');
  lines.push('                response = await self._client.request(');
  lines.push('                    method=method.upper(),');
  lines.push('                    url=url,');
  lines.push('                    params=params,');
  lines.push('                    json=body if body is not None else None,');
  lines.push('                    headers=headers,');
  lines.push('                    timeout=timeout,');
  lines.push('                )');
  lines.push('                if response.status_code in RETRY_STATUS_CODES and attempt < max_retries:');
  lines.push('                    delay = self._calculate_retry_delay(attempt, response.headers.get("Retry-After"))');
  lines.push('                    await asyncio.sleep(delay)');
  lines.push('                    continue');
  lines.push('                if response.status_code >= 400:');
  lines.push('                    self._raise_error(response)');
  lines.push('                return self._deserialize_response(response, model)');
  lines.push('            except httpx.TimeoutException as e:');
  lines.push('                last_error = e');
  lines.push('                if attempt < max_retries:');
  lines.push('                    await asyncio.sleep(self._calculate_retry_delay(attempt))');
  lines.push('                    continue');
  lines.push('                raise WorkOSTimeoutError(f"Request timed out: {e}") from e');
  lines.push('            except httpx.ConnectError as e:');
  lines.push('                last_error = e');
  lines.push('                if attempt < max_retries:');
  lines.push('                    await asyncio.sleep(self._calculate_retry_delay(attempt))');
  lines.push('                    continue');
  lines.push('                raise WorkOSConnectionError(f"Connection failed: {e}") from e');
  lines.push('            except httpx.HTTPError as e:');
  lines.push('                last_error = e');
  lines.push('                if attempt < max_retries:');
  lines.push('                    await asyncio.sleep(self._calculate_retry_delay(attempt))');
  lines.push('                    continue');
  lines.push('                raise WorkOSError(f"Network error: {e}") from e');
  lines.push('        raise WorkOSError("Max retries exceeded") from last_error');
  lines.push('');
  lines.push('    async def request_page(');
  lines.push('        self,');
  lines.push('        method: str,');
  lines.push('        path: str,');
  lines.push('        *,');
  lines.push('        model: Type[D],');
  lines.push('        params: Optional[Dict[str, Any]] = None,');
  lines.push('        body: Optional[Dict[str, Any]] = None,');
  lines.push('        request_options: Optional[RequestOptions] = None,');
  lines.push('    ) -> AsyncPage[D]:');
  lines.push('        """Make an async HTTP request that returns a paginated response."""');
  lines.push('        raw = await self.request(');
  lines.push('            method=method,');
  lines.push('            path=path,');
  lines.push('            params=params,');
  lines.push('            body=body,');
  lines.push('            request_options=request_options,');
  lines.push('        )');
  lines.push('        data: Dict[str, Any] = raw if isinstance(raw, dict) else {}');
  lines.push('        raw_items: list[Any] = cast(list[Any], data.get("data") or [])');
  lines.push('        items: list[D] = [cast(D, model.from_dict(cast(Dict[str, Any], item))) for item in raw_items]');
  lines.push('        list_metadata = ListMetadata.from_dict(cast(Dict[str, Any], data.get("list_metadata", {})))');
  lines.push('');
  lines.push('        async def _fetch(*, after: Optional[str] = None) -> AsyncPage[D]:');
  lines.push('            next_params = {**(params or {}), "after": after}');
  lines.push('            return await self.request_page(');
  lines.push('                method=method,');
  lines.push('                path=path,');
  lines.push('                model=model,');
  lines.push('                params=next_params,');
  lines.push('                body=body,');
  lines.push('                request_options=request_options,');
  lines.push('            )');
  lines.push('');
  lines.push('        return AsyncPage(data=items, list_metadata=list_metadata, _fetch_page=_fetch)');
  return [
    {
      path: `src/${ctx.namespace}/_client.py`,
      content: lines.join('\n'),
      integrateTarget: true,
      overwriteExisting: true,
    },
  ];
}

/**
 * Emit the static _raise_error method.
 */
function emitRaiseError(lines: string[], indentLevel = 1): void {
  const indent = '    '.repeat(indentLevel);
  lines.push('');
  lines.push(`${indent}@staticmethod`);
  lines.push(`${indent}def _raise_error(response: httpx.Response) -> None:`);
  lines.push(`${indent}    """Raise an appropriate error based on the response status code."""`);
  lines.push(`${indent}    request_id = response.headers.get("x-request-id", "")`);
  lines.push(`${indent}    raw_body = response.text`);
  lines.push(`${indent}    request = response.request`);
  lines.push(`${indent}    request_url = str(request.url) if request is not None else None`);
  lines.push(`${indent}    request_method = request.method if request is not None else None`);
  lines.push(`${indent}    response_json: Optional[Dict[str, Any]] = None`);
  lines.push(`${indent}    try:`);
  lines.push(`${indent}        response_json = cast(Dict[str, Any], response.json())`);
  lines.push(`${indent}        message: str = str(response_json.get("message", response.text))`);
  lines.push(`${indent}        error = cast(Optional[str], response_json.get("error"))`);
  lines.push(`${indent}        errors = response_json.get("errors")`);
  lines.push(`${indent}        code: Optional[str] = str(response_json["code"]) if "code" in response_json else None`);
  lines.push(`${indent}        error_description = cast(Optional[str], response_json.get("error_description"))`);
  lines.push(`${indent}        param = cast(Optional[str], response_json.get("param"))`);
  lines.push(`${indent}    except Exception:`);
  lines.push(`${indent}        message = response.text`);
  lines.push(`${indent}        error = None`);
  lines.push(`${indent}        errors = None`);
  lines.push(`${indent}        code = None`);
  lines.push(`${indent}        error_description = None`);
  lines.push(`${indent}        param = None`);
  lines.push('');
  lines.push(`${indent}    error_class = STATUS_CODE_TO_ERROR.get(response.status_code)`);
  lines.push(`${indent}    if error_class:`);
  lines.push(`${indent}        if error_class is RateLimitExceededError:`);
  lines.push(`${indent}            retry_after = _BaseWorkOS._parse_retry_after(response.headers.get("Retry-After"))`);
  lines.push(`${indent}            raise RateLimitExceededError(`);
  lines.push(`${indent}                message,`);
  lines.push(`${indent}                retry_after=retry_after,`);
  lines.push(`${indent}                request_id=request_id,`);
  lines.push(`${indent}                code=code,`);
  lines.push(`${indent}                param=param,`);
  lines.push(`${indent}                response=response,`);
  lines.push(`${indent}                response_json=response_json,`);
  lines.push(`${indent}                error=error,`);
  lines.push(`${indent}                errors=errors,`);
  lines.push(`${indent}                error_description=error_description,`);
  lines.push(`${indent}                raw_body=raw_body,`);
  lines.push(`${indent}                request_url=request_url,`);
  lines.push(`${indent}                request_method=request_method,`);
  lines.push(`${indent}            )`);
  lines.push(`${indent}        raise error_class(`);
  lines.push(`${indent}            message,`);
  lines.push(`${indent}            request_id=request_id,`);
  lines.push(`${indent}            code=code,`);
  lines.push(`${indent}            param=param,`);
  lines.push(`${indent}            response=response,`);
  lines.push(`${indent}            response_json=response_json,`);
  lines.push(`${indent}            error=error,`);
  lines.push(`${indent}            errors=errors,`);
  lines.push(`${indent}            error_description=error_description,`);
  lines.push(`${indent}            raw_body=raw_body,`);
  lines.push(`${indent}            request_url=request_url,`);
  lines.push(`${indent}            request_method=request_method,`);
  lines.push(`${indent}        )`);
  lines.push('');
  lines.push(`${indent}    if response.status_code >= 500:`);
  lines.push(`${indent}        raise ServerError(`);
  lines.push(`${indent}            message,`);
  lines.push(`${indent}            status_code=response.status_code,`);
  lines.push(`${indent}            request_id=request_id,`);
  lines.push(`${indent}            code=code,`);
  lines.push(`${indent}            param=param,`);
  lines.push(`${indent}            response=response,`);
  lines.push(`${indent}            response_json=response_json,`);
  lines.push(`${indent}            error=error,`);
  lines.push(`${indent}            errors=errors,`);
  lines.push(`${indent}            error_description=error_description,`);
  lines.push(`${indent}            raw_body=raw_body,`);
  lines.push(`${indent}            request_url=request_url,`);
  lines.push(`${indent}            request_method=request_method,`);
  lines.push(`${indent}        )`);
  lines.push('');
  lines.push(`${indent}    raise APIError(`);
  lines.push(`${indent}        message,`);
  lines.push(`${indent}        status_code=response.status_code,`);
  lines.push(`${indent}        request_id=request_id,`);
  lines.push(`${indent}        code=code,`);
  lines.push(`${indent}        param=param,`);
  lines.push(`${indent}        response=response,`);
  lines.push(`${indent}        response_json=response_json,`);
  lines.push(`${indent}        error=error,`);
  lines.push(`${indent}        errors=errors,`);
  lines.push(`${indent}        error_description=error_description,`);
  lines.push(`${indent}        raw_body=raw_body,`);
  lines.push(`${indent}        request_url=request_url,`);
  lines.push(`${indent}        request_method=request_method,`);
  lines.push(`${indent}    )`);
}

function generateServiceInits(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const topLevel = deduplicateByMount(spec.services, ctx);
  const serviceDirMap = buildMountDirMap(ctx);

  for (const service of topLevel) {
    const resolvedName = resolveResourceClassName(service, ctx);
    const dirName = serviceDirMap.get(service.name) ?? resolveServiceDir(resolvedName);
    const lines: string[] = [];

    lines.push(`from ._resource import ${resolvedName}, Async${resolvedName}`);
    lines.push('from .models import *');

    files.push({
      path: `src/${ctx.namespace}/${dirName}/__init__.py`,
      content: lines.join('\n'),
      integrateTarget: true,
      overwriteExisting: true,
    });

    // Ensure models/__init__.py exists even if no models are assigned to this service
    files.push({
      path: `src/${ctx.namespace}/${dirName}/models/__init__.py`,
      content: '',
      skipIfExists: true,
    });
  }

  return files;
}

function generateBarrel(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const lines: string[] = [];

  lines.push('"""WorkOS Python SDK."""');
  lines.push('');
  lines.push('from ._client import AsyncWorkOS, WorkOS');
  lines.push('from ._errors import WorkOSError');
  lines.push('from ._pagination import AsyncPage, ListMetadata, SyncPage');
  lines.push('from ._types import RequestOptions');
  lines.push('');
  lines.push('__all__ = [');
  lines.push('    "WorkOS",');
  lines.push('    "AsyncWorkOS",');
  lines.push('    "WorkOSError",');
  lines.push('    "SyncPage",');
  lines.push('    "AsyncPage",');
  lines.push('    "ListMetadata",');
  lines.push('    "RequestOptions",');
  lines.push(']');

  return [
    {
      path: `src/${ctx.namespace}/__init__.py`,
      content: lines.join('\n'),
      integrateTarget: true,
      overwriteExisting: true,
    },
  ];
}

function emitCompatClientAccessors(lines: string[], isAsync: boolean): void {
  const resourceName = isAsync ? 'AsyncPasswordless' : 'Passwordless';
  lines.push('');
  lines.push('    @functools.cached_property');
  lines.push(`    def passwordless(self) -> ${resourceName}:`);
  lines.push(`        return ${resourceName}(self)`);

  const vaultName = isAsync ? 'AsyncVault' : 'Vault';
  lines.push('');
  lines.push('    @functools.cached_property');
  lines.push(`    def vault(self) -> ${vaultName}:`);
  lines.push(`        return ${vaultName}(self)`);

  const actionsName = isAsync ? 'AsyncActions' : 'Actions';
  lines.push('');
  lines.push('    @functools.cached_property');
  lines.push(`    def actions(self) -> ${actionsName}:`);
  lines.push(`        return ${actionsName}()`);

  lines.push('');
  lines.push('    @functools.cached_property');
  lines.push('    def pkce(self) -> PKCE:');
  lines.push('        return PKCE()');
}

function emitCompatClientPropertyAliases(lines: string[], generatedProps: Set<string>): void {
  const aliases: Array<{ alias: string; typeName: string; returnExpr: string }> = [];
  if (generatedProps.has('multi_factor_auth') && !generatedProps.has('mfa')) {
    aliases.push({
      alias: 'mfa',
      typeName: 'Any',
      returnExpr: 'self.multi_factor_auth',
    });
  }
  for (const alias of aliases) {
    lines.push('');
    lines.push('    @functools.cached_property');
    lines.push(`    def ${alias.alias}(self) -> ${alias.typeName}:`);
    lines.push(`        return ${alias.returnExpr}`);
  }
}

/**
 * Generate types/<service>/__init__.py re-export barrels so that
 * `from workos.types.<service> import Model` continues to work.
 */
function generateTypesBarrels(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const serviceDirMap = buildMountDirMap(ctx);

  // Collect (types dir name -> set of service dirs whose models should be re-exported)
  const typesEntries = new Map<string, Set<string>>();

  for (const service of spec.services) {
    const resolvedName = resolveResourceClassName(service, ctx);
    const prop = servicePropertyName(resolvedName);
    const dir = serviceDirMap.get(service.name) ?? prop;
    const dirs = typesEntries.get(prop) ?? new Set();
    dirs.add(dir);
    typesEntries.set(prop, dirs);
  }

  for (const [typesDir, serviceDirs] of typesEntries) {
    const imports = [...serviceDirs]
      .sort()
      .map((dir) => `from ${ctx.namespace}.${dirToModule(dir)}.models import *  # noqa: F401,F403`);

    files.push({
      path: `src/${ctx.namespace}/types/${typesDir}/__init__.py`,
      content: imports.join('\n'),
      integrateTarget: true,
      overwriteExisting: true,
    });
  }

  // Root types/__init__.py
  files.push({
    path: `src/${ctx.namespace}/types/__init__.py`,
    content: '',
    integrateTarget: true,
    overwriteExisting: true,
  });

  return files;
}

function generatePyProjectToml(ctx: EmitterContext): GeneratedFile[] {
  const content = `[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[project]
name = "${ctx.namespace}"
version = "0.1.0"
description = "WorkOS Python SDK"
requires-python = ">=3.11"
dependencies = [
    "httpx>=0.25.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=7.0",
    "pytest-asyncio>=0.23.0",
    "pytest-httpx>=0.30.0",
    "ruff>=0.4.0",
]

[tool.ruff]
line-length = 100
target-version = "py311"

[tool.ruff.lint]
select = ["E", "F", "I"]

[tool.pyright]
typeCheckingMode = "strict"

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
      path: `src/${ctx.namespace}/py.typed`,
      content: '',
      skipIfExists: true,
      integrateTarget: false,
      headerPlacement: 'skip',
    },
  ];
}
