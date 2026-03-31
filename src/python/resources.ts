import type { Service, Operation, OperationPlan, EmitterContext, GeneratedFile, TypeRef } from '@workos/oagen';
import { planOperation, toPascalCase, collectModelRefs, collectEnumRefs, assignModelsToServices } from '@workos/oagen';
import { mapTypeRefUnquoted } from './type-map.js';
import {
  className,
  fieldName,
  resolveServiceDir,
  resolveMethodName,
  resolveClassName,
  buildServiceDirMap,
  dirToModule,
  relativeImportPrefix,
} from './naming.js';
import { groupServicesByNamespace } from './client.js';

/**
 * Compute the Python parameter name for a body field, prefixing with `body_` if it
 * collides with a path parameter name.
 */
export function bodyParamName(field: { name: string }, pathParamNames: Set<string>): string {
  const name = fieldName(field.name);
  return pathParamNames.has(name) ? `body_${name}` : name;
}

/**
 * Resolve the resource class name for a service.
 */
export function resolveResourceClassName(service: Service, ctx: EmitterContext): string {
  return resolveClassName(service, ctx);
}

// ─── Shared method-emission helpers ──────────────────────────────────

/** Metadata returned by emitMethodSignature, consumed by docstring & body emitters. */
interface SignatureMetadata {
  returnType: string;
  pathParamNames: Set<string>;
  isArrayResponse: boolean;
  isRedirect: boolean;
  hasBearerOverride: boolean;
}

/**
 * Emit a Python method signature (def / async def, parameters, return type).
 */
function emitMethodSignature(
  lines: string[],
  op: Operation,
  plan: OperationPlan,
  method: string,
  isAsync: boolean,
  specEnumNames: Set<string>,
  modelImports: Set<string>,
  listWrapperNames: Set<string>,
  ctx: EmitterContext,
): SignatureMetadata {
  const isPaginated = plan.isPaginated;
  const isDelete = plan.isDelete;
  const defKeyword = isAsync ? 'async def' : 'def';

  lines.push(`    ${defKeyword} ${method}(`);
  lines.push('        self,');

  // Path params as positional args
  for (const param of op.pathParams) {
    const paramName = fieldName(param.name);
    const paramType = mapTypeRefUnquoted(param.type, specEnumNames);
    lines.push(`        ${paramName}: ${paramType},`);
  }

  lines.push('        *,');

  const pathParamNames = new Set(op.pathParams.map((p) => fieldName(p.name)));

  // Request body fields as keyword args (rename fields that clash with path params)
  if (plan.hasBody && op.requestBody) {
    const bodyModel = ctx.spec.models.find((m) => op.requestBody?.kind === 'model' && m.name === op.requestBody.name);
    if (bodyModel) {
      const reqFields = bodyModel.fields.filter((f) => f.required);
      const optFields = bodyModel.fields.filter((f) => !f.required);
      for (const f of reqFields) {
        lines.push(`        ${bodyParamName(f, pathParamNames)}: ${mapTypeRefUnquoted(f.type, specEnumNames)},`);
      }
      for (const f of optFields) {
        const innerType =
          f.type.kind === 'nullable'
            ? mapTypeRefUnquoted(f.type.inner, specEnumNames)
            : mapTypeRefUnquoted(f.type, specEnumNames);
        lines.push(`        ${bodyParamName(f, pathParamNames)}: Optional[${innerType}] = None,`);
      }
    } else if (op.requestBody.kind === 'union') {
      // Union body — accept any of the variant models or a plain dict
      const variantModels = (op.requestBody.variants ?? [])
        .filter((v: any) => v.kind === 'model')
        .map((v: any) => className(v.name));
      // Add variant models to imports
      for (const vm of variantModels) {
        modelImports.add(vm);
      }
      if (variantModels.length > 0) {
        const unionType = `Union[${[...variantModels, 'Dict[str, Any]'].join(', ')}]`;
        lines.push(`        body: ${unionType},`);
      } else {
        lines.push('        body: Dict[str, Any],');
      }
    } else {
      // Non-model body — use generic dict
      lines.push('        body: Optional[Dict[str, Any]] = None,');
    }
  }

  // Query params for non-paginated methods
  if (plan.hasQueryParams && !isPaginated) {
    for (const param of op.queryParams) {
      const paramName = fieldName(param.name);
      if (pathParamNames.has(paramName)) continue;
      // Skip query params that collide with body field names (using possibly-renamed names)
      if (plan.hasBody && op.requestBody?.kind === 'model') {
        const bodyModel = ctx.spec.models.find(
          (m) => op.requestBody?.kind === 'model' && m.name === op.requestBody.name,
        );
        if (bodyModel?.fields.some((f) => bodyParamName(f, pathParamNames) === paramName)) continue;
      }
      const paramType = mapTypeRefUnquoted(param.type, specEnumNames);
      if (param.required) {
        lines.push(`        ${paramName}: ${paramType},`);
      } else {
        lines.push(`        ${paramName}: Optional[${paramType}] = None,`);
      }
    }
  }

  // Pagination params
  if (isPaginated) {
    lines.push('        limit: Optional[int] = None,');
    lines.push('        before: Optional[str] = None,');
    lines.push('        after: Optional[str] = None,');
    // Use typed enum for order param if the spec provides one, otherwise fall back to str
    const orderParam = op.queryParams.find((p) => p.name === 'order');
    const orderType =
      orderParam && orderParam.type.kind === 'enum' ? mapTypeRefUnquoted(orderParam.type, specEnumNames) : 'str';
    lines.push(`        order: Optional[${orderType}] = None,`);
    // Additional non-pagination query params
    for (const param of op.queryParams) {
      if (['limit', 'before', 'after', 'order'].includes(param.name)) continue;
      const paramName = fieldName(param.name);
      const paramType = mapTypeRefUnquoted(param.type, specEnumNames);
      if (param.required) {
        lines.push(`        ${paramName}: ${paramType},`);
      } else {
        lines.push(`        ${paramName}: Optional[${paramType}] = None,`);
      }
    }
  }

  // Idempotency key for idempotent POSTs
  if (plan.isIdempotentPost) {
    lines.push('        idempotency_key: Optional[str] = None,');
  }

  // Per-operation Bearer token auth (e.g., SSO.get_profile uses access_token instead of API key)
  const hasBearerOverride = op.security?.some((s) => s.schemeName !== 'bearerAuth') ?? false;
  if (hasBearerOverride) {
    const tokenParamName = op.security!.find((s) => s.schemeName !== 'bearerAuth')!.schemeName;
    lines.push(`        ${fieldName(tokenParamName)}: str,`);
  }

  lines.push('        request_options: Optional[RequestOptions] = None,');

  // Detect array response type
  const isArrayResponse = op.response.kind === 'array' && op.response.items.kind === 'model';
  const isRedirect = isRedirectEndpoint(op);

  // Return type
  const pageType = isAsync ? 'AsyncPage' : 'SyncPage';
  let returnType: string;
  if (isDelete) {
    returnType = 'None';
  } else if (isRedirect) {
    returnType = 'str';
  } else if (isPaginated) {
    const resolvedItem = resolvePageItemName(op.pagination!.itemType, listWrapperNames, ctx);
    returnType = `${pageType}[${className(resolvedItem)}]`;
  } else if (isArrayResponse) {
    returnType = `List[${className(plan.responseModelName!)}]`;
  } else if (plan.responseModelName) {
    returnType = className(plan.responseModelName);
  } else {
    returnType = 'None';
  }

  lines.push(`    ) -> ${returnType}:`);

  return { returnType, pathParamNames, isArrayResponse, isRedirect, hasBearerOverride };
}

