import type {
  Service,
  Operation,
  OperationPlan,
  EmitterContext,
  GeneratedFile,
  ResolvedOperation,
} from '@workos/oagen';
import { planOperation, toSnakeCase } from '@workos/oagen';
import { isListWrapperModel } from './models.js';
import { mapTypeRef, mapTypeRefValue } from './type-map.js';
import { className, fieldName, methodName, resolveClassName, resolveMethodName, unexportedName } from './naming.js';
import {
  buildResolvedLookup,
  lookupResolved,
  groupByMount,
  getOpDefaults,
  getOpInferFromClient,
  buildHiddenParams,
  hasHiddenParams,
  collectGroupedParamNames,
} from '../shared/resolved-ops.js';
import { lowerFirstForDoc, fieldDocComment } from '../shared/naming-utils.js';
import { generateWrapperMethods } from './wrappers.js';

/**
 * Return path params sorted by their first occurrence in the URL template.
 * This ensures fmt.Sprintf args and function signatures match template order.
 */
export function sortPathParamsByTemplateOrder(op: Operation): typeof op.pathParams {
  return [...op.pathParams].sort((a, b) => {
    const posA = op.path.indexOf(`{${a.name}}`);
    const posB = op.path.indexOf(`{${b.name}}`);
    return posA - posB;
  });
}

/**
 * Resolve the resource class name for a service.
 */
export function resolveResourceClassName(service: Service, ctx: EmitterContext): string {
  return resolveClassName(service, ctx);
}

/**
 * Generate Go resource/service files from IR Service definitions.
 * Each mount group becomes a single .go file with an unexported service struct
 * and exported methods.
 */
export function generateResources(services: Service[], ctx: EmitterContext): GeneratedFile[] {
  if (services.length === 0) return [];

  const files: GeneratedFile[] = [];
  const mountGroups = groupByMount(ctx);

  // If no resolved operations, fall back to raw services
  const entries: Array<{ name: string; operations: Operation[] }> =
    mountGroups.size > 0
      ? [...mountGroups].map(([name, group]) => ({ name, operations: group.operations }))
      : services.map((s) => ({ name: resolveResourceClassName(s, ctx), operations: s.operations }));

  for (const { name: mountName, operations } of entries) {
    if (operations.length === 0) continue;
    const file = generateServiceFile(mountName, operations, ctx);
    if (file) files.push(file);
  }

  return files;
}

function generateServiceFile(mountName: string, operations: Operation[], ctx: EmitterContext): GeneratedFile | null {
  const lines: string[] = [];
  const serviceType = serviceTypeName(mountName);
  const goFile = `${toSnakeCase(mountName)}.go`;

  // Build resolved lookup once for the whole file
  const resolvedLookup = buildResolvedLookup(ctx);

  // Determine which imports are needed
  const needsFmt = operations.some((op) => op.pathParams.length > 0);
  const needsNetUrl = operations.some((op) => {
    const resolved = lookupResolved(op, resolvedLookup);
    if (resolved?.urlBuilder) return true;
    if (resolved && hasHiddenParams(resolved) && op.httpMethod.toLowerCase() === 'get') return true;
    if ((op.parameterGroups?.length ?? 0) > 0) return true;
    return false;
  });
  const needsStrings = needsStringsImport(operations, resolvedLookup);
  // context is needed only for methods that make HTTP calls. URL-builder ops
  // don't take ctx, so a file that contains *only* URL builders would have
  // an unused import.
  const needsContext = operations.some((op) => {
    const resolved = lookupResolved(op, resolvedLookup);
    return !resolved?.urlBuilder;
  });

  lines.push(`package ${ctx.namespace}`);
  lines.push('');
  lines.push('import (');
  if (needsContext) {
    lines.push('\t"context"');
  }
  if (needsFmt) {
    lines.push('\t"fmt"');
  }
  if (needsNetUrl) {
    lines.push('\t"net/url"');
  }
  if (needsStrings) {
    lines.push('\t"strings"');
  }
  lines.push(')');
  lines.push('');

  // Service struct
  lines.push(`// ${serviceType} handles ${mountName} operations.`);
  lines.push(`type ${serviceType} struct {`);
  lines.push('\tclient *Client');
  lines.push('}');
  lines.push('');

  // Generate params structs and methods for each operation.
  // Deduplicate by method name -- multiple IR operations can resolve to the same
  // Go method name when mounted from different IR services.
  const emittedMethods = new Set<string>();
  for (const op of operations) {
    const plan = planOperation(op);
    const method = resolveGoMethodName(op, mountName, ctx);

    if (emittedMethods.has(method)) continue;
    emittedMethods.add(method);

    const resolvedOp = lookupResolved(op, resolvedLookup);
    const hasWrappers = (resolvedOp?.wrappers?.length ?? 0) > 0;

    // When wrappers exist (union-body operations like Authenticate), only
    // the typed per-variant wrapper methods are emitted. The parent method
    // would otherwise carry `Body interface{}` and defeat type safety.
    if (!hasWrappers) {
      // Emit parameter group sum types (interface + variant structs)
      if ((op.parameterGroups?.length ?? 0) > 0) {
        lines.push(generateParameterGroupTypes(mountName, op));
      }

      const paramsStruct = generateParamsStruct(mountName, method, op, plan, ctx, resolvedOp);
      if (paramsStruct) {
        lines.push(paramsStruct);
        lines.push('');
      }

      const methodCode = generateMethod(serviceType, mountName, method, op, plan, ctx, resolvedOp);
      lines.push(methodCode);
      lines.push('');
    }

    // Generate union split wrapper methods (e.g., AuthenticateWithPassword)
    if (hasWrappers && resolvedOp) {
      const wrapperLines = generateWrapperMethods(serviceType, resolvedOp, ctx);
      lines.push(...wrapperLines);
      for (const w of resolvedOp.wrappers!) {
        emittedMethods.add(methodName(w.name));
      }
    }
  }

  return {
    path: goFile,
    content: lines.join('\n'),
    overwriteExisting: true,
  };
}

