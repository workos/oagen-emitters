import type { ApiSpec, EmitterContext, GeneratedFile, Service } from '@workos/oagen';
import { planOperation, collectModelRefs, collectEnumRefs, assignModelsToServices } from '@workos/oagen';
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
  files.push(...generateTypesCompatBarrels(spec, ctx));
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
  lines.push('    WorkOSError,');
  lines.push('    AuthenticationError,');
  lines.push('    BadRequestError,');
  lines.push('    ConflictError,');
  lines.push('    ConfigurationError,');
  lines.push('    ForbiddenError,');
  lines.push('    NotFoundError,');
  lines.push('    RateLimitExceededError,');
  lines.push('    ServerError,');
  lines.push('    UnprocessableEntityError,');
  lines.push('    WorkOSConnectionError,');
  lines.push('    WorkOSTimeoutError,');
  lines.push('    STATUS_CODE_TO_ERROR,');
  lines.push(')');
  lines.push('from ._pagination import AsyncPage, SyncPage, WorkOSListResource');
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

  lines.push('');
  lines.push('try:');
  lines.push('    from importlib.metadata import version as _pkg_version');
  lines.push('    VERSION = _pkg_version("workos")');
  lines.push('except Exception:');
  lines.push('    VERSION = "0.0.0"');
  lines.push('');
  lines.push('RETRY_STATUS_CODES = {429, 500, 502, 503, 504}');
  lines.push('MAX_RETRIES = 3');
  lines.push('INITIAL_RETRY_DELAY = 0.5');
  lines.push('MAX_RETRY_DELAY = 8.0');
  lines.push('RETRY_MULTIPLIER = 2.0');

  // --- Sync namespace classes ---
  for (const ns of namespaces) {
    const nsClassName = className(ns.prefix) + 'Namespace';
    const baseClass = ns.baseEntry ? ns.baseEntry.resolvedName : 'object';
    lines.push('');
    lines.push('');
    lines.push(`class ${nsClassName}(${baseClass}):`);
    lines.push(`    """${className(ns.prefix)} resources."""`);
    lines.push('');
    lines.push('    def __init__(self, client: "WorkOS") -> None:');
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
    lines.push('    def __init__(self, client: "AsyncWorkOS") -> None:');
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
  }

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
  lines.push(`        base_url: str = "${spec.baseUrl}",`);
  lines.push('        timeout: float = 30.0,');
  lines.push('        max_retries: int = MAX_RETRIES,');
  lines.push('    ) -> None:');
  lines.push('        self._api_key = api_key or os.environ.get("WORKOS_API_KEY")');
  lines.push('        if not self._api_key:');
  lines.push('            raise ValueError(');
  lines.push('                "WorkOS API key must be provided when instantiating the client "');
  lines.push('                "or via the WORKOS_API_KEY environment variable."');
  lines.push('            )');
  lines.push('        self.client_id = client_id or os.environ.get("WORKOS_CLIENT_ID")');
  lines.push('        if not self.client_id:');
  lines.push('            raise ValueError(');
  lines.push('                "WorkOS client ID must be provided when instantiating the client "');
  lines.push('                "or via the WORKOS_CLIENT_ID environment variable."');
  lines.push('            )');
  lines.push('        # Ensure base_url has a trailing slash for backward compatibility');
  lines.push('        self._base_url = base_url.rstrip("/") + "/"');
  lines.push('        self._timeout = timeout');
  lines.push('        self._max_retries = max_retries');
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
  lines.push('        timeout = self._timeout');
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
  lines.push('    def _build_headers(');
  lines.push('        self,');
  lines.push('        method: str,');
  lines.push('        idempotency_key: Optional[str],');
  lines.push('        request_options: Optional[RequestOptions],');
  lines.push('    ) -> Dict[str, str]:');
  lines.push('        headers: Dict[str, str] = {');
  lines.push('            "Authorization": f"Bearer {self._api_key}",');
  lines.push('            "Content-Type": "application/json",');
  lines.push('            "User-Agent": f"workos-python/{VERSION} python/{platform.python_version()}",');
  lines.push('        }');
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
  lines.push(`        base_url: str = "${spec.baseUrl}",`);
  lines.push('        timeout: float = 30.0,');
  lines.push('        max_retries: int = MAX_RETRIES,');
  lines.push('        http_client: Optional[httpx.Client] = None,');
  lines.push('    ) -> None:');
  lines.push('        """Initialize the WorkOS client.');
  lines.push('');
  lines.push('        Args:');
  lines.push('            api_key: WorkOS API key. Falls back to the WORKOS_API_KEY environment variable.');
  lines.push('            client_id: WorkOS client ID. Falls back to the WORKOS_CLIENT_ID environment variable.');
  lines.push(`            base_url: Base URL for API requests. Defaults to "${spec.baseUrl}".`);
  lines.push('            timeout: HTTP request timeout in seconds. Defaults to 30.0.');
  lines.push('            max_retries: Maximum number of retries for failed requests. Defaults to 3.');
  lines.push('            http_client: Custom httpx.Client instance for making requests.');
  lines.push('');
  lines.push('        Raises:');
  lines.push('            ValueError: If api_key is not provided and WORKOS_API_KEY is not set.');
  lines.push('        """');
  lines.push('        super().__init__(');
  lines.push('            api_key=api_key,');
  lines.push('            client_id=client_id,');
  lines.push('            base_url=base_url,');
  lines.push('            timeout=timeout,');
  lines.push('            max_retries=max_retries,');
  lines.push('        )');
  lines.push('        self._client = http_client or httpx.Client(timeout=timeout, follow_redirects=True)');
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

  // Add backward-compatible property aliases from API surface
  const compatAliases = buildCompatPropertyAliases(ctx, generatedProps);
  for (const alias of compatAliases) {
    lines.push('');
    lines.push('    @functools.cached_property');
    lines.push(`    def ${alias.name}(self) -> Any:`);
    if (alias.target) {
      lines.push(`        return self.${alias.target}`);
    } else {
      lines.push(`        return object()  # Backward-compatible stub`);
    }
  }

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
  lines.push('class AsyncWorkOS(_BaseWorkOS):');
  lines.push('    """Asynchronous WorkOS API client."""');
  lines.push('');
  lines.push('    def __init__(');
  lines.push('        self,');
  lines.push('        *,');
  lines.push('        api_key: Optional[str] = None,');
  lines.push('        client_id: Optional[str] = None,');
  lines.push(`        base_url: str = "${spec.baseUrl}",`);
  lines.push('        timeout: float = 30.0,');
  lines.push('        max_retries: int = MAX_RETRIES,');
  lines.push('        http_client: Optional[httpx.AsyncClient] = None,');
  lines.push('    ) -> None:');
  lines.push('        """Initialize the async WorkOS client.');
  lines.push('');
  lines.push('        Args:');
  lines.push('            api_key: WorkOS API key. Falls back to the WORKOS_API_KEY environment variable.');
  lines.push('            client_id: WorkOS client ID. Falls back to the WORKOS_CLIENT_ID environment variable.');
  lines.push(`            base_url: Base URL for API requests. Defaults to "${spec.baseUrl}".`);
  lines.push('            timeout: HTTP request timeout in seconds. Defaults to 30.0.');
  lines.push('            max_retries: Maximum number of retries for failed requests. Defaults to 3.');
  lines.push('            http_client: Custom httpx.AsyncClient instance for making requests.');
  lines.push('');
  lines.push('        Raises:');
  lines.push('            ValueError: If api_key is not provided and WORKOS_API_KEY is not set.');
  lines.push('        """');
  lines.push('        super().__init__(');
  lines.push('            api_key=api_key,');
  lines.push('            client_id=client_id,');
  lines.push('            base_url=base_url,');
  lines.push('            timeout=timeout,');
  lines.push('            max_retries=max_retries,');
  lines.push('        )');
  lines.push('        self._client = http_client or httpx.AsyncClient(timeout=timeout, follow_redirects=True)');
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

  // Add backward-compatible property aliases from API surface.
  const asyncCompatAliases = buildCompatPropertyAliases(ctx, asyncGeneratedProps);
  for (const alias of asyncCompatAliases) {
    lines.push('');
    if (asyncNotImplemented.has(alias.name)) {
      lines.push('    @property');
      lines.push(`    def ${alias.name}(self) -> Any:`);
      lines.push(`        raise NotImplementedError("${alias.name} is not yet available in the async client")`);
    } else {
      lines.push('    @functools.cached_property');
      lines.push(`    def ${alias.name}(self) -> Any:`);
      if (alias.target) {
        lines.push(`        return self.${alias.target}`);
      } else {
        lines.push(`        return object()  # Backward-compatible stub`);
      }
    }
  }

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
  lines.push(`${indent}    try:`);
  lines.push(`${indent}        body: Dict[str, Any] = response.json()`);
  lines.push(`${indent}        message: str = str(body.get("message", response.text))`);
  lines.push(`${indent}        code: Optional[str] = str(body["code"]) if "code" in body else None`);
  lines.push(`${indent}        param = cast(Optional[str], body.get("param"))`);
  lines.push(`${indent}    except Exception:`);
  lines.push(`${indent}        message = response.text`);
  lines.push(`${indent}        code = None`);
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
  lines.push(`${indent}                raw_body=raw_body,`);
  lines.push(`${indent}                request_url=request_url,`);
  lines.push(`${indent}                request_method=request_method,`);
  lines.push(`${indent}            )`);
  lines.push(`${indent}        raise error_class(`);
  lines.push(`${indent}            message,`);
  lines.push(`${indent}            request_id=request_id,`);
  lines.push(`${indent}            code=code,`);
  lines.push(`${indent}            param=param,`);
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
  lines.push(`${indent}            raw_body=raw_body,`);
  lines.push(`${indent}            request_url=request_url,`);
  lines.push(`${indent}            request_method=request_method,`);
  lines.push(`${indent}        )`);
  lines.push('');
  lines.push(`${indent}    raise WorkOSError(`);
  lines.push(`${indent}        message,`);
  lines.push(`${indent}        status_code=response.status_code,`);
  lines.push(`${indent}        request_id=request_id,`);
  lines.push(`${indent}        code=code,`);
  lines.push(`${indent}        param=param,`);
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
  lines.push('from ._client import AsyncWorkOS, WorkOS');
  lines.push('from ._errors import (');
  lines.push('    WorkOSError,');
  lines.push('    AuthenticationError,');
  lines.push('    BadRequestError,');
  lines.push('    ConflictError,');
  lines.push('    ConfigurationError,');
  lines.push('    ForbiddenError,');
  lines.push('    NotFoundError,');
  lines.push('    RateLimitExceededError,');
  lines.push('    ServerError,');
  lines.push('    UnprocessableEntityError,');
  lines.push('    WorkOSConnectionError,');
  lines.push('    WorkOSTimeoutError,');
  lines.push(')');
  lines.push('from ._pagination import AsyncPage, SyncPage, WorkOSListResource');
  lines.push('from ._types import RequestOptions');
  lines.push('');
  lines.push('# Backward-compatible aliases');
  lines.push('WorkOSClient = WorkOS');
  lines.push('AsyncWorkOSClient = AsyncWorkOS');
  lines.push('');
  lines.push('__all__ = [');
  lines.push('    "AsyncWorkOS",');
  lines.push('    "AsyncWorkOSClient",');
  lines.push('    "WorkOS",');
  lines.push('    "WorkOSClient",');
  lines.push('    "RequestOptions",');
  lines.push('    "WorkOSError",');
  lines.push('    "AuthenticationError",');
  lines.push('    "BadRequestError",');
  lines.push('    "ConflictError",');
  lines.push('    "ConfigurationError",');
  lines.push('    "ForbiddenError",');
  lines.push('    "NotFoundError",');
  lines.push('    "RateLimitExceededError",');
  lines.push('    "ServerError",');
  lines.push('    "UnprocessableEntityError",');
  lines.push('    "WorkOSConnectionError",');
  lines.push('    "WorkOSTimeoutError",');
  lines.push('    "AsyncPage",');
  lines.push('    "SyncPage",');
  lines.push('    "WorkOSListResource",');
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