/**
 * Emit a Python method docstring (description, Args, Returns, Raises).
 * Identical for sync and async — no isAsync parameter needed.
 */
function emitMethodDocstring(
  lines: string[],
  op: Operation,
  plan: OperationPlan,
  method: string,
  meta: SignatureMetadata,
  specEnumNames: Set<string>,
  ctx: EmitterContext,
): void {
  const { returnType, pathParamNames, hasBearerOverride } = meta;
  const isPaginated = plan.isPaginated;

  // Description
  if (op.description) {
    lines.push(`        """${op.description}`);
  } else {
    lines.push(`        """${toPascalCase(method.replace(/_/g, ' '))} operation.`);
  }

  // Args section
  const allParams: { name: string; desc?: string }[] = op.pathParams.map((p) => ({
    name: fieldName(p.name),
    desc: p.description,
  }));

  // Add body model fields to docs
  if (plan.hasBody && op.requestBody) {
    if (op.requestBody.kind === 'model') {
      const requestBodyName = op.requestBody.name;
      const bodyModel = ctx.spec.models.find((m) => m.name === requestBodyName);
      if (bodyModel) {
        for (const f of bodyModel.fields) {
          allParams.push({ name: bodyParamName(f, pathParamNames), desc: f.description });
        }
      }
    } else if (op.requestBody.kind === 'union') {
      // Union body — document the body parameter with the accepted variant types
      const variantModels = (op.requestBody.variants ?? [])
        .filter((v: any) => v.kind === 'model')
        .map((v: any) => className(v.name));
      const desc =
        variantModels.length > 0
          ? `The request body. Accepts: ${variantModels.join(', ')}, or a plain dict.`
          : 'The request body.';
      allParams.push({ name: 'body', desc });
    }
  }

  // Add query params for non-paginated methods
  if (plan.hasQueryParams && !isPaginated) {
    for (const param of op.queryParams) {
      const pn = fieldName(param.name);
      if (pathParamNames.has(pn)) continue;
      // Skip params already documented from body fields
      if (allParams.some((p) => p.name === pn)) continue;
      allParams.push({ name: pn, desc: param.description });
    }
  }

  // Add extra non-standard pagination query params
  if (isPaginated) {
    for (const param of op.queryParams) {
      if (['limit', 'before', 'after', 'order'].includes(param.name)) continue;
      allParams.push({ name: fieldName(param.name), desc: param.description });
    }
  }

  // Add idempotency key parameter to docs
  if (plan.isIdempotentPost) {
    allParams.push({ name: 'idempotency_key', desc: 'Optional idempotency key for safe retries.' });
  }

  // Add bearer override parameter to docs (e.g., access_token for SSO)
  if (hasBearerOverride) {
    const tokenParamName = fieldName(op.security!.find((s) => s.schemeName !== 'bearerAuth')!.schemeName);
    allParams.push({ name: tokenParamName, desc: 'The bearer token for authentication.' });
  }

  if (allParams.length > 0 || isPaginated) {
    lines.push('');
    lines.push('        Args:');
    for (const p of allParams) {
      lines.push(`            ${p.name}: ${p.desc ?? 'The ' + p.name.replace(/_/g, ' ') + '.'}`);
    }
    if (isPaginated) {
      lines.push('            limit: Maximum number of records to return.');
      lines.push('            before: Pagination cursor for previous page.');
      lines.push('            after: Pagination cursor for next page.');
      lines.push('            order: Sort order.');
    }
    lines.push('            request_options: Per-request options (extra headers, timeout).');
  }

  if (returnType !== 'None') {
    lines.push('');
    lines.push('        Returns:');
    lines.push(`            ${returnType}`);
  }

  // Per-operation error documentation from spec error responses
  const errorRaises = buildErrorRaisesBlock(op);
  lines.push('');
  lines.push('        Raises:');
  for (const line of errorRaises) {
    lines.push(`            ${line}`);
  }
  lines.push('        """');
}