function resolveGoMethodName(op: Operation, mountName: string, ctx: EmitterContext): string {
  return resolveMethodName(op, { name: mountName, operations: [op] }, ctx);
}

export function paramsStructName(mountName: string, method: string): string {
  // Prefix with mount name to avoid cross-file collisions in flat package
  const prefix = className(mountName);
  // If method already starts with the mount name, don't double-prefix
  if (method.startsWith(prefix)) return `${method}Params`;
  return `${prefix}${method}Params`;
}

/**
 * Unexported struct name used as the typed JSON body for a non-wrapper
 * operation that has hidden params (defaults / inferFromClient). Mirrors
 * the wrapper convention (`<methodLowerCamel>Body`).
 */
function hiddenParamsBodyStructName(method: string): string {
  return `${unexportedName(method)}Body`;
}

// ---------------------------------------------------------------------------
// Mutually-exclusive parameter group support
// ---------------------------------------------------------------------------

/** Interface type name for a parameter group (e.g. AuthorizationParentResource). */
function groupInterfaceName(mountName: string, groupName: string): string {
  return `${className(mountName)}${fieldName(groupName)}`;
}

/** Variant struct type name (e.g. AuthorizationParentResourceByID). */
function groupVariantTypeName(mountName: string, groupName: string, variantName: string): string {
  return `${className(mountName)}${fieldName(groupName)}${fieldName(variantName)}`;
}

/**
 * Derive a short field name for a parameter within a variant struct.
 * Strips the group name prefix when present to avoid stuttering
 * (e.g. parent_resource_id in group parent_resource -> ID).
 */
function deriveVariantFieldName(paramName: string, groupName: string): string {
  const prefix = groupName + '_';
  const stripped = paramName.startsWith(prefix) ? paramName.slice(prefix.length) : paramName;
  return fieldName(stripped);
}

/**
 * Generate Go interface and variant struct definitions for all parameter groups
 * on an operation. Each group becomes a sealed interface (unexported marker
 * method) with concrete variant structs that implement applyToQuery.
 */
function generateParameterGroupTypes(mountName: string, op: Operation): string {
  const lines: string[] = [];

  for (const group of op.parameterGroups ?? []) {
    const ifaceName = groupInterfaceName(mountName, group.name);
    const markerMethod = `is${ifaceName}`;

    // Godoc for interface listing variant types
    const variantNames = group.variants.map((v) => groupVariantTypeName(mountName, group.name, v.name));
    lines.push(`// ${ifaceName} is one of:`);
    for (const vn of variantNames) {
      lines.push(`//   - ${vn}`);
    }
    lines.push(`type ${ifaceName} interface {`);
    lines.push(`\t${markerMethod}()`);
    lines.push('\tapplyToQuery(url.Values)');
    lines.push('}');
    lines.push('');

    // Emit each variant: struct + marker method + applyToQuery
    for (const variant of group.variants) {
      const typeName = groupVariantTypeName(mountName, group.name, variant.name);

      lines.push(`type ${typeName} struct {`);
      for (const param of variant.parameters) {
        const goField = deriveVariantFieldName(param.name, group.name);
        const goType = mapTypeRefValue(param.type);
        lines.push(`\t${goField} ${goType}`);
      }
      lines.push('}');
      lines.push('');

      lines.push(`func (p ${typeName}) ${markerMethod}() {}`);

      lines.push(`func (p ${typeName}) applyToQuery(v url.Values) {`);
      for (const param of variant.parameters) {
        const goField = deriveVariantFieldName(param.name, group.name);
        lines.push(`\tv.Set("${param.name}", ${formatQueryValue(`p.${goField}`, param.type)})`);
      }
      lines.push('}');
      lines.push('');
    }
  }

  return lines.join('\n');
}

