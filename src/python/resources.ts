import type {
  Service,
  Operation,
  OperationPlan,
  EmitterContext,
  GeneratedFile,
  TypeRef,
  ResolvedOperation,
  Parameter,
  Model,
} from '@workos/oagen';

/** Extend Parameter with `explode` until @workos/oagen publishes the field. */
type ParameterExt = Parameter & { explode?: boolean };
import {
  planOperation,
  toPascalCase,
  toSnakeCase,
  collectModelRefs,
  collectEnumRefs,
  assignModelsToServices,
} from '@workos/oagen';
import { mapTypeRefUnquoted } from './type-map.js';
import {
  className,
  fieldName,
  fileName,
  moduleName,
  resolveClassName,
  buildMountDirMap,
  dirToModule,
  relativeImportPrefix,
} from './naming.js';
import {
  buildResolvedLookup,
  lookupMethodName,
  lookupResolved,
  groupByMount,
  getOpDefaults,
  getOpInferFromClient,
  buildHiddenParams as buildHiddenParamsShared,
  collectGroupedParamNames,
  collectBodyFieldTypes,
} from '../shared/resolved-ops.js';
import {
  generateSyncWrapperMethods,
  generateAsyncWrapperMethods,
  pythonLiteral,
  clientFieldExpression,
} from './wrappers.js';

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

// buildHiddenParams is imported from ../shared/resolved-ops.js as buildHiddenParamsShared
const buildHiddenParams = buildHiddenParamsShared;

// ─── Parameter group support ─────────────────────────────────────────

/**
 * PascalCase variant class name for a parameter group variant.
 * E.g., group "parent_resource", variant "by_id" -> "ParentResourceById".
 */
function groupVariantClassName(groupName: string, variantName: string): string {
  return className(`${groupName}_${variantName}`);
}

/**
 * Generate Python dataclass definitions for all parameter group variants
 * across a set of operations. Returns lines to insert near the top of the
 * resource file (after imports, before class definitions).
 */
function generateParameterGroupDataclasses(
  operations: Operation[],
  specEnumNames: Set<string>,
  models: Model[],
): string[] {
  const lines: string[] = [];
  const emitted = new Set<string>();

  for (const op of operations) {
    const bodyFieldTypes = collectBodyFieldTypes(op, models);
    for (const group of op.parameterGroups ?? []) {
      for (const variant of group.variants) {
        const variantClass = groupVariantClassName(group.name, variant.name);
        if (emitted.has(variantClass)) continue;
        emitted.add(variantClass);

        lines.push('');
        lines.push('@dataclass');
        lines.push(`class ${variantClass}:`);
        const readableGroup = group.name.replace(/_/g, ' ');
        const readableVariant = variant.name.replace(/_/g, ' ');
        lines.push(`    """Identify ${readableGroup} ${readableVariant}."""`);
        for (const param of variant.parameters) {
          const pyField = fieldName(param.name);
          const effectiveType = bodyFieldTypes.get(param.name) ?? param.type;
          const pyType = mapTypeRefUnquoted(effectiveType, specEnumNames, true);
          lines.push(`    ${pyField}: ${pyType}`);
        }
      }
    }
  }

  return lines;
}

/**
 * Check whether any operation has parameter groups.
 */
