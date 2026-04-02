import type { ApiSpec, EmitterContext, GeneratedFile, Service, SdkBehavior } from '@workos/oagen';
import {
  planOperation,
  collectModelRefs,
  collectEnumRefs,
  assignModelsToServices,
  defaultSdkBehavior,
} from '@workos/oagen';
import { className, resolveServiceDir, servicePropertyName, buildServiceDirMap, dirToModule } from './naming.js';
import type { NamespaceGroup, NamespaceGrouping } from './naming.js';
import { resolveResourceClassName } from './resources.js';

/**
 * Generate the main Python client class, barrel __init__.py files,
 * and project scaffolding (pyproject.toml, py.typed).
 */
export function generateClient(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  assertPublicClientReachability(spec, ctx);

  const files: GeneratedFile[] = [];

  files.push(...generateWorkOSClient(spec, ctx));
  files.push(...generateServiceInits(spec, ctx));
  files.push(...generateNamespaceAliasPackages(spec, ctx));
  files.push(...generateBarrel(spec, ctx));
  files.push(...generateTypesBarrels(spec, ctx));
  files.push(...generatePyProjectToml(ctx));
  files.push(...generatePyTyped(ctx));

  return files;
}

/**
 * Group services by shared snake_case prefix for nested namespaces.
 * Services sharing a common prefix (e.g., user_management_users, user_management_invitations)
 * are grouped under a namespace (user_management) with sub-properties (users, invitations).
 */
export function groupServicesByNamespace(services: Service[], ctx: EmitterContext): NamespaceGrouping {
  const entries = services.map((service) => {
    const resolvedName = resolveResourceClassName(service, ctx);
    return { service, prop: servicePropertyName(resolvedName), resolvedName };
  });

  // Build the set of all actual service property names — only these can serve as namespace prefixes.
  // This prevents over-aggressive grouping (e.g., "directory" grouping "directory_groups"
  // when there is no "Directory" service to serve as the namespace base).
  const allProps = new Set(entries.map((e) => e.prop));

  // Virtual namespaces: allow namespace groupings even when no base service exists.
  // This is needed for service clusters like user_management_* where the prefix
  // "user_management" isn't itself a service but should still form a namespace.
  const VIRTUAL_NAMESPACES = new Set(['user_management']);

  // Count how many property names contain each possible underscore-delimited prefix
  const prefixCount = new Map<string, number>();
  for (const entry of entries) {
    prefixCount.set(entry.prop, (prefixCount.get(entry.prop) || 0) + 1);
    const parts = entry.prop.split('_');
    for (let len = 1; len < parts.length; len++) {
      const prefix = parts.slice(0, len).join('_');
      prefixCount.set(prefix, (prefixCount.get(prefix) || 0) + 1);
    }
  }

  // For each entry, find the longest prefix shared by 2+ entries (that isn't the full name)
  // AND corresponds to an actual service property name.
  const entryPrefix = new Map<string, string>();
  for (const entry of entries) {
    const parts = entry.prop.split('_');
    for (let len = parts.length - 1; len >= 1; len--) {
      const prefix = parts.slice(0, len).join('_');
      if (
        (prefixCount.get(prefix) ?? 0) >= 2 &&
        prefix !== entry.prop &&
        (allProps.has(prefix) || VIRTUAL_NAMESPACES.has(prefix))
      ) {
        entryPrefix.set(entry.prop, prefix);
        break;
      }
    }
  }

  const namespacesMap = new Map<string, NamespaceGroup['entries']>();
  const standalone: typeof entries = [];

  for (const entry of entries) {
    const prefix = entryPrefix.get(entry.prop);
    if (prefix) {
      if (!namespacesMap.has(prefix)) namespacesMap.set(prefix, []);
      const subProp = entry.prop.slice(prefix.length + 1);
      namespacesMap.get(prefix)!.push({ service: entry.service, subProp, resolvedName: entry.resolvedName });
    } else {
      standalone.push(entry);
    }
  }

  // Detect standalones whose property name collides with a namespace prefix.
  // Remove them from standalone and attach as baseEntry on the namespace.
  const namespacePrefixes = new Set(namespacesMap.keys());
  const colliding = new Map<string, (typeof entries)[0]>();
  const filteredStandalone = standalone.filter((entry) => {
    if (namespacePrefixes.has(entry.prop)) {
      colliding.set(entry.prop, entry);
      return false;
    }
    return true;
  });

  const namespaces: NamespaceGroup[] = [...namespacesMap].map(([prefix, nsEntries]) => ({
    prefix,
    entries: nsEntries,
    baseEntry: colliding.get(prefix)
      ? { service: colliding.get(prefix)!.service, resolvedName: colliding.get(prefix)!.resolvedName }
      : undefined,
  }));
  return { standalone: filteredStandalone, namespaces };
}