function generateParamsStruct(
  mountName: string,
  method: string,
  op: Operation,
  plan: OperationPlan,
  ctx: EmitterContext,
  resolvedOp?: ResolvedOperation,
): string | null {
  // Build set of hidden param names (defaults + inferFromClient)
  const hidden = buildHiddenParams(resolvedOp);
  const groupedParams = collectGroupedParamNames(op);
  const hasGroups = (op.parameterGroups?.length ?? 0) > 0;

  const hasQueryParams = op.queryParams.filter((qp) => !hidden.has(qp.name) && !groupedParams.has(qp.name)).length > 0;
  const hasBody = plan.hasBody && op.requestBody;

  // Check if body has any visible fields after filtering
  let hasVisibleBodyFields = false;
  if (hasBody && op.requestBody?.kind === 'model') {
    const bodyModel = ctx.spec.models.find((m) => op.requestBody?.kind === 'model' && m.name === op.requestBody.name);
    if (bodyModel) {
      hasVisibleBodyFields = bodyModel.fields.some((f) => !hidden.has(f.name));
    }
  } else if (hasBody) {
    hasVisibleBodyFields = true; // non-model body always visible
  }

  if (!hasQueryParams && !hasVisibleBodyFields && !hasGroups) return null;

  const lines: string[] = [];
  const structName = paramsStructName(mountName, method);

  lines.push(`// ${structName} contains the parameters for ${method}.`);
  lines.push(`type ${structName} struct {`);

  // Track emitted field names to avoid duplicates
  const emittedFields = new Set<string>();

  // Body fields (if body is a model)
  if (hasBody && op.requestBody?.kind === 'model') {
    const bodyModel = ctx.spec.models.find((m) => op.requestBody?.kind === 'model' && m.name === op.requestBody.name);
    if (bodyModel) {
      for (const field of bodyModel.fields) {
        if (hidden.has(field.name)) continue;
        const goField = fieldName(field.name);
        if (emittedFields.has(goField)) continue;
        emittedFields.add(goField);
        const isOptional = !field.required;
        const goType = isOptional ? makeOptional(mapTypeRef(field.type)) : mapTypeRef(field.type);
        const jsonTag = field.required ? `json:"${field.name}"` : `json:"${field.name},omitempty"`;
        // If this field also appears in query params, emit a url tag too
        const isAlsoQueryParam = op.queryParams.some((qp) => !hidden.has(qp.name) && fieldName(qp.name) === goField);
        const urlTag = isAlsoQueryParam ? ` url:"${field.name}${field.required ? '' : ',omitempty'}"` : '';
        if (field.description) {
          const fdLines = field.description.split('\n').filter((l) => l.trim());
          lines.push(`\t// ${fieldDocComment(goField, fdLines[0])}`);
          for (let i = 1; i < fdLines.length; i++) {
            lines.push(`\t// ${fdLines[i].trim()}`);
          }
        }
        if (field.deprecated) {
          if (field.description) lines.push(`\t//`);
          lines.push(`\t// Deprecated: this field is deprecated.`);
        }
        lines.push(`\t${goField} ${goType} \`${jsonTag}${urlTag}\``);
      }
    }
  } else if (hasBody) {
    // Non-model body (generic)
    lines.push('\tBody interface{} `json:"-"`');
  }

  // Check if this is a list operation with standard pagination fields.
  // If so, embed PaginationParams and skip those fields individually.
  const PAGINATION_FIELDS = new Set(['before', 'after', 'limit', 'order']);
  const visibleQueryParams = op.queryParams.filter((qp) => !hidden.has(qp.name) && !groupedParams.has(qp.name));
  const hasPaginationFields = ['before', 'after', 'limit'].every((name) =>
    visibleQueryParams.some((qp) => qp.name === name),
  );
  if (hasPaginationFields) {
    lines.push('\tPaginationParams');
  }

  // Query params (skip any already emitted from body fields, hidden params, grouped params, and pagination fields)
  for (const param of op.queryParams) {
    if (hidden.has(param.name)) continue;
    if (groupedParams.has(param.name)) continue;
    if (hasPaginationFields && PAGINATION_FIELDS.has(param.name)) continue;
    const goField = fieldName(param.name);
    if (emittedFields.has(goField)) continue;
    emittedFields.add(goField);
    const isOptional = !param.required;
    const paramType = mapQueryParamType(param.name, param.type);
    const goType = isOptional ? makeOptional(paramType) : paramType;
    const urlTag = param.required ? `url:"${param.name}"` : `url:"${param.name},omitempty"`;
    const jsonTag = 'json:"-"';
    if (param.description) {
      const pdLines = param.description.split('\n').filter((l) => l.trim());
      lines.push(`\t// ${fieldDocComment(goField, pdLines[0])}`);
      for (let i = 1; i < pdLines.length; i++) {
        lines.push(`\t// ${pdLines[i].trim()}`);
      }
    }
    if (param.default != null) {
      const defaultLine = `\t// Defaults to ${JSON.stringify(param.default)}.`;
      if (!param.description) lines.push(defaultLine);
      else lines.push(defaultLine);
    }
    if (param.deprecated) {
      if (param.description || param.default != null) lines.push(`\t//`);
      lines.push(`\t// Deprecated: this parameter is deprecated.`);
    }
    lines.push(`\t${goField} ${goType} \`${urlTag} ${jsonTag}\``);
  }

  // Parameter group fields (sum-type interfaces, serialized via applyToQuery)
  for (const group of op.parameterGroups ?? []) {
    const goField = fieldName(group.name);
    const goType = groupInterfaceName(mountName, group.name);
    if (group.optional) {
      lines.push(`\t// ${goField} optionally identifies the ${group.name.replace(/_/g, ' ')}.`);
    } else {
      lines.push(`\t// ${goField} identifies the ${group.name.replace(/_/g, ' ')} (required).`);
    }
    lines.push(`\t${goField} ${goType} \`url:"-" json:"-"\``);
  }

  lines.push('}');
  return lines.join('\n');
}