function hasParameterGroups(operations: Operation[]): boolean {
  return operations.some((op) => (op.parameterGroups?.length ?? 0) > 0);
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

function emitDocArg(lines: string[], name: string, desc?: string): void {
  const fallback = `The ${name.replace(/_/g, ' ')}.`;
  const description = desc ?? fallback;
  const descLines = description
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (descLines.length === 0) {
    lines.push(`            ${name}: ${fallback}`);
    return;
  }

  lines.push(`            ${name}: ${descLines[0]}`);
  for (const line of descLines.slice(1)) {
    lines.push(`                ${line}`);
  }
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
  resolvedOp?: ResolvedOperation,
): SignatureMetadata {
  const hiddenParams = buildHiddenParams(resolvedOp);
  const isPaginated = plan.isPaginated;
  const isDelete = plan.isDelete;
  // Redirect endpoints never await, so emit as plain def even in async class
  const isRedirectOp = isRedirectEndpoint(op);
  const defKeyword = isAsync && !isRedirectOp ? 'async def' : 'def';
  const usesClientCredentialDefaults = false;

  lines.push(`    ${defKeyword} ${method}(`);
  lines.push('        self,');

  // Path params as positional args
  for (const param of op.pathParams) {
    const paramName = fieldName(param.name);
    const paramType = mapTypeRefUnquoted(param.type, specEnumNames, true);
    lines.push(`        ${paramName}: ${paramType},`);
  }

  lines.push('        *,');

  const pathParamNames = new Set(op.pathParams.map((p) => fieldName(p.name)));

  // Request body fields as keyword args (rename fields that clash with path params)
  const groupedBodyParamNames = collectGroupedParamNames(op);
  if (plan.hasBody && op.requestBody) {
    const bodyModel = ctx.spec.models.find((m) => op.requestBody?.kind === 'model' && m.name === op.requestBody.name);
    if (bodyModel) {
      const reqFields = bodyModel.fields.filter(
        (f) => f.required && !hiddenParams.has(f.name) && !groupedBodyParamNames.has(f.name),
      );
      const optFields = bodyModel.fields.filter(
        (f) => !f.required && !hiddenParams.has(f.name) && !groupedBodyParamNames.has(f.name),
      );
      for (const f of reqFields) {
        const fieldType = mapTypeRefUnquoted(f.type, specEnumNames, true);
        if (usesClientCredentialDefaults && (f.name === 'client_id' || f.name === 'client_secret')) {
          lines.push(`        ${bodyParamName(f, pathParamNames)}: Optional[${fieldType}] = None,`);
        } else {
          lines.push(`        ${bodyParamName(f, pathParamNames)}: ${fieldType},`);
        }
      }
      for (const f of optFields) {
        const innerType =
          f.type.kind === 'nullable'
            ? mapTypeRefUnquoted(f.type.inner, specEnumNames, true)
            : mapTypeRefUnquoted(f.type, specEnumNames, true);
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
  const groupedParamNames = collectGroupedParamNames(op);
  if (plan.hasQueryParams && !isPaginated) {
    for (const param of op.queryParams) {
      if (hiddenParams.has(param.name)) continue;
      if (groupedParamNames.has(param.name)) continue;
      const paramName = fieldName(param.name);
      if (pathParamNames.has(paramName)) continue;
      // Skip query params that collide with body field names (using possibly-renamed names)
      if (plan.hasBody && op.requestBody?.kind === 'model') {
        const bodyModel = ctx.spec.models.find(
          (m) => op.requestBody?.kind === 'model' && m.name === op.requestBody.name,
        );
        if (bodyModel?.fields.some((f) => bodyParamName(f, pathParamNames) === paramName)) continue;
      }
      const paramType = mapTypeRefUnquoted(param.type, specEnumNames, true);
      if (usesClientCredentialDefaults && (param.name === 'client_id' || param.name === 'client_secret')) {
        lines.push(`        ${paramName}: Optional[${paramType}] = None,`);
      } else if (param.required) {
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
      orderParam && orderParam.type.kind === 'enum' ? mapTypeRefUnquoted(orderParam.type, specEnumNames, true) : 'str';
    lines.push(`        order: Optional[${orderType}] = "desc",`);
    // Additional non-pagination query params
    for (const param of op.queryParams) {
      if (['limit', 'before', 'after', 'order'].includes(param.name)) continue;
      if (hiddenParams.has(param.name)) continue;
      if (groupedParamNames.has(param.name)) continue;
      const paramName = fieldName(param.name);
      const paramType = mapTypeRefUnquoted(param.type, specEnumNames, true);
      if (param.required) {
        lines.push(`        ${paramName}: ${paramType},`);
      } else {
        lines.push(`        ${paramName}: Optional[${paramType}] = None,`);
      }
    }
  }

  // Parameter group union kwargs
  for (const group of op.parameterGroups ?? []) {
    const variantClasses = group.variants.map((v) => groupVariantClassName(group.name, v.name));
    const unionType = `Union[${variantClasses.join(', ')}]`;
    const paramName = fieldName(group.name);
    if (group.optional) {
      lines.push(`        ${paramName}: Optional[${unionType}] = None,`);
    } else {
      lines.push(`        ${paramName}: ${unionType},`);
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
    const resolvedItemModel = ctx.spec.models.find((m) => m.name === resolvedItem);
    const itemTypeName = (resolvedItemModel as any)?.discriminator
      ? className(resolvedItem) + 'Variant'
      : className(resolvedItem);
    returnType = `${pageType}[${itemTypeName}]`;
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
  resolvedOp?: ResolvedOperation,
): void {
  const { returnType, pathParamNames, hasBearerOverride } = meta;
  const isPaginated = plan.isPaginated;
  const hiddenParams = buildHiddenParams(resolvedOp);

  // Description — indent continuation lines to align with the opening `"""`
  if (op.description) {
    const descLines = op.description.split('\n');
    const indentedDesc = descLines
      .map((line, i) => (i === 0 ? line : line.trim() === '' ? '' : `        ${line}`))
      .join('\n');
    lines.push(`        """${indentedDesc}`);
  } else {
    lines.push(`        """${toPascalCase(method.replace(/_/g, ' '))} operation.`);
  }

  // Args section
  const allParams: { name: string; desc?: string }[] = op.pathParams.map((p) => ({
    name: fieldName(p.name),
    desc: p.deprecated ? (p.description ? `(deprecated) ${p.description}` : '(deprecated)') : p.description,
  }));

  // Add body model fields to docs
  const groupedDocBodyParams = collectGroupedParamNames(op);
  if (plan.hasBody && op.requestBody) {
    if (op.requestBody.kind === 'model') {
      const requestBodyName = op.requestBody.name;
      const bodyModel = ctx.spec.models.find((m) => m.name === requestBodyName);
      if (bodyModel) {
        for (const f of bodyModel.fields) {
          if (hiddenParams.has(f.name)) continue;
          if (groupedDocBodyParams.has(f.name)) continue;
          allParams.push({
            name: bodyParamName(f, pathParamNames),
            desc: f.deprecated ? (f.description ? `(deprecated) ${f.description}` : '(deprecated)') : f.description,
          });
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
  const groupedDocParams = collectGroupedParamNames(op);
  if (plan.hasQueryParams && !isPaginated) {
    for (const param of op.queryParams) {
      if (hiddenParams.has(param.name)) continue;
      if (groupedDocParams.has(param.name)) continue;
      const pn = fieldName(param.name);
      if (pathParamNames.has(pn)) continue;
      // Skip params already documented from body fields
      if (allParams.some((p) => p.name === pn)) continue;
      let desc = param.deprecated
        ? param.description
          ? `(deprecated) ${param.description}`
          : '(deprecated)'
        : param.description;
      if (param.default != null) {
        const defaultStr = `Defaults to \`${param.default}\`.`;
        desc = desc ? `${desc} ${defaultStr}` : defaultStr;
      }
      allParams.push({ name: pn, desc });
    }
  }

  // Add extra non-standard pagination query params
  if (isPaginated) {
    for (const paramName of ['limit', 'before', 'after', 'order']) {
      const param = op.queryParams.find((p) => p.name === paramName);
      let desc = param?.description;
      if (param?.default != null) {
        const defaultStr = `Defaults to \`${param.default}\`.`;
        desc = desc ? `${desc} ${defaultStr}` : defaultStr;
      }
      allParams.push({
        name: fieldName(paramName),
        desc,
      });
    }
    for (const param of op.queryParams) {
      if (['limit', 'before', 'after', 'order'].includes(param.name)) continue;
      if (groupedDocParams.has(param.name)) continue;
      let desc = param.deprecated
        ? param.description
          ? `(deprecated) ${param.description}`
          : '(deprecated)'
        : param.description;
      if (param.default != null) {
        const defaultStr = `Defaults to \`${param.default}\`.`;
        desc = desc ? `${desc} ${defaultStr}` : defaultStr;
      }
      allParams.push({ name: fieldName(param.name), desc });
    }
  }

  // Add parameter group docs
  for (const group of op.parameterGroups ?? []) {
    const variantClasses = group.variants.map((v) => groupVariantClassName(group.name, v.name));
    const readableGroup = group.name.replace(/_/g, ' ');
    const desc = `Identifies the ${readableGroup}. One of: ${variantClasses.join(', ')}.`;
    allParams.push({ name: fieldName(group.name), desc });
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
      emitDocArg(lines, p.name, p.desc);
    }
    lines.push(
      '            request_options: Per-request options. Supports extra_headers, timeout, max_retries, and base_url override.',
    );
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
  if (op.deprecated) {
    lines.push('');
    lines.push('        .. deprecated::');
    lines.push('            This operation is deprecated. See the migration guide for alternatives.');
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
  resolvedOp?: ResolvedOperation,
): void {
  const { pathParamNames, isArrayResponse, isRedirect, hasBearerOverride } = meta;
  const isPaginated = plan.isPaginated;
  const awaitPrefix = isAsync ? 'await ' : '';
  const usesClientCredentialDefaults = false;
  const hiddenParams = buildHiddenParams(resolvedOp);
  const opDefaults = getOpDefaults(resolvedOp);
  const opInferFromClient = getOpInferFromClient(resolvedOp);

  if (op.deprecated) {
    const method = toSnakeCase(op.name);
    lines.push(`        warnings.warn("${method} is deprecated", DeprecationWarning, stacklevel=2)`);
  }

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
        if (hiddenParams.has(f.name)) continue;
        redirectParamEntries.push({ key: f.name, varName: bodyParamName(f, pathParamNames) });
      }
    }
    for (const param of op.queryParams) {
      if (hiddenParams.has(param.name)) continue;
      const pn = fieldName(param.name);
      if (!redirectParamEntries.some((e) => e.varName === pn)) {
        redirectParamEntries.push({ key: param.name, varName: pn });
      }
    }
    const hasHiddenInjections =
      (opDefaults && Object.keys(opDefaults).length > 0) || (opInferFromClient && opInferFromClient.length > 0);
    if (redirectParamEntries.length > 0 || hasHiddenInjections) {
      lines.push('        params = {k: v for k, v in {');
      for (const entry of redirectParamEntries) {
        const param = op.queryParams.find((p) => p.name === entry.key);
        const value = param
          ? serializeParameterValue(param.type, entry.varName, false, (param as ParameterExt).explode)
          : entry.varName;
        lines.push(`            "${entry.key}": ${value},`);
      }
      lines.push('        }.items() if v is not None}');
      // Inject constant defaults
      if (Object.keys(opDefaults).length > 0) {
        for (const [key, value] of Object.entries(opDefaults)) {
          lines.push(`        params["${key}"] = ${pythonLiteral(value)}`);
        }
      }
      // Inject fields from client config
      if (opInferFromClient.length > 0) {
        for (const field of opInferFromClient) {
          const expr = clientFieldExpression(field);
          lines.push(`        if ${expr} is not None:`);
          lines.push(`            params["${field}"] = ${expr}`);
        }
      }
      if (usesClientCredentialDefaults) {
        if (op.queryParams.some((param) => param.name === 'client_id')) {
          lines.push('        params["client_id"] = params.get("client_id") or self._client._require_client_id()');
        }
        if (op.queryParams.some((param) => param.name === 'client_secret')) {
          lines.push(
            '        params["client_secret"] = params.get("client_secret") or self._client._require_api_key()',
          );
        }
      }
      lines.push(`        return self._client.build_url(${pathStr}, params)`);
    } else {
      lines.push(`        return self._client.build_url(${pathStr})`);
    }
  } else if (isPaginated) {
    const resolvedItemName = resolvePageItemName(op.pagination!.itemType, listWrapperNames, ctx);
    const itemTypeClass = className(resolvedItemName);
    const resolvedItemModel = ctx.spec.models.find((m) => m.name === resolvedItemName);
    const isDiscriminatorModel = !!(resolvedItemModel as any)?.discriminator;
    const variantTypeName = isDiscriminatorModel ? itemTypeClass + 'Variant' : null;
    const pageType = isAsync ? 'AsyncPage' : 'SyncPage';
    const orderParam = op.queryParams.find((p) => p.name === 'order');
    // Build query params dict
    lines.push('        params = {k: v for k, v in {');
    lines.push('            "limit": limit,');
    lines.push('            "before": before,');
    lines.push('            "after": after,');
    lines.push(
      `            "order": ${serializeParameterValue(orderParam?.type, 'order', false, (orderParam as ParameterExt | undefined)?.explode)},`,
    );
    const paginatedGroupedParams = collectGroupedParamNames(op);
    for (const param of op.queryParams) {
      if (['limit', 'before', 'after', 'order'].includes(param.name)) continue;
      if (hiddenParams.has(param.name)) continue;
      if (paginatedGroupedParams.has(param.name)) continue;
      const pn = fieldName(param.name);
      const value = serializeParameterValue(param.type, pn, param.required, (param as ParameterExt).explode);
      lines.push(`            "${param.name}": ${value},`);
    }
    lines.push('        }.items() if v is not None}');
    // Inject constant defaults
    if (Object.keys(opDefaults).length > 0) {
      for (const [key, value] of Object.entries(opDefaults)) {
        lines.push(`        params["${key}"] = ${pythonLiteral(value)}`);
      }
    }
    // Inject fields from client config
    if (opInferFromClient.length > 0) {
      for (const field of opInferFromClient) {
        const expr = clientFieldExpression(field);
        lines.push(`        if ${expr} is not None:`);
        lines.push(`            params["${field}"] = ${expr}`);
      }
    }
    // isinstance dispatch for parameter groups
    emitGroupDispatch(lines, op);
    if (isDiscriminatorModel && variantTypeName) {
      // Dispatcher model: cast the page to the variant union type so callers get
      // rich type information when iterating events.
      lines.push(`        return cast(`);
      lines.push(`            ${pageType}[${variantTypeName}],`);
      lines.push(`            ${awaitPrefix}self._client.request_page(`);
      lines.push(`                method="${httpMethod}",`);
      lines.push(`                path=${pathStr},`);
      lines.push(
        `                model=${itemTypeClass},  # type: ignore[arg-type]  # dispatcher; pagination only calls from_dict`,
      );
      lines.push('                params=params,');
      lines.push('                request_options=request_options,');
      lines.push('            )');
      lines.push('        )');
    } else {
      lines.push(`        return ${awaitPrefix}self._client.request_page(`);
      lines.push(`            method="${httpMethod}",`);
      lines.push(`            path=${pathStr},`);
      lines.push(`            model=${itemTypeClass},`);
      lines.push('            params=params,');
      lines.push('            request_options=request_options,');
      lines.push('        )');
    }
  } else if (plan.isDelete) {
    // Build body dict if the DELETE has a request body
    const deleteGroupedParams = collectGroupedParamNames(op);
    const deleteBodyFieldNames = new Set<string>();
    if (plan.hasBody && op.requestBody) {
      const bodyModel = ctx.spec.models.find((m) => op.requestBody?.kind === 'model' && m.name === op.requestBody.name);
      if (bodyModel) {
        const bodyFields = bodyModel.fields.filter(
          (f) => !hiddenParams.has(f.name) && !deleteGroupedParams.has(f.name),
        );
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
        // Inject constant defaults into body
        if (Object.keys(opDefaults).length > 0) {
          for (const [key, value] of Object.entries(opDefaults)) {
            lines.push(`        body["${key}"] = ${pythonLiteral(value)}`);
          }
        }
        // Inject fields from client config into body
        if (opInferFromClient.length > 0) {
          for (const field of opInferFromClient) {
            const expr = clientFieldExpression(field);
            lines.push(`        if ${expr} is not None:`);
            lines.push(`            body["${field}"] = ${expr}`);
          }
        }
        // isinstance dispatch for parameter groups into body
        emitGroupDispatch(lines, op, 'body', collectBodyFieldTypes(op, ctx.spec.models));
      }
    }
    // Build query params dict if any exist alongside the body/path
    const deleteHasParams =
      plan.hasQueryParams && emitQueryParamsDict(lines, op, pathParamNames, deleteBodyFieldNames, hiddenParams);
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
    const bodyGroupedParams = collectGroupedParamNames(op);
    const bodyModel = ctx.spec.models.find((m) => op.requestBody?.kind === 'model' && m.name === op.requestBody.name);
    const bodyFieldNamesSet = new Set<string>();
    if (bodyModel) {
      const bodyFields = bodyModel.fields.filter((f) => !hiddenParams.has(f.name) && !bodyGroupedParams.has(f.name));
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
      // Inject constant defaults into body
      if (Object.keys(opDefaults).length > 0) {
        for (const [key, value] of Object.entries(opDefaults)) {
          lines.push(`        body["${key}"] = ${pythonLiteral(value)}`);
        }
      }
      // Inject fields from client config into body
      if (opInferFromClient.length > 0) {
        for (const field of opInferFromClient) {
          const expr = clientFieldExpression(field);
          lines.push(`        if ${expr} is not None:`);
          lines.push(`            body["${field}"] = ${expr}`);
        }
      }
      // isinstance dispatch for parameter groups into body
      emitGroupDispatch(lines, op, 'body', collectBodyFieldTypes(op, ctx.spec.models));
    } else {
      // Union or non-model body — convert model instances to dicts
      lines.push('        _body: Dict[str, Any] = body if isinstance(body, dict) else body.to_dict()');
    }
    // Build query params dict if any exist alongside the body
    const bodyHasParams =
      plan.hasQueryParams && emitQueryParamsDict(lines, op, pathParamNames, bodyFieldNamesSet, hiddenParams);
    const bodyVarName = bodyModel ? 'body' : '_body';
    if (bodyModel && usesClientCredentialDefaults) {
      if (bodyModel.fields.some((f) => f.name === 'client_id')) {
        lines.push('        body["client_id"] = body.get("client_id") or self._client._require_client_id()');
      }
      if (bodyModel.fields.some((f) => f.name === 'client_secret')) {
        lines.push('        body["client_secret"] = body.get("client_secret") or self._client._require_api_key()');
      }
    }
    if (isArrayResponse) {
      // Array response with body: request_list returns List[Dict], then deserialize each item
      const itemModel = className(plan.responseModelName!);
      lines.push(`        raw = ${awaitPrefix}self._client.request_list(`);
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
      lines.push(`        return [${itemModel}.from_dict(cast(Dict[str, Any], item)) for item in raw]`);
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
    const getGroupedParams = collectGroupedParamNames(op);
    const hasGroups = (op.parameterGroups?.length ?? 0) > 0;
    const visibleQueryParams = op.queryParams.filter((p) => !hiddenParams.has(p.name) && !getGroupedParams.has(p.name));
    const hasVisibleQueryParams = plan.hasQueryParams && visibleQueryParams.length > 0;
    const hasInjections =
      (opDefaults && Object.keys(opDefaults).length > 0) || (opInferFromClient && opInferFromClient.length > 0);
    const needsParamsDict = hasVisibleQueryParams || hasInjections || hasGroups;
    if (needsParamsDict) {
      const hasOptionalQueryParams = visibleQueryParams.some((p) => !p.required);
      if (hasOptionalQueryParams) {
        lines.push('        params: Dict[str, Any] = {k: v for k, v in {');
        for (const param of visibleQueryParams) {
          const pn = fieldName(param.name);
          const value = serializeParameterValue(param.type, pn, param.required, (param as ParameterExt).explode);
          lines.push(`            "${param.name}": ${value},`);
        }
        lines.push('        }.items() if v is not None}');
      } else if (visibleQueryParams.length > 0) {
        lines.push('        params: Dict[str, Any] = {');
        for (const param of visibleQueryParams) {
          const pn = fieldName(param.name);
          const value = serializeParameterValue(param.type, pn, param.required, (param as ParameterExt).explode);
          lines.push(`            "${param.name}": ${value},`);
        }
        lines.push('        }');
      } else {
        // No visible query params but we have injections or groups — start with empty dict
        lines.push('        params: Dict[str, Any] = {}');
      }
      // Inject constant defaults
      if (Object.keys(opDefaults).length > 0) {
        for (const [key, value] of Object.entries(opDefaults)) {
          lines.push(`        params["${key}"] = ${pythonLiteral(value)}`);
        }
      }
      // Inject fields from client config
      if (opInferFromClient.length > 0) {
        for (const field of opInferFromClient) {
          const expr = clientFieldExpression(field);
          lines.push(`        if ${expr} is not None:`);
          lines.push(`            params["${field}"] = ${expr}`);
        }
      }
      if (usesClientCredentialDefaults) {
        if (op.queryParams.some((param) => param.name === 'client_id')) {
          lines.push('        params["client_id"] = params.get("client_id") or self._client._require_client_id()');
        }
        if (op.queryParams.some((param) => param.name === 'client_secret')) {
          lines.push(
            '        params["client_secret"] = params.get("client_secret") or self._client._require_api_key()',
          );
        }
      }
      // isinstance dispatch for parameter groups
      emitGroupDispatch(lines, op);
    }
    const emittedParams = needsParamsDict;
    if (isArrayResponse) {
      // Array response: request_list returns List[Dict], then deserialize each item
      const itemModel = className(plan.responseModelName!);
      lines.push(`        raw = ${awaitPrefix}self._client.request_list(`);
      lines.push(`            method="${httpMethod}",`);
      lines.push(`            path=${pathStr},`);
      if (emittedParams) {
        lines.push('            params=params,');
      }
      lines.push('            request_options=request_options,');
      lines.push('        )');
      lines.push(`        return [${itemModel}.from_dict(cast(Dict[str, Any], item)) for item in raw]`);
    } else {
      const returnPrefix = responseModel !== 'None' ? 'return ' : '';
      lines.push(`        ${returnPrefix}${awaitPrefix}self._client.request(`);
      lines.push(`            method="${httpMethod}",`);
      lines.push(`            path=${pathStr},`);
      if (emittedParams) {
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

/**
 * Emit isinstance dispatch blocks for all parameter groups on an operation.
 * Each group produces a chain of if/elif branches that test the group kwarg
 * against each variant dataclass and serializes the variant's parameters
 * into the target dict using their wire names.
 *
 * @param target - The Python dict variable to write into (e.g., "params" or "body").
 */
function emitGroupDispatch(
  lines: string[],
  op: Operation,
  target = 'params',
  bodyFieldTypes?: Map<string, TypeRef>,
): void {
  for (const group of op.parameterGroups ?? []) {
    const groupParam = fieldName(group.name);
    if (group.optional) {
      lines.push(`        if ${groupParam} is not None:`);
    }
    const indent = group.optional ? '    ' : '';
    let first = true;
    for (const variant of group.variants) {
      const variantClass = groupVariantClassName(group.name, variant.name);
      const keyword = first ? 'if' : 'elif';
      first = false;
      lines.push(`        ${indent}${keyword} isinstance(${groupParam}, ${variantClass}):`);
      for (const param of variant.parameters) {
        const pyField = fieldName(param.name);
        const resolvedType = bodyFieldTypes?.get(param.name) ?? param.type;
        const effectiveType = resolvedType.kind === 'nullable' ? resolvedType.inner : resolvedType;
        const isEnum = effectiveType.kind === 'enum';
        const value = isEnum ? `enum_value(${groupParam}.${pyField})` : `${groupParam}.${pyField}`;
        lines.push(`            ${indent}${target}["${param.name}"] = ${value}`);
      }
    }
  }
}

// ─── Main generator ──────────────────────────────────────────────────

/**
 * Generate Python resource class files from IR Service definitions.
 * Uses mount-based grouping: one resource file per mount target with all
 * co-mounted operations merged (flat pattern matching PHP).
 */
export function generateResources(services: Service[], ctx: EmitterContext): GeneratedFile[] {
  if (services.length === 0) return [];

  const resolvedLookup = buildResolvedLookup(ctx);
  const files: GeneratedFile[] = [];
  const mountDirMap = buildMountDirMap(ctx);
  const mountGroups = groupByMount(ctx);

  // Build mount group entries. When resolved operations are available, group by
  // mount target. Otherwise fall back to one group per service (for tests).
  const entries: Array<{ name: string; operations: Operation[] }> =
    mountGroups.size > 0
      ? [...mountGroups].map(([name, group]) => ({ name, operations: group.operations }))
      : services.map((s) => ({ name: resolveClassName(s, ctx), operations: s.operations }));

  for (const { name: mountName, operations: allOperations } of entries) {
    if (allOperations.length === 0) continue;
    const dirName = moduleName(mountName);
    const resourceClassName = className(mountName);
    const importPrefix = relativeImportPrefix(dirName);

    const lines: string[] = [];
    lines.push('from __future__ import annotations');
    lines.push('');
    lines.push('from typing import TYPE_CHECKING, Any, Dict, List, Literal, Optional, Type, Union, cast');
    lines.push('');
    lines.push('if TYPE_CHECKING:');
    lines.push(`    from ${importPrefix}_client import AsyncWorkOSClient, WorkOSClient`);
    lines.push('');

    const hasDeprecatedOps = allOperations.some((op) => op.deprecated);
    if (hasDeprecatedOps) {
      lines.push('import warnings');
      lines.push('');
    }

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

    for (const op of allOperations) {
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
          const importGroupedParams = collectGroupedParamNames(op);
          for (const f of bodyModel.fields) {
            if (importGroupedParams.has(f.name)) continue;
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
        // For discriminator (dispatcher) models also import the variant union type alias
        const paginationItemModel = ctx.spec.models.find((m) => m.name === paginationItemName);
        if ((paginationItemModel as any)?.discriminator) {
          modelImports.add(paginationItemName + 'Variant');
        }
      }
      // Collect model imports for union split wrapper response types
      const resolved = lookupResolved(op, resolvedLookup);
      if (resolved?.wrappers) {
        for (const w of resolved.wrappers) {
          if (w.responseModelName) modelImports.add(w.responseModelName);
        }
      }
    }

    // Filter enum imports to only those that actually exist in the spec
    const specEnumNames = new Set(ctx.spec.enums.map((e) => e.name));
    for (const name of enumImports) {
      if (!specEnumNames.has(name)) enumImports.delete(name);
    }

    if (enumImports.size > 0) {
      lines.push(`from ${importPrefix}_types import RequestOptions, enum_value`);
    } else {
      lines.push(`from ${importPrefix}_types import RequestOptions`);
    }
    const actualModelImports = [...modelImports];

    // Split imports into same-service and cross-service (using mount-based dirs)
    const modelToServiceMap = assignModelsToServices(ctx.spec.models, ctx.spec.services);
    // Discriminator variant type aliases (e.g. EventSchemaVariant) live in the same
    // service as their dispatcher model, so ensure they resolve to the same directory.
    for (const model of ctx.spec.models) {
      if ((model as any).discriminator) {
        const svc = modelToServiceMap.get(model.name);
        if (svc) modelToServiceMap.set(model.name + 'Variant', svc);
      }
    }
    const resolveModelDir = (modelName: string) => {
      const svc = modelToServiceMap.get(modelName);
      return svc ? (mountDirMap.get(svc) ?? 'common') : 'common';
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

    // Deduplicate: skip cross-service imports for models already available locally
    const localSet = new Set(localModels);

    if (localModels.length > 0) {
      lines.push(`from .models import ${localModels.map((n) => className(n)).join(', ')}`);
    }
    for (const [csDir, names] of [...crossServiceModels].sort()) {
      const unique = names.filter((n) => !localSet.has(n));
      for (const n of unique) {
        lines.push(`from ${ctx.namespace}.${dirToModule(csDir)}.models.${fileName(n)} import ${className(n)}`);
      }
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
      const enumDir = enumSvc ? (mountDirMap.get(enumSvc) ?? 'common') : 'common';
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
      for (const n of names) {
        lines.push(`from ${ctx.namespace}.${dirToModule(csDir)}.models.${fileName(n)} import ${className(n)}`);
      }
    }

    const hasPaginated = allOperations.some((op) => op.pagination);
    if (hasPaginated) {
      lines.push(`from ${importPrefix}_pagination import AsyncPage, SyncPage`);
    }
    // dataclass import + group variant definitions
    const hasGroups = hasParameterGroups(allOperations);
    if (hasGroups) {
      lines.push('from dataclasses import dataclass');
      const dataclassLines = generateParameterGroupDataclasses(allOperations, specEnumNames, ctx.spec.models);
      lines.push(...dataclassLines);
    }
    // --- Generate sync class ---
    lines.push('');
    lines.push(`class ${resourceClassName}:`);
    {
      let readable = resourceClassName.replace(/([a-z])([A-Z])/g, '$1 $2');
      readable = readable.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
      lines.push(`    """${readable} API resources."""`);
    }
    lines.push('');
    lines.push('    def __init__(self, client: "WorkOSClient") -> None:');
    lines.push('        self._client = client');

    const emittedMethods = new Set<string>();
    for (const op of allOperations) {
      const plan = planOperation(op);
      let method = lookupMethodName(op, resolvedLookup) ?? toSnakeCase(op.name);
      // On name collision, fall back to the full snake_case operation name
      if (emittedMethods.has(method)) {
        const fallback = toSnakeCase(op.name);
        if (fallback !== method && !emittedMethods.has(fallback)) {
          method = fallback;
        } else {
          continue;
        }
      }
      emittedMethods.add(method);

      // Look up the resolved operation for defaults/inferFromClient support
      const resolvedSync = lookupResolved(op, resolvedLookup);

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
        resolvedSync,
      );
      emitMethodDocstring(lines, op, plan, method, meta, specEnumNames, ctx, resolvedSync);
      emitMethodBody(lines, op, plan, meta, false, modelImports, listWrapperNames, ctx, resolvedSync);

      // Emit union split wrapper methods (e.g., authenticate_with_password)
      if (resolvedSync?.wrappers && resolvedSync.wrappers.length > 0) {
        lines.push(...generateSyncWrapperMethods(resolvedSync, ctx));
        for (const w of resolvedSync.wrappers) emittedMethods.add(w.name);
      }
    }

    // --- Generate async class ---
    const asyncClassName = `Async${resourceClassName}`;
    lines.push('');
    lines.push('');
    lines.push(`class ${asyncClassName}:`);
    {
      let readable = resourceClassName.replace(/([a-z])([A-Z])/g, '$1 $2');
      readable = readable.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
      lines.push(`    """${readable} API resources (async)."""`);
    }
    lines.push('');
    lines.push('    def __init__(self, client: "AsyncWorkOSClient") -> None:');
    lines.push('        self._client = client');

    const asyncEmittedMethods = new Set<string>();
    for (const op of allOperations) {
      const plan = planOperation(op);
      let method = lookupMethodName(op, resolvedLookup) ?? toSnakeCase(op.name);
      if (asyncEmittedMethods.has(method)) {
        const fallback = toSnakeCase(op.name);
        if (fallback !== method && !asyncEmittedMethods.has(fallback)) {
          method = fallback;
        } else {
          continue;
        }
      }
      asyncEmittedMethods.add(method);

      // Look up the resolved operation for defaults/inferFromClient support
      const resolvedAsync = lookupResolved(op, resolvedLookup);

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
        resolvedAsync,
      );
      emitMethodDocstring(lines, op, plan, method, meta, specEnumNames, ctx, resolvedAsync);
      emitMethodBody(lines, op, plan, meta, true, modelImports, listWrapperNames, ctx, resolvedAsync);

      // Emit union split wrapper methods (e.g., authenticate_with_password)
      if (resolvedAsync?.wrappers && resolvedAsync.wrappers.length > 0) {
        lines.push(...generateAsyncWrapperMethods(resolvedAsync, ctx));
        for (const w of resolvedAsync.wrappers) asyncEmittedMethods.add(w.name);
      }
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
  hiddenParams?: Set<string>,
): boolean {
  // Filter to query params that aren't already path params, body fields, or hidden
  const queryParams = op.queryParams.filter((p) => {
    if (hiddenParams?.has(p.name)) return false;
    const pn = fieldName(p.name);
    return !pathParamNames.has(pn) && !bodyFieldNames.has(pn);
  });
  if (queryParams.length === 0) return false;

  const hasOptional = queryParams.some((p) => !p.required);
  if (hasOptional) {
    lines.push('        params: Dict[str, Any] = {k: v for k, v in {');
    for (const param of queryParams) {
      lines.push(
        `            "${param.name}": ${serializeParameterValue(param.type, fieldName(param.name), param.required, (param as ParameterExt).explode)},`,
      );
    }
    lines.push('        }.items() if v is not None}');
  } else {
    lines.push('        params: Dict[str, Any] = {');
    for (const param of queryParams) {
      lines.push(
        `            "${param.name}": ${serializeParameterValue(param.type, fieldName(param.name), param.required, (param as ParameterExt).explode)},`,
      );
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
  if (effectiveType.kind === 'enum') {
    return serializeParameterValue(effectiveType, varName, isRequired);
  }
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

function serializeParameterValue(
  type: TypeRef | undefined,
  varName: string,
  isRequired: boolean,
  explode?: boolean,
): string {
  if (type?.kind === 'nullable') {
    return serializeParameterValue(type.inner, varName, false, explode);
  }
  if (type?.kind === 'enum') {
    const expr = `enum_value(${varName})`;
    return isRequired ? expr : `${expr} if ${varName} is not None else None`;
  }
  // For explode=false array params, emit comma-joined string
  if (explode === false && type?.kind === 'array') {
    const joinExpr = `",".join(str(v) for v in ${varName})`;
    return isRequired ? joinExpr : `${joinExpr} if ${varName} is not None else None`;
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
  403: 'AuthorizationError',
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
  }

  // Always include baseline errors for authenticated endpoints (401, 429, 5xx)
  if (!emittedCodes.has(401)) {
    lines.push('AuthenticationError: If the API key is invalid (401).');
  }
  if (!emittedCodes.has(429)) {
    lines.push('RateLimitExceededError: If rate limited (429).');
  }
  if (!emittedCodes.has(500)) {
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
    if (param.type.kind === 'enum' || (param.type.kind === 'nullable' && (param.type as any).inner?.kind === 'enum')) {
      fPath = fPath.replace(`{${param.name}}`, `{enum_value(${fieldName(param.name)})}`);
    } else {
      fPath = fPath.replace(`{${param.name}}`, `{${fieldName(param.name)}}`);
    }
  }
  return `f"${fPath}"`;
}