export function buildServiceAccessPaths(services: Service[], ctx: EmitterContext): Map<string, string> {
  const { standalone, namespaces } = groupServicesByNamespace(services, ctx);
  const paths = new Map<string, string>();

  for (const entry of standalone) {
    paths.set(entry.service.name, entry.prop);
  }

  for (const ns of namespaces) {
    if (ns.baseEntry) {
      paths.set(ns.baseEntry.service.name, ns.prefix);
    }
    for (const entry of ns.entries) {
      paths.set(entry.service.name, `${ns.prefix}.${entry.subProp}`);
    }
  }

  return paths;
}

function assertPublicClientReachability(spec: ApiSpec, ctx: EmitterContext): void {
  const accessPaths = buildServiceAccessPaths(spec.services, ctx);
  const unreachableServices = spec.services
    .filter((service) => service.operations.length > 0 && !accessPaths.has(service.name))
    .map((service) => service.name);

  if (unreachableServices.length > 0) {
    throw new Error(`Python emitter reachability audit failed for services: ${unreachableServices.join(', ')}`);
  }
}

function generateWorkOSClient(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const sdk: SdkBehavior = ctx.spec.sdk ?? defaultSdkBehavior();
  const lines: string[] = [];
  const { standalone, namespaces } = groupServicesByNamespace(spec.services, ctx);

  const listWrapperNames = new Set<string>();
  for (const m of ctx.spec.models) {
    const dataField = m.fields.find((f) => f.name === 'data');
    const hasListMeta = m.fields.some((f) => f.name === 'list_metadata' || f.name === 'listMetadata');
    if (dataField && hasListMeta && dataField.type.kind === 'array') {
      listWrapperNames.add(m.name);
    }
  }

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
  lines.push('    BaseRequestException,');
  lines.push('    AuthenticationException,');
  lines.push('    BadRequestException,');
  lines.push('    ConflictException,');
  lines.push('    ConfigurationException,');
  lines.push('    AuthorizationException,');
  lines.push('    NotFoundException,');
  lines.push('    RateLimitExceededException,');
  lines.push('    ServerException,');
  lines.push('    UnprocessableEntityException,');
  lines.push('    WorkOSConnectionException,');
  lines.push('    WorkOSTimeoutException,');
  lines.push('    STATUS_CODE_TO_EXCEPTION,');
  lines.push(')');
  lines.push('from ._pagination import AsyncPage, SyncPage');
  lines.push('from ._types import D, Deserializable, RequestOptions');

  // Import resource classes (both sync and async)
  const serviceDirMap = buildServiceDirMap({ standalone, namespaces });
  for (const service of spec.services) {
    const resolvedName = resolveResourceClassName(service, ctx);
    const dirName = serviceDirMap.get(service.name) ?? resolveServiceDir(resolvedName);
    lines.push(`from .${dirToModule(dirName)}._resource import ${resolvedName}, Async${resolvedName}`);
  }

  // Collect model/enum imports needed by namespace delegate method signatures
  const delegateModelImports = new Set<string>();
  const delegateEnumImports = new Set<string>();
  for (const ns of namespaces) {
    if (!ns.baseEntry) continue;
    const baseSvc = ns.baseEntry.service;
    for (const op of baseSvc.operations) {
      const plan = planOperation(op);
      if (plan.responseModelName && !listWrapperNames.has(plan.responseModelName)) {
        delegateModelImports.add(plan.responseModelName);
      }
      if (op.pagination?.itemType.kind === 'model') {
        let paginationItemName = op.pagination.itemType.name;
        if (listWrapperNames.has(paginationItemName)) {
          const wrapperModel = ctx.spec.models.find((m) => m.name === paginationItemName);
          const dataField = wrapperModel?.fields.find((f) => f.name === 'data');
          if (dataField?.type.kind === 'array' && dataField.type.items.kind === 'model') {
            paginationItemName = dataField.type.items.name;
          }
        }
        delegateModelImports.add(paginationItemName);
      }
      if (op.requestBody?.kind === 'model') {
        const requestBodyName = op.requestBody.name;
        delegateModelImports.add(requestBodyName);
        const bodyModel = ctx.spec.models.find((m) => m.name === requestBodyName);
        if (bodyModel) {
          for (const f of bodyModel.fields) {
            for (const ref of collectModelRefs(f.type)) delegateModelImports.add(ref);
            for (const ref of collectEnumRefs(f.type)) delegateEnumImports.add(ref);
          }
        }
      }
      if (op.requestBody?.kind === 'union') {
        for (const v of (op.requestBody as any).variants ?? []) {
          if (v.kind === 'model') delegateModelImports.add(v.name);
        }
      }
      for (const p of [...op.pathParams, ...op.queryParams]) {
        for (const ref of collectEnumRefs(p.type)) delegateEnumImports.add(ref);
      }
    }
  }

  // Emit model imports grouped by service directory
  const modelToServiceMap = assignModelsToServices(ctx.spec.models, ctx.spec.services);
  const resolveModelDir = (modelName: string) => {
    const svc = modelToServiceMap.get(modelName);
    return svc ? (serviceDirMap.get(svc) ?? 'common') : 'common';
  };

  const modelsByDir = new Map<string, string[]>();
  for (const name of [...delegateModelImports].sort()) {
    const dir = resolveModelDir(name);
    if (!modelsByDir.has(dir)) modelsByDir.set(dir, []);
    modelsByDir.get(dir)!.push(className(name));
  }
  for (const [dir, names] of [...modelsByDir].sort()) {
    lines.push(`from .${dirToModule(dir)}.models import ${names.join(', ')}`);
  }

  // Emit enum imports grouped by service directory
  const enumToServiceMap = new Map<string, string>();
  for (const e of ctx.spec.enums) {
    for (const svc of ctx.spec.services) {
      for (const op of svc.operations) {
        const refs = new Set<string>();
        const allTypeRefs = [
          op.response,
          ...(op.requestBody ? [op.requestBody] : []),
          ...op.pathParams.map((p) => p.type),
          ...op.queryParams.map((p) => p.type),
        ];
        for (const typeRef of allTypeRefs) {
          for (const ref of collectEnumRefs(typeRef)) refs.add(ref);
        }
        if (refs.has(e.name) && !enumToServiceMap.has(e.name)) {
          enumToServiceMap.set(e.name, svc.name);
        }
      }
    }
  }
  const enumsByDir = new Map<string, string[]>();
  for (const name of [...delegateEnumImports].sort()) {
    const enumSvc = enumToServiceMap.get(name);
    const dir = enumSvc ? (serviceDirMap.get(enumSvc) ?? 'common') : 'common';
    if (!enumsByDir.has(dir)) enumsByDir.set(dir, []);
    enumsByDir.get(dir)!.push(className(name));
  }
  for (const [dir, names] of [...enumsByDir].sort()) {
    lines.push(`from .${dirToModule(dir)}.models import ${names.join(', ')}`);
  }
  lines.push('from .passwordless import AsyncPasswordless, Passwordless');
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

  // --- Sync namespace classes ---
  for (const ns of namespaces) {
    const nsClassName = className(ns.prefix) + 'Namespace';
    const baseClass = ns.baseEntry ? ns.baseEntry.resolvedName : 'object';
    lines.push('');
    lines.push('');
    lines.push(`class ${nsClassName}(${baseClass}):`);
    lines.push(`    """${className(ns.prefix)} resources."""`);
    lines.push('');
    lines.push('    def __init__(self, client: "WorkOSClient") -> None:');
    if (ns.baseEntry) {
      lines.push('        super().__init__(client)');
    } else {
      lines.push('        self._client = client');
    }

    if (ns.baseEntry) {
      lines.push('');
    }

    for (const entry of ns.entries) {
      lines.push('');
      lines.push('    @functools.cached_property');
      lines.push(`    def ${entry.subProp}(self) -> ${entry.resolvedName}:`);
      lines.push(`        return ${entry.resolvedName}(self._client)`);
    }

    if (ns.prefix === 'user_management') {
      lines.push('');
      lines.push('    def load_sealed_session(self, *, sealed_session: str, cookie_password: str) -> Session:');
      lines.push('        return Session(');
      lines.push('            client=self._client,');
      lines.push('            session_data=sealed_session,');
      lines.push('            cookie_password=cookie_password,');
      lines.push('        )');
    }
    if (ns.prefix === 'multi_factor_auth') {
      lines.push('');
      lines.push('    def verify_challenge(');
      lines.push('        self,');
      lines.push('        *,');
      lines.push('        authentication_challenge_id: str,');
      lines.push('        code: str,');
      lines.push('        request_options: Optional[RequestOptions] = None,');
      lines.push('    ) -> Any:');
      lines.push(
        '        return self.challenges.verify(authentication_challenge_id, code=code, request_options=request_options)',
      );
    }
  }

  // --- Async namespace classes ---
  for (const ns of namespaces) {
    const asyncNsClassName = 'Async' + className(ns.prefix) + 'Namespace';
    const baseClass = ns.baseEntry ? `Async${ns.baseEntry.resolvedName}` : 'object';
    lines.push('');
    lines.push('');
    lines.push(`class ${asyncNsClassName}(${baseClass}):`);
    lines.push(`    """${className(ns.prefix)} resources (async)."""`);
    lines.push('');
    lines.push('    def __init__(self, client: "AsyncWorkOSClient") -> None:');
    if (ns.baseEntry) {
      lines.push('        super().__init__(client)');
    } else {
      lines.push('        self._client = client');
    }

    if (ns.baseEntry) {
      lines.push('');
    }

    for (const entry of ns.entries) {
      lines.push('');
      lines.push('    @functools.cached_property');
      lines.push(`    def ${entry.subProp}(self) -> Async${entry.resolvedName}:`);
      lines.push(`        return Async${entry.resolvedName}(self._client)`);
    }

    if (ns.prefix === 'user_management') {
      lines.push('');
      lines.push('    def load_sealed_session(self, *, sealed_session: str, cookie_password: str) -> AsyncSession:');
      lines.push('        return AsyncSession(');
      lines.push('            client=self._client,');
      lines.push('            session_data=sealed_session,');
      lines.push('            cookie_password=cookie_password,');
      lines.push('        )');
    }
    if (ns.prefix === 'multi_factor_auth') {
      lines.push('');
      lines.push('    async def verify_challenge(');
      lines.push('        self,');
      lines.push('        *,');
      lines.push('        authentication_challenge_id: str,');
      lines.push('        code: str,');
      lines.push('        request_options: Optional[RequestOptions] = None,');
      lines.push('    ) -> Any:');
      lines.push(
        '        return await self.challenges.verify(authentication_challenge_id, code=code, request_options=request_options)',
      );
    }
  }

  lines.push('');
  lines.push('');
  lines.push('class _BaseWorkOSClient:');
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
  lines.push('        parsed_retry_after = _BaseWorkOSClient._parse_retry_after(retry_after)');
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
  lines.push('            raise ConfigurationException(');
  lines.push(
    '                "This operation requires a WorkOS API key. Provide api_key when instantiating the client "',
  );
  lines.push('                "or via the WORKOS_API_KEY environment variable."');
  lines.push('            )');
  lines.push('        return self._api_key');
  lines.push('');
  lines.push('    def _require_client_id(self) -> str:');
  lines.push('        if not self.client_id:');
  lines.push('            raise ConfigurationException(');
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
  lines.push('class WorkOSClient(_BaseWorkOSClient):');
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
  lines.push('    def __enter__(self) -> "WorkOSClient":');
  lines.push('        return self');
  lines.push('');
  lines.push('    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:');
  lines.push('        self.close()');

  // Collect all generated property names
  const generatedProps = new Set<string>();
  for (const entry of standalone) {
    lines.push('');
    lines.push('    @functools.cached_property');
    lines.push(`    def ${entry.prop}(self) -> ${entry.resolvedName}:`);
    lines.push(`        return ${entry.resolvedName}(self)`);
    generatedProps.add(entry.prop);
  }

  for (const ns of namespaces) {
    const nsClassName = className(ns.prefix) + 'Namespace';
    lines.push('');
    lines.push('    @functools.cached_property');
    lines.push(`    def ${ns.prefix}(self) -> ${nsClassName}:`);
    lines.push(`        return ${nsClassName}(self)`);
    generatedProps.add(ns.prefix);
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
  lines.push('                raise WorkOSTimeoutException(f"Request timed out: {e}") from e');
  lines.push('            except httpx.ConnectError as e:');
  lines.push('                last_error = e');
  lines.push('                if attempt < max_retries:');
  lines.push('                    time.sleep(self._calculate_retry_delay(attempt))');
  lines.push('                    continue');
  lines.push('                raise WorkOSConnectionException(f"Connection failed: {e}") from e');
  lines.push('            except httpx.HTTPError as e:');
  lines.push('                last_error = e');
  lines.push('                if attempt < max_retries:');
  lines.push('                    time.sleep(self._calculate_retry_delay(attempt))');
  lines.push('                    continue');
  lines.push('                raise BaseRequestException(f"Network error: {e}") from e');
  lines.push('        raise BaseRequestException("Max retries exceeded") from last_error');
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
  lines.push('        list_metadata: Dict[str, Any] = cast(Dict[str, Any], data.get("list_metadata", {}))');
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
  lines.push('class AsyncWorkOSClient(_BaseWorkOSClient):');
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
  lines.push('    async def __aenter__(self) -> "AsyncWorkOSClient":');
  lines.push('        return self');
  lines.push('');
  lines.push('    async def __aexit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:');
  lines.push('        await self.close()');

  // All services now have generated async resource classes, so none should be
  // marked as not-implemented.  The old surface-based detection
  // (getAsyncNotImplementedModules) is no longer needed.
  const asyncNotImplemented = new Set<string>();

  const asyncGeneratedProps = new Set<string>();
  for (const entry of standalone) {
    // Skip generating real property if it will be overridden as not-implemented
    if (asyncNotImplemented.has(entry.prop)) {
      asyncGeneratedProps.add(entry.prop);
      lines.push('');
      lines.push('    @property');
      lines.push(`    def ${entry.prop}(self) -> Any:`);
      lines.push(`        raise NotImplementedError("${entry.prop} is not yet available in the async client")`);
      continue;
    }
    lines.push('');
    lines.push('    @functools.cached_property');
    lines.push(`    def ${entry.prop}(self) -> Async${entry.resolvedName}:`);
    lines.push(`        return Async${entry.resolvedName}(self)`);
    asyncGeneratedProps.add(entry.prop);
  }

  for (const ns of namespaces) {
    const asyncNsClassName = 'Async' + className(ns.prefix) + 'Namespace';
    // Skip generating real property if it will be overridden as not-implemented
    if (asyncNotImplemented.has(ns.prefix)) {
      asyncGeneratedProps.add(ns.prefix);
      lines.push('');
      lines.push('    @property');
      lines.push(`    def ${ns.prefix}(self) -> Any:`);
      lines.push(`        raise NotImplementedError("${ns.prefix} is not yet available in the async client")`);
      continue;
    }
    lines.push('');
    lines.push('    @functools.cached_property');
    lines.push(`    def ${ns.prefix}(self) -> ${asyncNsClassName}:`);
    lines.push(`        return ${asyncNsClassName}(self)`);
    asyncGeneratedProps.add(ns.prefix);
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
  lines.push('                raise WorkOSTimeoutException(f"Request timed out: {e}") from e');
  lines.push('            except httpx.ConnectError as e:');
  lines.push('                last_error = e');
  lines.push('                if attempt < max_retries:');
  lines.push('                    await asyncio.sleep(self._calculate_retry_delay(attempt))');
  lines.push('                    continue');
  lines.push('                raise WorkOSConnectionException(f"Connection failed: {e}") from e');
  lines.push('            except httpx.HTTPError as e:');
  lines.push('                last_error = e');
  lines.push('                if attempt < max_retries:');
  lines.push('                    await asyncio.sleep(self._calculate_retry_delay(attempt))');
  lines.push('                    continue');
  lines.push('                raise BaseRequestException(f"Network error: {e}") from e');
  lines.push('        raise BaseRequestException("Max retries exceeded") from last_error');
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
  lines.push('        list_metadata: Dict[str, Any] = cast(Dict[str, Any], data.get("list_metadata", {}))');
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
  lines.push('');
  lines.push('');
  lines.push('# Top-level client aliases retained for SDK ergonomics and internal typing');
  lines.push('WorkOS = WorkOSClient');
  lines.push('AsyncWorkOS = AsyncWorkOSClient');
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
  lines.push(`${indent}    error_class = STATUS_CODE_TO_EXCEPTION.get(response.status_code)`);
  lines.push(`${indent}    if error_class:`);
  lines.push(`${indent}        if error_class is RateLimitExceededException:`);
  lines.push(
    `${indent}            retry_after = _BaseWorkOSClient._parse_retry_after(response.headers.get("Retry-After"))`,
  );
  lines.push(`${indent}            raise RateLimitExceededException(`);
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
  lines.push(`${indent}        raise ServerException(`);
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
  lines.push(`${indent}    raise BaseRequestException(`);
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
  const grouping = groupServicesByNamespace(spec.services, ctx);
  const serviceDirMap = buildServiceDirMap(grouping);

  for (const service of spec.services) {
    const resolvedName = resolveResourceClassName(service, ctx);
    const dirName = serviceDirMap.get(service.name) ?? resolveServiceDir(resolvedName);
    const lines: string[] = [];

    // P3-6: explicit resource re-export + star models
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

function generateNamespaceAliasPackages(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const grouping = groupServicesByNamespace(spec.services, ctx);
  const serviceDirMap = buildServiceDirMap(grouping);

  // Build set of service dir names to avoid overwriting service inits
  const serviceDirs = new Set(serviceDirMap.values());

  for (const ns of grouping.namespaces) {
    // Only generate the namespace prefix __init__.py when there's no baseEntry AND
    // the prefix doesn't correspond to an actual service directory (which
    // already gets its __init__.py from generateServiceInits).
    if (!ns.baseEntry && !serviceDirs.has(ns.prefix)) {
      files.push({
        path: `src/${ctx.namespace}/${ns.prefix}/__init__.py`,
        content: '',
        integrateTarget: true,
        overwriteExisting: true,
      });
    }

    // Sub-services now live directly in their nested directory
    // (e.g., src/workos/organizations/api_keys/), so no alias re-exports needed.
    // We still add a _compat import for backward compatibility if present.
  }

  return files;
}

function generateBarrel(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const lines: string[] = [];

  lines.push('"""WorkOS Python SDK."""');
  lines.push('');
  // P0-5 + P1-1: import both sync and async clients
  lines.push('from ._client import AsyncWorkOSClient, WorkOSClient');
  lines.push('from ._errors import (');
  lines.push('    BaseRequestException,');
  lines.push('    AuthenticationException,');
  lines.push('    BadRequestException,');
  lines.push('    ConflictException,');
  lines.push('    ConfigurationException,');
  lines.push('    AuthorizationException,');
  lines.push('    NotFoundException,');
  lines.push('    RateLimitExceededException,');
  lines.push('    ServerException,');
  lines.push('    UnprocessableEntityException,');
  lines.push('    WorkOSConnectionException,');
  lines.push('    WorkOSTimeoutException,');
  lines.push(')');
  lines.push('from ._pagination import AsyncPage, SyncPage');
  lines.push('from ._types import RequestOptions');
  lines.push('');
  lines.push('WorkOS = WorkOSClient');
  lines.push('AsyncWorkOS = AsyncWorkOSClient');
  lines.push('');
  lines.push('__all__ = [');
  lines.push('    "WorkOSClient",');
  lines.push('    "AsyncWorkOSClient",');
  lines.push('    "WorkOS",');
  lines.push('    "AsyncWorkOS",');
  lines.push('    "RequestOptions",');
  lines.push('    "BaseRequestException",');
  lines.push('    "AuthenticationException",');
  lines.push('    "BadRequestException",');
  lines.push('    "ConflictException",');
  lines.push('    "ConfigurationException",');
  lines.push('    "AuthorizationException",');
  lines.push('    "NotFoundException",');
  lines.push('    "RateLimitExceededException",');
  lines.push('    "ServerException",');
  lines.push('    "UnprocessableEntityException",');
  lines.push('    "WorkOSConnectionException",');
  lines.push('    "WorkOSTimeoutException",');
  lines.push('    "AsyncPage",');
  lines.push('    "SyncPage",');
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
  const grouping = groupServicesByNamespace(spec.services, ctx);
  const serviceDirMap = buildServiceDirMap(grouping);

  // Collect (types dir name → set of service dirs whose models should be re-exported)
  const typesEntries = new Map<string, Set<string>>();

  for (const entry of grouping.standalone) {
    const dir = serviceDirMap.get(entry.service.name) ?? entry.prop;
    const dirs = typesEntries.get(entry.prop) ?? new Set();
    dirs.add(dir);
    typesEntries.set(entry.prop, dirs);
  }

  for (const ns of grouping.namespaces) {
    const dirs = typesEntries.get(ns.prefix) ?? new Set();
    if (ns.baseEntry) {
      dirs.add(serviceDirMap.get(ns.baseEntry.service.name) ?? ns.prefix);
    }
    for (const entry of ns.entries) {
      dirs.add(serviceDirMap.get(entry.service.name) ?? `${ns.prefix}/${entry.subProp}`);
    }
    typesEntries.set(ns.prefix, dirs);
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