function generateMethod(
  serviceType: string,
  mountName: string,
  method: string,
  op: Operation,
  plan: OperationPlan,
  _ctx: EmitterContext,
  resolvedOp?: ResolvedOperation,
): string {
  const lines: string[] = [];
  const isPaginated = plan.isPaginated;
  const isDelete = plan.isDelete;
  const hasBody = plan.hasBody && op.requestBody;
  const hidden = buildHiddenParams(resolvedOp);
  const hasGroups = (op.parameterGroups?.length ?? 0) > 0;
  const hasVisibleQueryParams = op.queryParams.filter((qp) => !hidden.has(qp.name)).length > 0;

  // Check if body has visible fields after filtering hidden params
  let hasVisibleBodyFields = false;
  if (hasBody && op.requestBody?.kind === 'model') {
    const bodyModel = _ctx.spec.models.find((m) => op.requestBody?.kind === 'model' && m.name === op.requestBody.name);
    if (bodyModel) {
      hasVisibleBodyFields = bodyModel.fields.some((f) => !hidden.has(f.name));
    }
  } else if (hasBody) {
    hasVisibleBodyFields = true;
  }

  const hasParams = hasVisibleBodyFields || hasVisibleQueryParams || hasGroups;
  const paramsType = hasParams ? `*${paramsStructName(mountName, method)}` : null;
  const bodyArg = hasBody && hasParams ? bodyArgument(op) : 'nil';
  const hasHidden = hasHiddenParams(resolvedOp);
  const isGet = op.httpMethod.toLowerCase() === 'get';
  const isUrlBuilder = resolvedOp?.urlBuilder ?? false;

  // Detect if response is a raw array (not paginated)
  const isArrayResponse = !isPaginated && op.response?.kind === 'array';

  // Emit a typed body struct *before* the method for non-GET ops with hidden
  // params (defaults / inferFromClient). The struct gives consumers a
  // deterministic wire format and avoids `map[string]interface{}` literals.
  if (hasHidden && !isGet && hasBody) {
    emitHiddenParamsBodyStruct(lines, method, op, _ctx, resolvedOp!);
    lines.push('');
  }

  // Return type
  let returnType: string;
  if (isUrlBuilder) {
    returnType = 'string';
  } else if (isPaginated && op.pagination) {
    const itemType = resolveIteratorItemType(op.pagination.itemType, _ctx);
    returnType = `*Iterator[${itemType}]`;
  } else if (isDelete) {
    returnType = 'error';
  } else if (plan.responseModelName) {
    const respType = className(plan.responseModelName);
    if (isArrayResponse) {
      returnType = `([]${respType}, error)`;
    } else {
      returnType = `(*${respType}, error)`;
    }
  } else {
    returnType = 'error';
  }

  // Build godoc -- wrap multi-line descriptions in // comments
  if (op.description) {
    const descLines = op.description.split('\n').filter((l) => l.trim());
    lines.push(`// ${method} ${lowerFirstDesc(descLines[0])}`);
    for (let i = 1; i < descLines.length; i++) {
      lines.push(`// ${descLines[i].trim()}`);
    }
  }
  for (const p of op.pathParams) {
    if (p.deprecated) {
      lines.push(`//`);
      lines.push(`// Deprecated parameter ${fieldName(p.name)}${p.description ? ': ' + p.description : '.'}`);
    }
  }
  if (op.deprecated) {
    lines.push(`//`);
    lines.push(`// Deprecated: this operation is deprecated.`);
  }

  // Method signature — URL builders don't take ctx (no I/O) and return a string.
  const params: string[] = isUrlBuilder ? [] : ['ctx context.Context'];
  // Path params as positional args (sorted by template order)
  for (const p of sortPathParamsByTemplateOrder(op)) {
    params.push(`${lowerFirst(fieldName(p.name))} ${mapTypeRefValue(p.type)}`);
  }
  if (paramsType) {
    params.push(`params ${paramsType}`);
  }
  params.push('opts ...RequestOption');

  lines.push(`func (s *${serviceType}) ${method}(${params.join(', ')}) ${returnType} {`);

  // Build path
  const pathExpr = buildPathExpr(op);

  // URL-builder ops construct the URL client-side and return it without
  // performing any HTTP I/O.
  if (isUrlBuilder) {
    emitUrlBuilderMethod(lines, op, pathExpr, resolvedOp!, paramsType);
    lines.push('}');
    return lines.join('\n');
  }

  // For GET operations with hidden params or parameter groups, build query
  // via url.Values so we can inject defaults, inferred values, and/or call
  // applyToQuery on grouped parameter variants.
  if ((hasHidden || hasGroups) && isGet) {
    emitGetWithHiddenParams(
      lines,
      op,
      pathExpr,
      plan,
      _ctx,
      resolvedOp!,
      paramsType,
      isPaginated,
      isDelete,
      isArrayResponse,
    );
  } else if (hasHidden && !isGet && hasBody) {
    // For non-GET operations with hidden params, build a typed body struct
    emitBodyWithHiddenParams(
      lines,
      op,
      pathExpr,
      plan,
      _ctx,
      resolvedOp!,
      paramsType,
      isPaginated,
      isDelete,
      isArrayResponse,
      method,
    );
  } else if (isPaginated && op.pagination) {
    const itemType = resolveIteratorItemType(op.pagination.itemType, _ctx);
    const dataPath = op.pagination.dataPath ? `"${op.pagination.dataPath}"` : `"data"`;
    const cursorParam = '"after"';
    lines.push(
      `\treturn newIterator[${itemType}](ctx, s.client, "${op.httpMethod.toUpperCase()}", ${pathExpr}, ${hasVisibleQueryParams ? 'params' : 'nil'}, ${cursorParam}, ${dataPath}, opts)`,
    );
  } else if (isDelete) {
    lines.push(
      `\t_, err := s.client.request(ctx, "${op.httpMethod.toUpperCase()}", ${pathExpr}, ${hasVisibleQueryParams ? 'params' : 'nil'}, ${bodyArg}, nil, opts)`,
    );
    lines.push('\treturn err');
  } else if (plan.responseModelName) {
    const respType = className(plan.responseModelName);
    if (isArrayResponse) {
      lines.push(`\tvar result []${respType}`);
      lines.push(
        `\t_, err := s.client.request(ctx, "${op.httpMethod.toUpperCase()}", ${pathExpr}, ${hasVisibleQueryParams ? 'params' : 'nil'}, ${bodyArg}, &result, opts)`,
      );
      lines.push('\tif err != nil {');
      lines.push('\t\treturn nil, err');
      lines.push('\t}');
      lines.push('\treturn result, nil');
    } else {
      lines.push(`\tvar result ${respType}`);
      lines.push(
        `\t_, err := s.client.request(ctx, "${op.httpMethod.toUpperCase()}", ${pathExpr}, ${hasVisibleQueryParams ? 'params' : 'nil'}, ${bodyArg}, &result, opts)`,
      );
      lines.push('\tif err != nil {');
      lines.push('\t\treturn nil, err');
      lines.push('\t}');
      lines.push('\treturn &result, nil');
    }
  } else {
    lines.push(
      `\t_, err := s.client.request(ctx, "${op.httpMethod.toUpperCase()}", ${pathExpr}, ${hasVisibleQueryParams ? 'params' : 'nil'}, ${bodyArg}, nil, opts)`,
    );
    lines.push('\treturn err');
  }

  lines.push('}');
  return lines.join('\n');
}