/**
 * Generate backward-compatible workos/types/{service}/ re-export barrels.
 * In v5.x, models lived under workos.types.{module_name}. In v6.x they moved
 * to workos.{service}.models. These barrels let old import paths keep working.
 */
function generateTypesCompatBarrels(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const grouping = groupServicesByNamespace(spec.services, ctx);
  const serviceDirMap = buildServiceDirMap(grouping);

  // Known mappings from old types/ directory names to current service property names.
  // These match the client property alias mappings.
  const oldToNewProp: Record<string, string> = {
    directory_sync: 'directories',
    fga: 'authorization',
    mfa: 'multi_factor_auth',
    portal: 'admin_portal',
    connect: 'workos_connect',
  };

  // Collect all service dirs by their property name
  const propToDir = new Map<string, string>();
  for (const entry of grouping.standalone) {
    propToDir.set(entry.prop, serviceDirMap.get(entry.service.name) ?? entry.prop);
  }
  for (const ns of grouping.namespaces) {
    if (ns.baseEntry) {
      propToDir.set(servicePropertyName(ns.baseEntry.resolvedName), ns.prefix);
    }
    for (const entry of ns.entries) {
      const fullProp = `${ns.prefix}_${entry.subProp}`;
      propToDir.set(fullProp, serviceDirMap.get(entry.service.name) ?? `${ns.prefix}/${entry.subProp}`);
    }
  }

  // Generate types/{prop}/__init__.py for each service that has models
  const emittedTypeDirs = new Set<string>();
  for (const [prop, dir] of propToDir) {
    if (emittedTypeDirs.has(prop)) continue;
    emittedTypeDirs.add(prop);
    const dotModule = dirToModule(dir);
    files.push({
      path: `src/${ctx.namespace}/types/${prop}/__init__.py`,
      content: `from ${ctx.namespace}.${dotModule}.models import *  # noqa: F401,F403`,
      integrateTarget: true,
      overwriteExisting: true,
    });
  }

  // Generate aliases for old names (e.g., types/directory_sync/ → types/directories/)
  for (const [oldName, newProp] of Object.entries(oldToNewProp)) {
    if (emittedTypeDirs.has(oldName)) continue;
    const dir = propToDir.get(newProp);
    if (!dir) continue;
    emittedTypeDirs.add(oldName);
    const dotModule = dirToModule(dir);
    files.push({
      path: `src/${ctx.namespace}/types/${oldName}/__init__.py`,
      content: `from ${ctx.namespace}.${dotModule}.models import *  # noqa: F401,F403`,
      integrateTarget: true,
      overwriteExisting: true,
    });
  }

  // Generate root types/__init__.py
  files.push({
    path: `src/${ctx.namespace}/types/__init__.py`,
    content: '',
    integrateTarget: true,
    skipIfExists: true,
  });

  return files;
}

