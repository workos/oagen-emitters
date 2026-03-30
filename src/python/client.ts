import type { ApiSpec, EmitterContext, GeneratedFile, Operation, Service } from '@workos/oagen';
import { planOperation, collectModelRefs, collectEnumRefs, assignModelsToServices } from '@workos/oagen';
import { mapTypeRefUnquoted } from './type-map.js';
import {
  className,
  fieldName,
  resolveServiceDir,
  servicePropertyName,
  resolveMethodName,
  buildServiceNameMap,
} from './naming.js';
import { resolveResourceClassName, resolvePageItemName, bodyParamName } from './resources.js';

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

/** Namespace grouping result. */
interface NamespaceGroup {
  prefix: string;
  entries: { service: Service; subProp: string; resolvedName: string }[];
  /** When a standalone service's property name matches this namespace prefix,
   *  the namespace class inherits from it so both resource methods and
   *  sub-properties are accessible via one client accessor. */
  baseEntry?: { service: Service; resolvedName: string };
}

/**
 * Group services by shared snake_case prefix for nested namespaces.
 * Services sharing a common prefix (e.g., user_management_users, user_management_invitations)
 * are grouped under a namespace (user_management) with sub-properties (users, invitations).
 */
export function groupServicesByNamespace(
  services: Service[],
  ctx: EmitterContext,
): {
  standalone: { service: Service; prop: string; resolvedName: string }[];
  namespaces: NamespaceGroup[];
} {
  const entries = services.map((service) => {
    const resolvedName = resolveResourceClassName(service, ctx);
    return { service, prop: servicePropertyName(resolvedName), resolvedName };
  });

  // Count how many property names contain each possible underscore-delimited prefix
  const prefixCount = new Map<string, number>();
  for (const entry of entries) {
    const parts = entry.prop.split('_');
    for (let len = 1; len < parts.length; len++) {
      const prefix = parts.slice(0, len).join('_');
      prefixCount.set(prefix, (prefixCount.get(prefix) || 0) + 1);
    }
  }

  // For each entry, find the longest prefix shared by 2+ entries (that isn't the full name)
  const entryPrefix = new Map<string, string>();
  for (const entry of entries) {
    const parts = entry.prop.split('_');
    for (let len = parts.length - 1; len >= 1; len--) {
      const prefix = parts.slice(0, len).join('_');
      if ((prefixCount.get(prefix) ?? 0) >= 2 && prefix !== entry.prop) {
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

/**
 * Build typed delegate parameters and forward args for a namespace wrapper method.
 * Returns { sigParams: string[], forwardArgs: string[], returnType: string }
 * where sigParams are the `name: Type` parameter strings (excluding self) and
 * forwardArgs are the `name=name` keyword forwarding strings.
 */
function buildDelegateSignature(
  op: Operation,
  service: Service,
  ctx: EmitterContext,
  specEnumNames: Set<string>,
  listWrapperNames: Set<string>,
): { sigParams: string[]; forwardArgs: string[]; returnType: string } {
  const plan = planOperation(op);
  const sigParams: string[] = [];
  const forwardArgs: string[] = [];

  // Path params as positional args
  for (const param of op.pathParams) {
    const pn = fieldName(param.name);
    const pt = mapTypeRefUnquoted(param.type, specEnumNames);
    sigParams.push(`${pn}: ${pt}`);
    forwardArgs.push(pn);
  }

  // Keyword-only marker
  sigParams.push('*');

  const pathParamNames = new Set(op.pathParams.map((p) => fieldName(p.name)));

  // Body fields
  if (plan.hasBody && op.requestBody) {
    const bodyModel = ctx.spec.models.find((m) => op.requestBody?.kind === 'model' && m.name === op.requestBody.name);
    if (bodyModel) {
      const reqFields = bodyModel.fields.filter((f) => f.required);
      const optFields = bodyModel.fields.filter((f) => !f.required);
      for (const f of reqFields) {
        const fn = bodyParamName(f, pathParamNames);
        sigParams.push(`${fn}: ${mapTypeRefUnquoted(f.type, specEnumNames)}`);
        forwardArgs.push(`${fn}=${fn}`);
      }
      for (const f of optFields) {
        const fn = bodyParamName(f, pathParamNames);
        const innerType =
          f.type.kind === 'nullable'
            ? mapTypeRefUnquoted(f.type.inner, specEnumNames)
            : mapTypeRefUnquoted(f.type, specEnumNames);
        sigParams.push(`${fn}: Optional[${innerType}] = None`);
        forwardArgs.push(`${fn}=${fn}`);
      }
    } else if (op.requestBody.kind === 'union') {
      const variantModels = (op.requestBody.variants ?? [])
        .filter((v: any) => v.kind === 'model')
        .map((v: any) => className(v.name));
      if (variantModels.length > 0) {
        const unionType = `Union[${[...variantModels, 'Dict[str, Any]'].join(', ')}]`;
        sigParams.push(`body: ${unionType}`);
      } else {
        sigParams.push('body: Dict[str, Any]');
      }
      forwardArgs.push('body=body');
    } else {
      sigParams.push('body: Optional[Dict[str, Any]] = None');
      forwardArgs.push('body=body');
    }
  }

  // Query params
  const isPaginated = plan.isPaginated;
  if (plan.hasQueryParams && !isPaginated) {
    for (const param of op.queryParams) {
      const pn = fieldName(param.name);
      if (pathParamNames.has(pn)) continue;
      if (plan.hasBody && op.requestBody?.kind === 'model') {
        const bodyModel = ctx.spec.models.find(
          (m) => op.requestBody?.kind === 'model' && m.name === op.requestBody.name,
        );
        if (bodyModel?.fields.some((f) => fieldName(f.name) === pn)) continue;
      }
      const pt = mapTypeRefUnquoted(param.type, specEnumNames);
      if (param.required) {
        sigParams.push(`${pn}: ${pt}`);
      } else {
        sigParams.push(`${pn}: Optional[${pt}] = None`);
      }
      forwardArgs.push(`${pn}=${pn}`);
    }
  }

  // Pagination params
  if (isPaginated) {
    sigParams.push('limit: Optional[int] = None');
    sigParams.push('before: Optional[str] = None');
    sigParams.push('after: Optional[str] = None');
    const orderParam = op.queryParams.find((p) => p.name === 'order');
    const orderType =
      orderParam && orderParam.type.kind === 'enum' ? mapTypeRefUnquoted(orderParam.type, specEnumNames) : 'str';
    sigParams.push(`order: Optional[${orderType}] = None`);
    forwardArgs.push('limit=limit', 'before=before', 'after=after', 'order=order');
    for (const param of op.queryParams) {
      if (['limit', 'before', 'after', 'order'].includes(param.name)) continue;
      const pn = fieldName(param.name);
      const pt = mapTypeRefUnquoted(param.type, specEnumNames);
      if (param.required) {
        sigParams.push(`${pn}: ${pt}`);
      } else {
        sigParams.push(`${pn}: Optional[${pt}] = None`);
      }
      forwardArgs.push(`${pn}=${pn}`);
    }
  }

  if (plan.isIdempotentPost) {
    sigParams.push('idempotency_key: Optional[str] = None');
    forwardArgs.push('idempotency_key=idempotency_key');
  }

  sigParams.push('request_options: Optional[RequestOptions] = None');
  forwardArgs.push('request_options=request_options');

  // Return type
  let returnType: string;
  if (plan.isDelete) {
    returnType = 'None';
  } else if (isPaginated) {
    const resolvedItem = resolvePageItemName(op.pagination!.itemType, listWrapperNames, ctx);
    returnType = `SyncPage[${className(resolvedItem)}]`;
  } else if (plan.responseModelName) {
    returnType = className(plan.responseModelName);
  } else {
    returnType = 'None';
  }

  return { sigParams, forwardArgs, returnType };
}

function generateWorkOSClient(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const lines: string[] = [];
  const { standalone, namespaces } = groupServicesByNamespace(spec.services, ctx);

  // Build sets needed for typed delegate signatures
  const specEnumNames = new Set(ctx.spec.enums.map((e) => e.name));
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
  lines.push('from ._pagination import AsyncPage, SyncPage');
  lines.push('from ._types import D, Deserializable, RequestOptions');

  // Import resource classes (both sync and async)
  for (const service of spec.services) {
    const resolvedName = resolveResourceClassName(service, ctx);
    const dirName = resolveServiceDir(resolvedName);
    lines.push(`from .${dirName}._resource import ${resolvedName}, Async${resolvedName}`);
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
        delegateModelImports.add(op.requestBody.name);
        const bodyModel = ctx.spec.models.find((m) => m.name === op.requestBody?.name);
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
  const serviceNameMap = buildServiceNameMap(ctx.spec.services, ctx);
  const resolveModelDir = (modelName: string) => {
    const svc = modelToServiceMap.get(modelName);
    return svc ? resolveServiceDir(serviceNameMap.get(svc) ?? svc) : 'common';
  };

  const modelsByDir = new Map<string, string[]>();
  for (const name of [...delegateModelImports].sort()) {
    const dir = resolveModelDir(name);
    if (!modelsByDir.has(dir)) modelsByDir.set(dir, []);
    modelsByDir.get(dir)!.push(className(name));
  }
  for (const [dir, names] of [...modelsByDir].sort()) {
    lines.push(`from .${dir}.models import ${names.join(', ')}`);
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
    const dir = enumSvc ? resolveServiceDir(serviceNameMap.get(enumSvc) ?? enumSvc) : 'common';
    if (!enumsByDir.has(dir)) enumsByDir.set(dir, []);
    enumsByDir.get(dir)!.push(className(name));
  }
  for (const [dir, names] of [...enumsByDir].sort()) {
    lines.push(`from .${dir}.models import ${names.join(', ')}`);
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

  // --- Sync namespace classes (composition, not inheritance) ---
  for (const ns of namespaces) {
    const nsClassName = className(ns.prefix) + 'Namespace';
    lines.push('');
    lines.push('');
    lines.push(`class ${nsClassName}:`);
    lines.push(`    """${className(ns.prefix)} resources."""`);
    lines.push('');
    lines.push('    def __init__(self, client: "WorkOS") -> None:');
    lines.push('        self._client = client');

    // If there is a base entry, expose it as a composed property and delegate its methods
    if (ns.baseEntry) {
      lines.push('');
      lines.push('    @functools.cached_property');
      lines.push(`    def _base(self) -> ${ns.baseEntry.resolvedName}:`);
      lines.push(`        return ${ns.baseEntry.resolvedName}(self._client)`);

      // Find the base service to get its operations and generate typed delegation methods
      const baseSvc = ns.baseEntry.service;
      const emittedDelegates = new Set<string>();
      for (const op of baseSvc.operations) {
        const method = resolveMethodName(op, baseSvc, ctx);
        if (emittedDelegates.has(method)) continue;
        emittedDelegates.add(method);

        const { sigParams, forwardArgs, returnType } = buildDelegateSignature(
          op,
          baseSvc,
          ctx,
          specEnumNames,
          listWrapperNames,
        );

        // Build the signature line: positional params, then *, then keyword params
        const positionalParams = sigParams.slice(0, sigParams.indexOf('*'));
        const kwParams = sigParams.slice(sigParams.indexOf('*') + 1);

        lines.push('');
        lines.push(`    def ${method}(`);
        lines.push('        self,');
        for (const p of positionalParams) {
          lines.push(`        ${p},`);
        }
        if (kwParams.length > 0) {
          lines.push('        *,');
          for (const p of kwParams) {
            lines.push(`        ${p},`);
          }
        }
        lines.push(`    ) -> ${returnType}:`);
        lines.push(`        """Delegate to base resource."""`);

        // Build forward call: positional args first, then keyword args
        const positionalForward = forwardArgs.filter((a) => !a.includes('='));
        const kwForward = forwardArgs.filter((a) => a.includes('='));
        const allForward = [...positionalForward, ...kwForward].join(', ');
        lines.push(`        return self._base.${method}(${allForward})`);
      }
    }

    for (const entry of ns.entries) {
      lines.push('');
      lines.push('    @functools.cached_property');
      lines.push(`    def ${entry.subProp}(self) -> ${entry.resolvedName}:`);
      lines.push(`        return ${entry.resolvedName}(self._client)`);
    }
  }

  // --- Async namespace classes (composition, not inheritance) ---
  for (const ns of namespaces) {
    const asyncNsClassName = 'Async' + className(ns.prefix) + 'Namespace';
    lines.push('');
    lines.push('');
    lines.push(`class ${asyncNsClassName}:`);
    lines.push(`    """${className(ns.prefix)} resources (async)."""`);
    lines.push('');
    lines.push('    def __init__(self, client: "AsyncWorkOS") -> None:');
    lines.push('        self._client = client');

    // If there is a base entry, compose and delegate
    if (ns.baseEntry) {
      lines.push('');
      lines.push('    @functools.cached_property');
      lines.push(`    def _base(self) -> Async${ns.baseEntry.resolvedName}:`);
      lines.push(`        return Async${ns.baseEntry.resolvedName}(self._client)`);

      const baseSvc = ns.baseEntry.service;
      const asyncEmittedDelegates = new Set<string>();
      for (const op of baseSvc.operations) {
        const method = resolveMethodName(op, baseSvc, ctx);
        if (asyncEmittedDelegates.has(method)) continue;
        asyncEmittedDelegates.add(method);

        const {
          sigParams,
          forwardArgs,
          returnType: syncReturnType,
        } = buildDelegateSignature(op, baseSvc, ctx, specEnumNames, listWrapperNames);

        // Swap SyncPage -> AsyncPage in return type for async variant
        const returnType = syncReturnType.replace(/^SyncPage/, 'AsyncPage');

        const positionalParams = sigParams.slice(0, sigParams.indexOf('*'));
        const kwParams = sigParams.slice(sigParams.indexOf('*') + 1);

        lines.push('');
        lines.push(`    async def ${method}(`);
        lines.push('        self,');
        for (const p of positionalParams) {
          lines.push(`        ${p},`);
        }
        if (kwParams.length > 0) {
          lines.push('        *,');
          for (const p of kwParams) {
            lines.push(`        ${p},`);
          }
        }
        lines.push(`    ) -> ${returnType}:`);
        lines.push(`        """Delegate to base resource."""`);

        const positionalForward = forwardArgs.filter((a) => !a.includes('='));
        const kwForward = forwardArgs.filter((a) => a.includes('='));
        const allForward = [...positionalForward, ...kwForward].join(', ');
        lines.push(`        return await self._base.${method}(${allForward})`);
      }
    }

    for (const entry of ns.entries) {
      lines.push('');
      lines.push('    @functools.cached_property');
      lines.push(`    def ${entry.subProp}(self) -> Async${entry.resolvedName}:`);
      lines.push(`        return Async${entry.resolvedName}(self._client)`);
    }
  }

  // ===========================================================================
  // WorkOS (sync) class
  // ===========================================================================
  lines.push('');
  lines.push('');
  lines.push('class WorkOS:');
  lines.push(`    """${ctx.namespacePascal} API client."""`);
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
  lines.push('            raise ConfigurationError(');
  lines.push('                "No API key provided. Pass it to the WorkOS constructor "');
  lines.push('                "or set the WORKOS_API_KEY environment variable."');
  lines.push('            )');
  lines.push('        self.client_id = client_id or os.environ.get("WORKOS_CLIENT_ID")');
  lines.push('        self._base_url = base_url.rstrip("/")');
  lines.push('        self._timeout = timeout');
  lines.push('        self._max_retries = max_retries');
  lines.push('        self._client = httpx.Client(timeout=timeout)');

  lines.push('');
  lines.push('    @property');
  lines.push('    def base_url(self) -> str:');
  lines.push('        """The base URL for API requests."""');
  lines.push('        return self._base_url');

  // P0-4: close / context manager
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

  // P3-5: lazy resource accessors (standalone)
  for (const entry of standalone) {
    lines.push('');
    lines.push('    @functools.cached_property');
    lines.push(`    def ${entry.prop}(self) -> ${entry.resolvedName}:`);
    lines.push(`        return ${entry.resolvedName}(self)`);
  }

  // P1-2: lazy namespace accessors
  for (const ns of namespaces) {
    const nsClassName = className(ns.prefix) + 'Namespace';
    lines.push('');
    lines.push('    @functools.cached_property');
    lines.push(`    def ${ns.prefix}(self) -> ${nsClassName}:`);
    lines.push(`        return ${nsClassName}(self)`);
  }

  // request overloads
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
  lines.push('        url = f"{self._base_url}/{path}"');
  lines.push('        headers: Dict[str, str] = {');
  lines.push('            "Authorization": f"Bearer {self._api_key}",');
  lines.push('            "Content-Type": "application/json",');
  // P3-4: versioned User-Agent
  lines.push('            "User-Agent": f"workos-python/{VERSION} python/{platform.python_version()}",');
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
  lines.push('                headers.update(cast(Dict[str, str], extra))');
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
  // P0-1: identity check instead of truthiness check
  lines.push('                    json=body if body is not None else None,');
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
  lines.push('                data: Dict[str, Any] = cast(Dict[str, Any], response.json())');
  lines.push('                if model is not None:');
  lines.push('                    return model.from_dict(data)');
  lines.push('                return data');
  lines.push('');
  // P1-3: specific transport exception catches
  lines.push('            except httpx.TimeoutException as e:');
  lines.push('                last_error = e');
  lines.push('                if attempt < self._max_retries:');
  lines.push('                    delay = min(');
  lines.push('                        INITIAL_RETRY_DELAY * (RETRY_MULTIPLIER ** attempt),');
  lines.push('                        MAX_RETRY_DELAY,');
  lines.push('                    )');
  lines.push('                    delay = delay * (0.5 + random.random())');
  lines.push('                    time.sleep(delay)');
  lines.push('                    continue');
  lines.push('                raise WorkOSTimeoutError(f"Request timed out: {e}") from e');
  lines.push('            except httpx.ConnectError as e:');
  lines.push('                last_error = e');
  lines.push('                if attempt < self._max_retries:');
  lines.push('                    delay = min(');
  lines.push('                        INITIAL_RETRY_DELAY * (RETRY_MULTIPLIER ** attempt),');
  lines.push('                        MAX_RETRY_DELAY,');
  lines.push('                    )');
  lines.push('                    delay = delay * (0.5 + random.random())');
  lines.push('                    time.sleep(delay)');
  lines.push('                    continue');
  lines.push('                raise WorkOSConnectionError(f"Connection failed: {e}") from e');
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

  // request_page with P0-2 fix
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
  lines.push('        items: list[D] = [');
  lines.push('            cast(D, model.from_dict(cast(Dict[str, Any], item)))');
  lines.push('            for item in raw_items');
  lines.push('        ]');
  lines.push('        list_metadata: Dict[str, Any] = cast(Dict[str, Any], data.get("list_metadata", {}))');
  lines.push('');
  // P0-2: strip "before" from params to prevent conflicting pagination directives
  lines.push('        def _fetch(*, after: Optional[str] = None) -> SyncPage[D]:');
  lines.push('            clean_params = {k: v for k, v in (params or {}).items() if k != "before"}');
  lines.push('            return self.request_page(');
  lines.push('                method=method,');
  lines.push('                path=path,');
  lines.push('                model=model,');
  lines.push('                params={**clean_params, "after": after},');
  lines.push('                body=body,');
  lines.push('                request_options=request_options,');
  lines.push('            )');
  lines.push('');
  lines.push('        return SyncPage(');
  lines.push('            data=items,');
  lines.push('            list_metadata=list_metadata,');
  lines.push('            _fetch_page=_fetch,');
  lines.push('        )');

  // _raise_error static method
  emitRaiseError(lines);

  // ===========================================================================
  // AsyncWorkOS class (P1-1)
  // ===========================================================================
  lines.push('');
  lines.push('');
  lines.push('class AsyncWorkOS:');
  lines.push(`    """${ctx.namespacePascal} API client (async)."""`);
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
  lines.push('            raise ConfigurationError(');
  lines.push('                "No API key provided. Pass it to the AsyncWorkOS constructor "');
  lines.push('                "or set the WORKOS_API_KEY environment variable."');
  lines.push('            )');
  lines.push('        self.client_id = client_id or os.environ.get("WORKOS_CLIENT_ID")');
  lines.push('        self._base_url = base_url.rstrip("/")');
  lines.push('        self._timeout = timeout');
  lines.push('        self._max_retries = max_retries');
  lines.push('        self._client = httpx.AsyncClient(timeout=timeout)');

  lines.push('');
  lines.push('    @property');
  lines.push('    def base_url(self) -> str:');
  lines.push('        """The base URL for API requests."""');
  lines.push('        return self._base_url');

  // async close / context manager
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

  // Lazy async resource accessors (standalone)
  for (const entry of standalone) {
    lines.push('');
    lines.push('    @functools.cached_property');
    lines.push(`    def ${entry.prop}(self) -> Async${entry.resolvedName}:`);
    lines.push(`        return Async${entry.resolvedName}(self)`);
  }

  // Lazy async namespace accessors
  for (const ns of namespaces) {
    const asyncNsClassName = 'Async' + className(ns.prefix) + 'Namespace';
    lines.push('');
    lines.push('    @functools.cached_property');
    lines.push(`    def ${ns.prefix}(self) -> ${asyncNsClassName}:`);
    lines.push(`        return ${asyncNsClassName}(self)`);
  }

  // async request overloads
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
  lines.push('        url = f"{self._base_url}/{path}"');
  lines.push('        headers: Dict[str, str] = {');
  lines.push('            "Authorization": f"Bearer {self._api_key}",');
  lines.push('            "Content-Type": "application/json",');
  lines.push('            "User-Agent": f"workos-python/{VERSION} python/{platform.python_version()}",');
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
  lines.push('                headers.update(cast(Dict[str, str], extra))');
  lines.push('            t = request_options.get("timeout")');
  lines.push('            if isinstance(t, (int, float)):');
  lines.push('                timeout = float(t)');
  lines.push('');
  lines.push('        last_error: Optional[Exception] = None');
  lines.push('        for attempt in range(self._max_retries + 1):');
  lines.push('            try:');
  lines.push('                response = await self._client.request(');
  lines.push('                    method=method.upper(),');
  lines.push('                    url=url,');
  lines.push('                    params=params,');
  lines.push('                    json=body if body is not None else None,');
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
  lines.push('                    await asyncio.sleep(delay)');
  lines.push('                    continue');
  lines.push('');
  lines.push('                if response.status_code >= 400:');
  lines.push('                    self._raise_error(response)');
  lines.push('');
  lines.push('                if response.status_code == 204 or not response.content:');
  lines.push('                    return None');
  lines.push('');
  lines.push('                data: Dict[str, Any] = cast(Dict[str, Any], response.json())');
  lines.push('                if model is not None:');
  lines.push('                    return model.from_dict(data)');
  lines.push('                return data');
  lines.push('');
  lines.push('            except httpx.TimeoutException as e:');
  lines.push('                last_error = e');
  lines.push('                if attempt < self._max_retries:');
  lines.push('                    delay = min(');
  lines.push('                        INITIAL_RETRY_DELAY * (RETRY_MULTIPLIER ** attempt),');
  lines.push('                        MAX_RETRY_DELAY,');
  lines.push('                    )');
  lines.push('                    delay = delay * (0.5 + random.random())');
  lines.push('                    await asyncio.sleep(delay)');
  lines.push('                    continue');
  lines.push('                raise WorkOSTimeoutError(f"Request timed out: {e}") from e');
  lines.push('            except httpx.ConnectError as e:');
  lines.push('                last_error = e');
  lines.push('                if attempt < self._max_retries:');
  lines.push('                    delay = min(');
  lines.push('                        INITIAL_RETRY_DELAY * (RETRY_MULTIPLIER ** attempt),');
  lines.push('                        MAX_RETRY_DELAY,');
  lines.push('                    )');
  lines.push('                    delay = delay * (0.5 + random.random())');
  lines.push('                    await asyncio.sleep(delay)');
  lines.push('                    continue');
  lines.push('                raise WorkOSConnectionError(f"Connection failed: {e}") from e');
  lines.push('            except httpx.HTTPError as e:');
  lines.push('                last_error = e');
  lines.push('                if attempt < self._max_retries:');
  lines.push('                    delay = min(');
  lines.push('                        INITIAL_RETRY_DELAY * (RETRY_MULTIPLIER ** attempt),');
  lines.push('                        MAX_RETRY_DELAY,');
  lines.push('                    )');
  lines.push('                    delay = delay * (0.5 + random.random())');
  lines.push('                    await asyncio.sleep(delay)');
  lines.push('                    continue');
  lines.push('                raise WorkOSError(f"Network error: {e}") from e');
  lines.push('');
  lines.push('        raise WorkOSError("Max retries exceeded") from last_error');

  // async request_page
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
  lines.push('        items: list[D] = [');
  lines.push('            cast(D, model.from_dict(cast(Dict[str, Any], item)))');
  lines.push('            for item in raw_items');
  lines.push('        ]');
  lines.push('        list_metadata: Dict[str, Any] = cast(Dict[str, Any], data.get("list_metadata", {}))');
  lines.push('');
  lines.push('        async def _fetch(*, after: Optional[str] = None) -> AsyncPage[D]:');
  lines.push('            clean_params = {k: v for k, v in (params or {}).items() if k != "before"}');
  lines.push('            return await self.request_page(');
  lines.push('                method=method,');
  lines.push('                path=path,');
  lines.push('                model=model,');
  lines.push('                params={**clean_params, "after": after},');
  lines.push('                body=body,');
  lines.push('                request_options=request_options,');
  lines.push('            )');
  lines.push('');
  lines.push('        return AsyncPage(');
  lines.push('            data=items,');
  lines.push('            list_metadata=list_metadata,');
  lines.push('            _fetch_page=_fetch,');
  lines.push('        )');

  // Reuse the sync _raise_error via delegation
  lines.push('');
  lines.push('    @staticmethod');
  lines.push('    def _raise_error(response: httpx.Response) -> None:');
  lines.push('        """Raise an appropriate error based on the response status code."""');
  lines.push('        WorkOS._raise_error(response)');

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
 * Emit the static _raise_error method (shared by WorkOS and AsyncWorkOS).
 */
function emitRaiseError(lines: string[]): void {
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
}

function generateServiceInits(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  for (const service of spec.services) {
    const resolvedName = resolveResourceClassName(service, ctx);
    const dirName = resolveServiceDir(resolvedName);
    const lines: string[] = [];

    // P3-6: explicit resource re-export + star models
    lines.push(`from ._resource import ${resolvedName}, Async${resolvedName}  # noqa: F401`);
    lines.push('from .models import *  # noqa: F401,F403  # pyright: ignore[reportUnusedImport]');

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

  lines.push(`"""${ctx.namespacePascal} Python SDK."""`);
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
  lines.push('from ._pagination import AsyncPage, SyncPage');
  lines.push('from ._types import RequestOptions');
  lines.push('');
  lines.push('__all__ = [');
  lines.push('    "AsyncWorkOS",');
  lines.push('    "WorkOS",');
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
  lines.push(']');

  return [
    {
      path: `src/${ctx.namespace}/__init__.py`,
      content: lines.join('\n'),
      integrateTarget: true,
      skipIfExists: true,
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