// buildHiddenParams and hasHiddenParams are imported from ../shared/resolved-ops.js

/** Convert a JS value to a Go literal. */
function goLiteral(value: string | number | boolean): string {
  if (typeof value === 'string') return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/** Get the Go expression for reading a client config field. */
function clientFieldExpression(field: string): string {
  switch (field) {
    case 'client_id':
      return 's.client.clientID';
    case 'client_secret':
      return 's.client.apiKey';
    default:
      return `s.client.${lowerFirst(fieldName(field))}`;
  }
}

/**
 * Emit method body for GET operations that have hidden params (defaults/inferFromClient).
 * Builds a url.Values manually so we can inject hidden values alongside user-provided query params.
 */
function emitGetWithHiddenParams(
  lines: string[],
  op: Operation,
  pathExpr: string,
  plan: OperationPlan,
  ctx: EmitterContext,
  resolvedOp: ResolvedOperation,
  paramsType: string | null,
  isPaginated: boolean,
  isDelete: boolean,
  isArrayResponse: boolean,
): void {
  const hidden = buildHiddenParams(resolvedOp);

  // Build url.Values with hidden + user-provided params
  lines.push('\tquery := url.Values{}');

  // Inject constant defaults
  for (const [key, value] of Object.entries(getOpDefaults(resolvedOp))) {
    lines.push(`\tquery.Set("${key}", ${goLiteralForQuery(value as string | number | boolean)})`);
  }

  // Inject inferred fields from client config
  for (const field of getOpInferFromClient(resolvedOp)) {
    const expr = clientFieldExpression(field);
    lines.push(`\tif ${expr} != "" {`);
    lines.push(`\t\tquery.Set("${field}", ${expr})`);
    lines.push('\t}');
  }

  // Add user-provided query params from the struct (excluding grouped params
  // which are serialized via their variant's applyToQuery method)
  if (paramsType) {
    const groupedParamNames = collectGroupedParamNames(op);
    const visibleQueryParams = op.queryParams.filter((qp) => !hidden.has(qp.name) && !groupedParamNames.has(qp.name));
    for (const param of visibleQueryParams) {
      const goField = fieldName(param.name);
      const isMap = param.type.kind === 'map';
      if (isMap) {
        // Maps use bracket encoding: param[key]=value
        if (param.required) {
          lines.push(`\tfor k, v := range params.${goField} {`);
          lines.push(`\t\tquery.Set(fmt.Sprintf("${param.name}[%s]", k), fmt.Sprintf("%v", v))`);
          lines.push('\t}');
        } else {
          lines.push(`\tif params.${goField} != nil {`);
          lines.push(`\t\tfor k, v := range params.${goField} {`);
          lines.push(`\t\t\tquery.Set(fmt.Sprintf("${param.name}[%s]", k), fmt.Sprintf("%v", v))`);
          lines.push('\t\t}');
          lines.push('\t}');
        }
      } else if (param.required) {
        lines.push(`\tquery.Set("${param.name}", ${formatQueryValue(`params.${goField}`, param.type)})`);
      } else {
        // Slices are reference types in Go -- nil-able without pointer wrapping
        const isRefType = param.type.kind === 'array';
        const valueExpr = isRefType ? `params.${goField}` : `*params.${goField}`;
        lines.push(`\tif params.${goField} != nil {`);
        lines.push(`\t\tquery.Set("${param.name}", ${formatQueryValue(valueExpr, param.type)})`);
        lines.push('\t}');
      }
    }

    // Apply parameter group variants to the query via applyToQuery
    for (const group of op.parameterGroups ?? []) {
      const goField = fieldName(group.name);
      lines.push(`\tif params.${goField} != nil {`);
      lines.push(`\t\tparams.${goField}.applyToQuery(query)`);
      lines.push('\t}');
    }
  }

  // Make the request with query as the 4th arg
  if (isPaginated && op.pagination) {
    const itemType = resolveIteratorItemType(op.pagination.itemType, ctx);
    const dataPath = op.pagination.dataPath ? `"${op.pagination.dataPath}"` : `"data"`;
    const cursorParam = '"after"';
    lines.push(
      `\treturn newIterator[${itemType}](ctx, s.client, "GET", ${pathExpr}, query, ${cursorParam}, ${dataPath}, opts)`,
    );
  } else if (isDelete) {
    lines.push(`\t_, err := s.client.request(ctx, "GET", ${pathExpr}, query, nil, nil, opts)`);
    lines.push('\treturn err');
  } else if (plan.responseModelName) {
    const respType = className(plan.responseModelName);
    if (isArrayResponse) {
      lines.push(`\tvar result []${respType}`);
      lines.push(`\t_, err := s.client.request(ctx, "GET", ${pathExpr}, query, nil, &result, opts)`);
      lines.push('\tif err != nil {');
      lines.push('\t\treturn nil, err');
      lines.push('\t}');
      lines.push('\treturn result, nil');
    } else {
      lines.push(`\tvar result ${respType}`);
      lines.push(`\t_, err := s.client.request(ctx, "GET", ${pathExpr}, query, nil, &result, opts)`);
      lines.push('\tif err != nil {');
      lines.push('\t\treturn nil, err');
      lines.push('\t}');
      lines.push('\treturn &result, nil');
    }
  } else {
    lines.push(`\t_, err := s.client.request(ctx, "GET", ${pathExpr}, query, nil, nil, opts)`);
    lines.push('\treturn err');
  }
}

/**
 * Emit method body for URL-builder operations (OAuth redirect endpoints).
 * Builds a url.Values from defaults + inferred + user-provided params, then
 * returns `s.client.buildURL(path, query, opts)` without performing any I/O.
 */
function emitUrlBuilderMethod(
  lines: string[],
  op: Operation,
  pathExpr: string,
  resolvedOp: ResolvedOperation,
  paramsType: string | null,
): void {
  const hidden = buildHiddenParams(resolvedOp);

  lines.push('\tquery := url.Values{}');

  // Inject constant defaults (e.g., response_type=code)
  for (const [key, value] of Object.entries(getOpDefaults(resolvedOp))) {
    lines.push(`\tquery.Set("${key}", ${goLiteralForQuery(value as string | number | boolean)})`);
  }

  // Inject inferred fields from client config (e.g., client_id)
  for (const field of getOpInferFromClient(resolvedOp)) {
    const expr = clientFieldExpression(field);
    lines.push(`\tif ${expr} != "" {`);
    lines.push(`\t\tquery.Set("${field}", ${expr})`);
    lines.push('\t}');
  }

  // Add user-provided query params from the struct
  if (paramsType) {
    const visibleQueryParams = op.queryParams.filter((qp) => !hidden.has(qp.name));
    for (const param of visibleQueryParams) {
      const goField = fieldName(param.name);
      const isMap = param.type.kind === 'map';
      if (isMap) {
        if (param.required) {
          lines.push(`\tfor k, v := range params.${goField} {`);
          lines.push(`\t\tquery.Set(fmt.Sprintf("${param.name}[%s]", k), fmt.Sprintf("%v", v))`);
          lines.push('\t}');
        } else {
          lines.push(`\tif params.${goField} != nil {`);
          lines.push(`\t\tfor k, v := range params.${goField} {`);
          lines.push(`\t\t\tquery.Set(fmt.Sprintf("${param.name}[%s]", k), fmt.Sprintf("%v", v))`);
          lines.push('\t\t}');
          lines.push('\t}');
        }
      } else if (param.required) {
        lines.push(`\tquery.Set("${param.name}", ${formatQueryValue(`params.${goField}`, param.type)})`);
      } else {
        const isRefType = param.type.kind === 'array';
        const valueExpr = isRefType ? `params.${goField}` : `*params.${goField}`;
        lines.push(`\tif params.${goField} != nil {`);
        lines.push(`\t\tquery.Set("${param.name}", ${formatQueryValue(valueExpr, param.type)})`);
        lines.push('\t}');
      }
    }
  }

  lines.push(`\treturn s.client.buildURL(${pathExpr}, query, opts)`);
}

/**
 * Emit a private typed body struct for a non-GET operation that has hidden
 * params. Field order matches how `emitBodyWithHiddenParams` constructs the
 * body at the call site: defaults → required exposed → inferred → optional
 * exposed. Mirrors `emitWrapperBodyStruct` in `wrappers.ts`.
 */
function emitHiddenParamsBodyStruct(
  lines: string[],
  method: string,
  op: Operation,
  ctx: EmitterContext,
  resolvedOp: ResolvedOperation,
): void {
  const hidden = buildHiddenParams(resolvedOp);
  const structName = hiddenParamsBodyStructName(method);

  const bodyModel =
    op.requestBody?.kind === 'model'
      ? ctx.spec.models.find((m) => op.requestBody?.kind === 'model' && m.name === op.requestBody.name)
      : undefined;

  lines.push(`// ${structName} is the JSON request body for ${method}.`);
  lines.push(`type ${structName} struct {`);

  // Constant defaults (always sent — no omitempty so the wire format is deterministic)
  for (const [key, value] of Object.entries(getOpDefaults(resolvedOp))) {
    const goField = fieldName(key);
    const goType = typeof value === 'boolean' ? 'bool' : typeof value === 'number' ? 'int' : 'string';
    lines.push(`\t${goField} ${goType} \`json:"${key}"\``);
  }

  // Required exposed body fields
  if (bodyModel) {
    for (const field of bodyModel.fields) {
      if (hidden.has(field.name)) continue;
      if (!field.required) continue;
      const goField = fieldName(field.name);
      const goType = mapTypeRef(field.type);
      lines.push(`\t${goField} ${goType} \`json:"${field.name}"\``);
    }
  }

  // Inferred fields from client config (omitempty drops empty strings)
  for (const inferred of getOpInferFromClient(resolvedOp)) {
    const goField = fieldName(inferred);
    lines.push(`\t${goField} string \`json:"${inferred},omitempty"\``);
  }

  // Optional exposed body fields (pointer/slice/map + omitempty)
  if (bodyModel) {
    for (const field of bodyModel.fields) {
      if (hidden.has(field.name)) continue;
      if (field.required) continue;
      const goField = fieldName(field.name);
      const goType = makeOptional(mapTypeRef(field.type));
      lines.push(`\t${goField} ${goType} \`json:"${field.name},omitempty"\``);
    }
  }

  lines.push('}');
}

/**
 * Emit method body for non-GET operations that have hidden params (defaults
 * / inferFromClient). Builds a typed body struct (declared by
 * `emitHiddenParamsBodyStruct`) so the wire format is deterministic and
 * statically typed.
 */
function emitBodyWithHiddenParams(
  lines: string[],
  op: Operation,
  pathExpr: string,
  plan: OperationPlan,
  ctx: EmitterContext,
  resolvedOp: ResolvedOperation,
  paramsType: string | null,
  _isPaginated: boolean,
  isDelete: boolean,
  isArrayResponse: boolean,
  method: string,
): void {
  const hidden = buildHiddenParams(resolvedOp);
  const bodyType = hiddenParamsBodyStructName(method);

  const bodyModel =
    op.requestBody?.kind === 'model'
      ? ctx.spec.models.find((m) => op.requestBody?.kind === 'model' && m.name === op.requestBody.name)
      : undefined;

  // Build typed body struct literal — defaults + required user fields first
  lines.push(`\tbody := ${bodyType}{`);

  for (const [key, value] of Object.entries(getOpDefaults(resolvedOp))) {
    lines.push(`\t\t${fieldName(key)}: ${goLiteral(value as string | number | boolean)},`);
  }

  if (paramsType && bodyModel) {
    for (const field of bodyModel.fields) {
      if (hidden.has(field.name)) continue;
      if (!field.required) continue;
      const goField = fieldName(field.name);
      lines.push(`\t\t${goField}: params.${goField},`);
    }
  }

  lines.push('\t}');

  // Inferred fields from client config — omitempty drops empty values
  for (const inferred of getOpInferFromClient(resolvedOp)) {
    const goField = fieldName(inferred);
    lines.push(`\tbody.${goField} = ${clientFieldExpression(inferred)}`);
  }

  // Optional exposed body fields — copy through; omitempty drops nil/empty
  if (paramsType && bodyModel) {
    for (const field of bodyModel.fields) {
      if (hidden.has(field.name)) continue;
      if (field.required) continue;
      const goField = fieldName(field.name);
      lines.push(`\tbody.${goField} = params.${goField}`);
    }
  }

  // Determine query arg (visible query params from struct)
  const hasVisibleQueryParams = op.queryParams.filter((qp) => !hidden.has(qp.name)).length > 0;
  const queryArg = hasVisibleQueryParams ? 'params' : 'nil';

  // Make the request
  if (isDelete) {
    lines.push(
      `\t_, err := s.client.request(ctx, "${op.httpMethod.toUpperCase()}", ${pathExpr}, ${queryArg}, body, nil, opts)`,
    );
    lines.push('\treturn err');
  } else if (plan.responseModelName) {
    const respType = className(plan.responseModelName);
    if (isArrayResponse) {
      lines.push(`\tvar result []${respType}`);
      lines.push(
        `\t_, err := s.client.request(ctx, "${op.httpMethod.toUpperCase()}", ${pathExpr}, ${queryArg}, body, &result, opts)`,
      );
      lines.push('\tif err != nil {');
      lines.push('\t\treturn nil, err');
      lines.push('\t}');
      lines.push('\treturn result, nil');
    } else {
      lines.push(`\tvar result ${respType}`);
      lines.push(
        `\t_, err := s.client.request(ctx, "${op.httpMethod.toUpperCase()}", ${pathExpr}, ${queryArg}, body, &result, opts)`,
      );
      lines.push('\tif err != nil {');
      lines.push('\t\treturn nil, err');
      lines.push('\t}');
      lines.push('\treturn &result, nil');
    }
  } else {
    lines.push(
      `\t_, err := s.client.request(ctx, "${op.httpMethod.toUpperCase()}", ${pathExpr}, ${queryArg}, body, nil, opts)`,
    );
    lines.push('\treturn err');
  }
}

/** Format a Go value as a string for url.Values.Set(). */
function goLiteralForQuery(value: string | number | boolean): string {
  if (typeof value === 'string') return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  if (typeof value === 'boolean') return value ? `"true"` : `"false"`;
  return `fmt.Sprintf("%v", ${String(value)})`;
}

/** Format a Go expression to a string suitable for url.Values.Set(). */
function formatQueryValue(expr: string, type: import('@workos/oagen').TypeRef): string {
  if (type.kind === 'primitive') {
    switch (type.type) {
      case 'string':
        return expr;
      case 'integer':
      case 'number':
        return `fmt.Sprintf("%v", ${expr})`;
      case 'boolean':
        return `fmt.Sprintf("%v", ${expr})`;
      default:
        return `fmt.Sprintf("%v", ${expr})`;
    }
  }
  if (type.kind === 'array') {
    return `strings.Join(${expr}, ",")`;
  }
  return `fmt.Sprintf("%v", ${expr})`;
}

/**
 * Check if any operations with hidden params also have visible array query params.
 * strings.Join is only generated inside emitGetWithHiddenParams, so the import is
 * only needed when that code path is active AND uses array params.
 */
function needsStringsImport(operations: Operation[], resolvedLookup: Map<string, any>): boolean {
  for (const op of operations) {
    const resolved = lookupResolved(op, resolvedLookup);
    if (!resolved || !hasHiddenParams(resolved)) continue;
    if (op.httpMethod.toLowerCase() !== 'get') continue;
    const hidden = buildHiddenParams(resolved);
    for (const qp of op.queryParams) {
      if (hidden.has(qp.name)) continue;
      if (qp.type.kind === 'array') return true;
    }
  }
  return false;
}

/**
 * Check if any visible query params in operations use map types,
 * requiring bracket-encoded loop generation.
 */
function _hasMapQueryParams(op: Operation, hidden: Set<string>): boolean {
  return op.queryParams.some((qp) => !hidden.has(qp.name) && qp.type.kind === 'map');
}

function buildPathExpr(op: Operation): string {
  if (op.pathParams.length === 0) {
    return `"${op.path}"`;
  }
  // Build fmt.Sprintf expression (sorted by template order)
  let fmtStr = op.path;
  const args: string[] = [];
  for (const p of sortPathParamsByTemplateOrder(op)) {
    fmtStr = fmtStr.replace(`{${p.name}}`, '%s');
    args.push(lowerFirst(fieldName(p.name)));
  }
  return `fmt.Sprintf("${fmtStr}", ${args.join(', ')})`;
}

function bodyArgument(op: Operation): string {
  if (op.requestBody?.kind === 'model') {
    return 'params';
  }
  return 'params.Body';
}

function mapQueryParamType(name: string, type: import('@workos/oagen').TypeRef): string {
  if (name === 'limit' && type.kind === 'primitive' && (type.type === 'integer' || type.type === 'number')) {
    return 'int';
  }
  return mapTypeRef(type);
}

function makeOptional(goType: string): string {
  if (goType.startsWith('*') || goType.startsWith('[]') || goType.startsWith('map[')) {
    return goType;
  }
  return `*${goType}`;
}

/**
 * Resolve the iterator item type for pagination. If the item type is a list
 * wrapper model (which we skip in models.ts), unwrap it to the actual data item.
 */
function resolveIteratorItemType(itemType: import('@workos/oagen').TypeRef, ctx: EmitterContext): string {
  if (itemType.kind === 'model') {
    // Check if this is a list wrapper model -- if so, unwrap to its data array's item type
    const model = ctx.spec.models.find((m) => m.name === itemType.name);
    if (model && isListWrapperModel(model)) {
      const dataField = model.fields.find((f) => f.name === 'data');
      if (dataField && dataField.type.kind === 'array' && dataField.type.items.kind === 'model') {
        return className(dataField.type.items.name);
      }
    }
    return className(itemType.name);
  }
  return mapTypeRefValue(itemType);
}

/** Go reserved words that cannot be used as identifiers. */
const GO_RESERVED = new Set([
  'break',
  'case',
  'chan',
  'const',
  'continue',
  'default',
  'defer',
  'else',
  'fallthrough',
  'for',
  'func',
  'go',
  'goto',
  'if',
  'import',
  'interface',
  'map',
  'package',
  'range',
  'return',
  'select',
  'struct',
  'switch',
  'type',
  'var',
]);

function lowerFirst(s: string): string {
  if (!s) return s;
  const result = unexportedName(s);
  // Escape Go reserved words by appending an underscore
  if (GO_RESERVED.has(result)) return `${result}Param`;
  return result;
}

/** Simple lowercase-first for human-readable descriptions (not identifiers). */
function lowerFirstDesc(s: string): string {
  return lowerFirstForDoc(s);
}

function singularizePascal(name: string): string {
  if (name.endsWith('ies')) {
    return `${name.slice(0, -3)}y`;
  }
  if (name.endsWith('s') && !name.endsWith('ss')) {
    return name.slice(0, -1);
  }
  return name;
}

function serviceTypeName(name: string): string {
  return `${className(singularizePascal(name))}Service`;
}