/**
 * Emit the Python method body (auth override, path building, request call).
 */
function emitMethodBody(
  lines: string[],
  op: Operation,
  plan: OperationPlan,
  meta: SignatureMetadata,
  isAsync: boolean,
  modelImports: Set<string>,
  listWrapperNames: Set<string>,
  ctx: EmitterContext,
): void {
  const { pathParamNames, isArrayResponse, isRedirect, hasBearerOverride } = meta;
  const isPaginated = plan.isPaginated;
  const awaitPrefix = isAsync ? 'await ' : '';

  // Method body — build path
  const pathStr = buildPathString(op);
  const httpMethod = op.httpMethod;

  // Emit auth override for per-operation Bearer token security
  if (hasBearerOverride) {
    const tokenParamName = fieldName(op.security!.find((s) => s.schemeName !== 'bearerAuth')!.schemeName);
    lines.push(`        request_options = request_options or {}`);
    lines.push(
      `        request_options = {**request_options, "extra_headers": {**(request_options.get("extra_headers") or {}), "Authorization": f"Bearer {${tokenParamName}}"}}`,
    );
  }

  if (isRedirect) {
    // Redirect endpoint: construct URL client-side instead of making HTTP request
    const bodyModel =
      plan.hasBody && op.requestBody?.kind === 'model'
        ? ctx.spec.models.find((m) => op.requestBody?.kind === 'model' && m.name === op.requestBody.name)
        : undefined;
    const redirectParamEntries: { key: string; varName: string }[] = [];
    if (bodyModel) {
      for (const f of bodyModel.fields) {
        redirectParamEntries.push({ key: f.name, varName: bodyParamName(f, pathParamNames) });
      }
    }
    for (const param of op.queryParams) {
      const pn = fieldName(param.name);
      if (!redirectParamEntries.some((e) => e.varName === pn)) {
        redirectParamEntries.push({ key: param.name, varName: pn });
      }
    }
    if (redirectParamEntries.length > 0) {
      lines.push('        params = {k: v for k, v in {');
      for (const entry of redirectParamEntries) {
        lines.push(`            "${entry.key}": ${entry.varName},`);
      }
      lines.push('        }.items() if v is not None}');
      lines.push(`        return self._client.build_url(${pathStr}, params)`);
    } else {
      lines.push(`        return self._client.build_url(${pathStr})`);
    }
  } else if (isPaginated) {
    const resolvedItemName = resolvePageItemName(op.pagination!.itemType, listWrapperNames, ctx);
    const itemTypeClass = className(resolvedItemName);
    // Build query params dict
    lines.push('        params = {k: v for k, v in {');
    lines.push('            "limit": limit,');
    lines.push('            "before": before,');
    lines.push('            "after": after,');
    lines.push('            "order": order,');
    for (const param of op.queryParams) {
      if (['limit', 'before', 'after', 'order'].includes(param.name)) continue;
      lines.push(`            "${param.name}": ${fieldName(param.name)},`);
    }
    lines.push('        }.items() if v is not None}');
    lines.push(`        return ${awaitPrefix}self._client.request_page(`);
    lines.push(`            method="${httpMethod}",`);
    lines.push(`            path=${pathStr},`);
    lines.push(`            model=${itemTypeClass},`);
    lines.push('            params=params,');
    lines.push('            request_options=request_options,');
    lines.push('        )');
  } else if (plan.isDelete) {
    // Build body dict if the DELETE has a request body
    const deleteBodyFieldNames = new Set<string>();
    if (plan.hasBody && op.requestBody) {
      const bodyModel = ctx.spec.models.find((m) => op.requestBody?.kind === 'model' && m.name === op.requestBody.name);
      if (bodyModel) {
        const bodyFields = bodyModel.fields;
        for (const f of bodyFields) deleteBodyFieldNames.add(bodyParamName(f, pathParamNames));
        const hasOptionalBodyFields = bodyFields.some((f) => !f.required);
        if (bodyFields.length > 0 && hasOptionalBodyFields) {
          lines.push('        body: Dict[str, Any] = {k: v for k, v in {');
          for (const f of bodyFields) {
            lines.push(
              `            "${f.name}": ${serializeBodyFieldValue(f.type, bodyParamName(f, pathParamNames), f.required)},`,
            );
          }
          lines.push('        }.items() if v is not None}');
        } else if (bodyFields.length > 0) {
          lines.push('        body: Dict[str, Any] = {');
          for (const f of bodyFields) {
            lines.push(
              `            "${f.name}": ${serializeBodyFieldValue(f.type, bodyParamName(f, pathParamNames), f.required)},`,
            );
          }
          lines.push('        }');
        }
      }
    }
    // Build query params dict if any exist alongside the body/path
    const deleteHasParams = plan.hasQueryParams && emitQueryParamsDict(lines, op, pathParamNames, deleteBodyFieldNames);
    lines.push(`        ${awaitPrefix}self._client.request(`);
    lines.push(`            method="${httpMethod}",`);
    lines.push(`            path=${pathStr},`);
    if (plan.hasBody && op.requestBody) {
      lines.push('            body=body,');
    }
    if (deleteHasParams) {
      lines.push('            params=params,');
    }
    lines.push('            request_options=request_options,');
    lines.push('        )');
  } else if (plan.hasBody && op.requestBody) {
    const responseModel = plan.responseModelName ? className(plan.responseModelName) : 'None';
    // Build body dict
    const bodyModel = ctx.spec.models.find((m) => op.requestBody?.kind === 'model' && m.name === op.requestBody.name);
    const bodyFieldNamesSet = new Set<string>();
    if (bodyModel) {
      const bodyFields = bodyModel.fields;
      for (const f of bodyFields) bodyFieldNamesSet.add(bodyParamName(f, pathParamNames));
      const hasOptionalBodyFields = bodyFields.some((f) => !f.required);
      if (bodyFields.length > 0 && hasOptionalBodyFields) {
        lines.push('        body: Dict[str, Any] = {k: v for k, v in {');
        for (const f of bodyFields) {
          lines.push(
            `            "${f.name}": ${serializeBodyFieldValue(f.type, bodyParamName(f, pathParamNames), f.required)},`,
          );
        }
        lines.push('        }.items() if v is not None}');
      } else if (bodyFields.length > 0) {
        lines.push('        body: Dict[str, Any] = {');
        for (const f of bodyFields) {
          lines.push(
            `            "${f.name}": ${serializeBodyFieldValue(f.type, bodyParamName(f, pathParamNames), f.required)},`,
          );
        }
        lines.push('        }');
      } else {
        lines.push('        body: Dict[str, Any] = {}');
      }
    } else {
      // Union or non-model body — convert model instances to dicts
      lines.push('        _body: Dict[str, Any] = body if isinstance(body, dict) else body.to_dict()');
    }
    // Build query params dict if any exist alongside the body
    const bodyHasParams = plan.hasQueryParams && emitQueryParamsDict(lines, op, pathParamNames, bodyFieldNamesSet);
    const bodyVarName = bodyModel ? 'body' : '_body';
    if (isArrayResponse) {
      // Array response with body: request without model, then deserialize each item
      const itemModel = className(plan.responseModelName!);
      lines.push(`        raw = ${awaitPrefix}self._client.request(`);
      lines.push(`            method="${httpMethod}",`);
      lines.push(`            path=${pathStr},`);
      lines.push(`            body=${bodyVarName},`);
      if (bodyHasParams) {
        lines.push('            params=params,');
      }
      if (plan.isIdempotentPost) {
        lines.push('            idempotency_key=idempotency_key,');
      }
      lines.push('            request_options=request_options,');
      lines.push('        )');
      lines.push(
        `        return [${itemModel}.from_dict(cast(Dict[str, Any], item)) for item in (raw if isinstance(raw, list) else [])]`,
      );
    } else {
      const bodyReturnPrefix = responseModel !== 'None' ? 'return ' : '';
      lines.push(`        ${bodyReturnPrefix}${awaitPrefix}self._client.request(`);
      lines.push(`            method="${httpMethod}",`);
      lines.push(`            path=${pathStr},`);
      lines.push(`            body=${bodyVarName},`);
      if (bodyHasParams) {
        lines.push('            params=params,');
      }
      if (responseModel !== 'None') {
        lines.push(`            model=${responseModel},`);
      }
      if (plan.isIdempotentPost) {
        lines.push('            idempotency_key=idempotency_key,');
      }
      lines.push('            request_options=request_options,');
      lines.push('        )');
    }
  } else {
    // GET or similar with query params
    const responseModel = plan.responseModelName ? className(plan.responseModelName) : 'None';
    if (plan.hasQueryParams) {
      const hasOptionalQueryParams = op.queryParams.some((p) => !p.required);
      if (hasOptionalQueryParams) {
        lines.push('        params: Dict[str, Any] = {k: v for k, v in {');
        for (const param of op.queryParams) {
          lines.push(`            "${param.name}": ${fieldName(param.name)},`);
        }
        lines.push('        }.items() if v is not None}');
      } else {
        lines.push('        params: Dict[str, Any] = {');
        for (const param of op.queryParams) {
          lines.push(`            "${param.name}": ${fieldName(param.name)},`);
        }
        lines.push('        }');
      }
    }
    if (isArrayResponse) {
      // Array response: request without model, then deserialize each item
      const itemModel = className(plan.responseModelName!);
      lines.push(`        raw = ${awaitPrefix}self._client.request(`);
      lines.push(`            method="${httpMethod}",`);
      lines.push(`            path=${pathStr},`);
      if (plan.hasQueryParams) {
        lines.push('            params=params,');
      }
      lines.push('            request_options=request_options,');
      lines.push('        )');
      lines.push(
        `        return [${itemModel}.from_dict(cast(Dict[str, Any], item)) for item in (raw if isinstance(raw, list) else [])]`,
      );
    } else {
      const returnPrefix = responseModel !== 'None' ? 'return ' : '';
      lines.push(`        ${returnPrefix}${awaitPrefix}self._client.request(`);
      lines.push(`            method="${httpMethod}",`);
      lines.push(`            path=${pathStr},`);
      if (plan.hasQueryParams) {
        lines.push('            params=params,');
      }
      if (responseModel !== 'None') {
        lines.push(`            model=${responseModel},`);
      }
      lines.push('            request_options=request_options,');
      lines.push('        )');
    }
  }
}