/**
 * Build backward-compatible property aliases from the API surface.
 * Maps old client property names to their closest matching generated property.
 */
function buildCompatPropertyAliases(
  ctx: EmitterContext,
  generatedProps: Set<string>,
): { name: string; target: string | null }[] {
  const aliases: { name: string; target: string | null }[] = [];

  // Read the old client property names from the API surface
  const surfaceClasses = ctx.apiSurface?.classes ?? {};
  const clientProps = new Set<string>();
  for (const clsName of ['SyncClient', 'AsyncClient', 'Client']) {
    const cls = surfaceClasses[clsName];
    if (cls?.methods) {
      for (const methodName of Object.keys(cls.methods)) {
        clientProps.add(methodName);
      }
    }
  }

  // Known mappings from old property names to generated property names
  const knownMappings: Record<string, string> = {
    directory_sync: 'directories',
    fga: 'authorization',
    mfa: 'multi_factor_auth',
    portal: 'admin_portal',
    connect: 'workos_connect',
  };

  for (const oldProp of clientProps) {
    if (generatedProps.has(oldProp)) continue; // Already exists
    const target = knownMappings[oldProp];
    if (target && generatedProps.has(target)) {
      aliases.push({ name: oldProp, target });
    } else {
      // For properties without a direct mapping (e.g., passwordless, vault, connect),
      // generate a stub property that returns a truthy placeholder.
      aliases.push({ name: oldProp, target: null });
    }
  }

  return aliases;
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