// ─── Main generator ──────────────────────────────────────────────────

/**
 * Generate Python resource class files from IR Service definitions.
 */
export function generateResources(services: Service[], ctx: EmitterContext): GeneratedFile[] {
  if (services.length === 0) return [];

  const files: GeneratedFile[] = [];
  const grouping = groupServicesByNamespace(services, ctx);
  const serviceDirMap = buildServiceDirMap(grouping);

  for (const service of services) {
    const resolvedName = resolveResourceClassName(service, ctx);
    const dirName = serviceDirMap.get(service.name) ?? resolveServiceDir(resolvedName);
    const resourceClassName = resolvedName;
    const importPrefix = relativeImportPrefix(dirName);

    const lines: string[] = [];
    lines.push('from __future__ import annotations');
    lines.push('');
    lines.push('from typing import TYPE_CHECKING, Any, Dict, List, Literal, Optional, Type, Union, cast');
    lines.push('');
    lines.push('if TYPE_CHECKING:');
    lines.push(`    from ${importPrefix}_client import AsyncWorkOS, WorkOS`);
    lines.push('');

    // Collect all model and enum imports needed
    const modelImports = new Set<string>();
    const enumImports = new Set<string>();

    // Build a set of list wrapper model names to skip
    const listWrapperNames = new Set<string>();
    for (const m of ctx.spec.models) {
      const dataField = m.fields.find((f) => f.name === 'data');
      const hasListMeta = m.fields.some((f) => f.name === 'list_metadata' || f.name === 'listMetadata');
      if (dataField && hasListMeta && dataField.type.kind === 'array') {
        listWrapperNames.add(m.name);
      }
    }

    for (const op of service.operations) {
      const plan = planOperation(op);
      if (plan.responseModelName && !listWrapperNames.has(plan.responseModelName)) {
        modelImports.add(plan.responseModelName);
      }
      if (op.requestBody?.kind === 'model') {
        const requestBodyRef = op.requestBody;
        modelImports.add(requestBodyRef.name);
        // Also collect types from body model fields (expanded as keyword params)
        const bodyModel = ctx.spec.models.find((m) => m.name === requestBodyRef.name);
        if (bodyModel) {
          for (const f of bodyModel.fields) {
            for (const ref of collectModelRefs(f.type)) modelImports.add(ref);
            for (const ref of collectEnumRefs(f.type)) enumImports.add(ref);
          }
        }
      }
      // Collect from params
      for (const p of [...op.pathParams, ...op.queryParams]) {
        for (const ref of collectEnumRefs(p.type)) {
          enumImports.add(ref);
        }
      }
      if (op.requestBody) {
        for (const ref of collectModelRefs(op.requestBody)) {
          modelImports.add(ref);
        }
        for (const ref of collectEnumRefs(op.requestBody)) {
          enumImports.add(ref);
        }
      }
      if (op.pagination?.itemType.kind === 'model') {
        let paginationItemName = op.pagination.itemType.name;
        // Unwrap list wrapper models to their inner item type for imports
        if (listWrapperNames.has(paginationItemName)) {
          const wrapperModel = ctx.spec.models.find((m) => m.name === paginationItemName);
          const dataField = wrapperModel?.fields.find((f) => f.name === 'data');
          if (dataField && dataField.type.kind === 'array' && dataField.type.items.kind === 'model') {
            paginationItemName = dataField.type.items.name;
          }
        }
        modelImports.add(paginationItemName);
      }
    }

    // Filter enum imports to only those that actually exist in the spec
    const specEnumNames = new Set(ctx.spec.enums.map((e) => e.name));
    for (const name of enumImports) {
      if (!specEnumNames.has(name)) enumImports.delete(name);
    }

    const actualModelImports = [...modelImports];

    // Split imports into same-service and cross-service
    const modelToServiceMap = assignModelsToServices(ctx.spec.models, ctx.spec.services);
    const resolveModelDir = (modelName: string) => {
      const svc = modelToServiceMap.get(modelName);
      return svc ? (serviceDirMap.get(svc) ?? 'common') : 'common';
    };

    const localModels: string[] = [];
    const crossServiceModels = new Map<string, string[]>(); // dir -> names

    for (const name of actualModelImports.sort()) {
      const modelDir = resolveModelDir(name);
      if (modelDir === dirName) {
        localModels.push(name);
      } else {
        if (!crossServiceModels.has(modelDir)) crossServiceModels.set(modelDir, []);
        crossServiceModels.get(modelDir)!.push(name);
      }
    }

    if (localModels.length > 0) {
      lines.push(`from .models import ${localModels.map((n) => className(n)).join(', ')}`);
    }
    for (const [csDir, names] of [...crossServiceModels].sort()) {
      lines.push(
        `from ${ctx.namespace}.${dirToModule(csDir)}.models import ${names.map((n) => className(n)).join(', ')}`,
      );
    }

    // Enum imports — same-service vs cross-service
    const enumToServiceMap = new Map<string, string>();
    for (const e of ctx.spec.enums) {
      // Find which service uses this enum by walking full type trees
      for (const svc of ctx.spec.services) {
        for (const op of svc.operations) {
          const refs = new Set<string>();
          // Walk all type refs (including nested nullable/array/union) to find enums
          const allTypeRefs = [
            op.response,
            ...(op.requestBody ? [op.requestBody] : []),
            ...op.pathParams.map((p) => p.type),
            ...op.queryParams.map((p) => p.type),
            ...op.headerParams.map((p) => p.type),
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

    const localEnums: string[] = [];
    const crossServiceEnums = new Map<string, string[]>();
    for (const name of [...enumImports].sort()) {
      const enumSvc = enumToServiceMap.get(name);
      const enumDir = enumSvc ? (serviceDirMap.get(enumSvc) ?? 'common') : 'common';
      if (enumDir === dirName) {
        localEnums.push(name);
      } else {
        if (!crossServiceEnums.has(enumDir)) crossServiceEnums.set(enumDir, []);
        crossServiceEnums.get(enumDir)!.push(name);
      }
    }

    if (localEnums.length > 0) {
      lines.push(`from .models import ${localEnums.map((n) => className(n)).join(', ')}`);
    }
    for (const [csDir, names] of [...crossServiceEnums].sort()) {
      lines.push(
        `from ${ctx.namespace}.${dirToModule(csDir)}.models import ${names.map((n) => className(n)).join(', ')}`,
      );
    }

    const hasPaginated = service.operations.some((op) => op.pagination);
    if (hasPaginated) {
      lines.push(`from ${importPrefix}_pagination import AsyncPage, SyncPage`);
    }
    lines.push(`from ${importPrefix}_types import RequestOptions`);

    // --- Generate sync class ---
    lines.push('');
    lines.push('');
    lines.push(`class ${resourceClassName}:`);
    if (service.description) {
      lines.push(`    """${service.description}"""`);
    } else {
      let readable = resourceClassName.replace(/([a-z])([A-Z])/g, '$1 $2');
      readable = readable.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
      lines.push(`    """${readable} API resources."""`);
    }
    lines.push('');
    lines.push('    def __init__(self, client: "WorkOS") -> None:');
    lines.push('        self._client = client');

    const emittedMethods = new Set<string>();
    for (const op of service.operations) {
      const plan = planOperation(op);
      const method = resolveMethodName(op, service, ctx);
      if (emittedMethods.has(method)) continue;
      emittedMethods.add(method);

      lines.push('');
      const meta = emitMethodSignature(
        lines,
        op,
        plan,
        method,
        false,
        specEnumNames,
        modelImports,
        listWrapperNames,
        ctx,
      );
      emitMethodDocstring(lines, op, plan, method, meta, specEnumNames, ctx);
      emitMethodBody(lines, op, plan, meta, false, modelImports, listWrapperNames, ctx);
    }

    // --- Generate async class ---
    const asyncClassName = `Async${resourceClassName}`;
    lines.push('');
    lines.push('');
    lines.push(`class ${asyncClassName}:`);
    if (service.description) {
      lines.push(`    """${service.description}"""`);
    } else {
      let readable = resourceClassName.replace(/([a-z])([A-Z])/g, '$1 $2');
      readable = readable.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
      lines.push(`    """${readable} API resources (async)."""`);
    }
    lines.push('');
    lines.push('    def __init__(self, client: "AsyncWorkOS") -> None:');
    lines.push('        self._client = client');

    const asyncEmittedMethods = new Set<string>();
    for (const op of service.operations) {
      const plan = planOperation(op);
      const method = resolveMethodName(op, service, ctx);
      if (asyncEmittedMethods.has(method)) continue;
      asyncEmittedMethods.add(method);

      lines.push('');
      const meta = emitMethodSignature(
        lines,
        op,
        plan,
        method,
        true,
        specEnumNames,
        modelImports,
        listWrapperNames,
        ctx,
      );
      emitMethodDocstring(lines, op, plan, method, meta, specEnumNames, ctx);
      emitMethodBody(lines, op, plan, meta, true, modelImports, listWrapperNames, ctx);
    }

    files.push({
      path: `src/${ctx.namespace}/${dirName}/_resource.py`,
      content: lines.join('\n'),
      integrateTarget: true,
      overwriteExisting: true,
    });
  }

  return files;
}

// ─── Existing shared helpers ─────────────────────────────────────────

/**
 * Emit a `params` dict from query params (for methods that also have a body or DELETE).
 * Returns true if params were emitted, false if no query params exist.
 */
function emitQueryParamsDict(
  lines: string[],
  op: Operation,
  pathParamNames: Set<string>,
  bodyFieldNames: Set<string>,
): boolean {
  // Filter to query params that aren't already path params or body fields
  const queryParams = op.queryParams.filter((p) => {
    const pn = fieldName(p.name);
    return !pathParamNames.has(pn) && !bodyFieldNames.has(pn);
  });
  if (queryParams.length === 0) return false;

  const hasOptional = queryParams.some((p) => !p.required);
  if (hasOptional) {
    lines.push('        params: Dict[str, Any] = {k: v for k, v in {');
    for (const param of queryParams) {
      lines.push(`            "${param.name}": ${fieldName(param.name)},`);
    }
    lines.push('        }.items() if v is not None}');
  } else {
    lines.push('        params: Dict[str, Any] = {');
    for (const param of queryParams) {
      lines.push(`            "${param.name}": ${fieldName(param.name)},`);
    }
    lines.push('        }');
  }
  return true;
}

/**
 * Serialize a body field value for inclusion in a request body dict.
 * Calls .to_dict() directly on model fields since types are known at generation time.
 * For arrays of models, maps each item through .to_dict().
 */
function serializeBodyFieldValue(fieldType: any, varName: string, isRequired: boolean): string {
  const effectiveType = fieldType.kind === 'nullable' ? fieldType.inner : fieldType;
  if (effectiveType.kind === 'model') {
    if (!isRequired) {
      return `${varName}.to_dict() if ${varName} is not None else None`;
    }
    return `${varName}.to_dict()`;
  }
  if (effectiveType.kind === 'array' && effectiveType.items?.kind === 'model') {
    if (!isRequired) {
      return `[item.to_dict() for item in ${varName}] if ${varName} is not None else None`;
    }
    return `[item.to_dict() for item in ${varName}]`;
  }
  return varName;
}

/**
 * Resolve the item type name for a paginated operation, unwrapping list wrappers.
 */
export function resolvePageItemName(itemType: TypeRef, listWrapperNames: Set<string>, ctx: EmitterContext): string {
  if (itemType.kind === 'model') {
    if (listWrapperNames.has(itemType.name)) {
      const wrapperModel = ctx.spec.models.find((m) => m.name === itemType.name);
      const dataField = wrapperModel?.fields.find((f) => f.name === 'data');
      if (dataField && dataField.type.kind === 'array' && dataField.type.items.kind === 'model') {
        return dataField.type.items.name;
      }
    }
    return itemType.name;
  }
  return 'dict';
}

/**
 * Check if an operation is a redirect endpoint that should construct a URL
 * instead of making an HTTP request.
 *
 * Detection: GET endpoints with no response body (primitive unknown) are redirect
 * endpoints — e.g., SSO/OAuth authorize and logout flows that redirect the browser.
 * Also catches endpoints with 302 success responses when the parser includes them.
 */
function isRedirectEndpoint(op: Operation): boolean {
  // Explicit 302 in success responses
  if (op.successResponses?.some((r) => r.statusCode >= 300 && r.statusCode < 400)) {
    return true;
  }
  // GET with no response body (primitive unknown) = browser redirect endpoint
  if (
    op.httpMethod === 'get' &&
    op.response.kind === 'primitive' &&
    op.response.type === 'unknown' &&
    op.queryParams.length > 0
  ) {
    return true;
  }
  return false;
}

/**
 * Map HTTP status codes to Python error class names for per-operation Raises: documentation.
 * Falls back to a baseline set (401, 429, 5xx) when the operation has no explicit errors.
 */
const STATUS_TO_ERROR: Record<number, string> = {
  400: 'BadRequestError',
  401: 'AuthenticationError',
  403: 'ForbiddenError',
  404: 'NotFoundError',
  409: 'ConflictError',
  422: 'UnprocessableEntityError',
  429: 'RateLimitExceededError',
};

const STATUS_TO_DESC: Record<number, string> = {
  400: 'If the request is malformed (400).',
  401: 'If the API key is invalid (401).',
  403: 'If the request is forbidden (403).',
  404: 'If the resource is not found (404).',
  409: 'If a conflict occurs (409).',
  422: 'If the request data is unprocessable (422).',
  429: 'If rate limited (429).',
};

function buildErrorRaisesBlock(op: Operation): string[] {
  const lines: string[] = [];
  const emittedCodes = new Set<number>();

  if (op.errors.length > 0) {
    // Use per-operation error responses from the spec
    for (const err of op.errors) {
      const errorClass = STATUS_TO_ERROR[err.statusCode];
      const desc = STATUS_TO_DESC[err.statusCode];
      if (errorClass && !emittedCodes.has(err.statusCode)) {
        lines.push(`${errorClass}: ${desc}`);
        emittedCodes.add(err.statusCode);
      }
    }
    // Always include 5xx
    if (!emittedCodes.has(500)) {
      lines.push('ServerError: If the server returns a 5xx error.');
    }
  }

  // Fall back to baseline if no specific errors documented
  if (lines.length === 0) {
    lines.push('AuthenticationError: If the API key is invalid (401).');
    lines.push('RateLimitExceededError: If rate limited (429).');
    lines.push('ServerError: If the server returns a 5xx error.');
  }

  return lines;
}

/**
 * Build a Python f-string path expression from an operation path.
 * E.g., "/organizations/{id}" -> f"organizations/{id}"
 */
function buildPathString(op: Operation): string {
  // Strip leading slash and convert {param} to Python f-string interpolation
  const path = op.path.replace(/^\//, '');
  if (op.pathParams.length === 0) {
    return `"${path}"`;
  }
  // Convert {paramName} to {fieldName(paramName)}
  let fPath = path;
  for (const param of op.pathParams) {
    fPath = fPath.replace(`{${param.name}}`, `{${fieldName(param.name)}}`);
  }
  return `f"${fPath}"`;
}
