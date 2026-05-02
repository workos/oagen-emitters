import type { EmitterContext, ResolvedOperation, ResolvedWrapper } from '@workos/oagen';
import { toSnakeCase } from '@workos/oagen';
import { className, fieldName } from './naming.js';
import { resolveWrapperParams, formatWrapperDescription } from '../shared/wrapper-utils.js';
import { buildPythonPathExpression } from './path-expression.js';

/**
 * Generate Python wrapper method lines for split operations.
 *
 * Each wrapper is a typed convenience method that:
 * - Accepts only the exposed params (not the full union body)
 * - Injects constant defaults (e.g., grant_type)
 * - Reads inferred fields from client config (e.g., client_id)
 * - Delegates to the HTTP client with the constructed body
 *
 * Generates both sync and async versions.
 */
export function generateSyncWrapperMethods(resolvedOp: ResolvedOperation, ctx: EmitterContext): string[] {
  return generateWrapperMethodsInner(resolvedOp, ctx, false);
}

export function generateAsyncWrapperMethods(resolvedOp: ResolvedOperation, ctx: EmitterContext): string[] {
  return generateWrapperMethodsInner(resolvedOp, ctx, true);
}

function generateWrapperMethodsInner(resolvedOp: ResolvedOperation, ctx: EmitterContext, isAsync: boolean): string[] {
  if (!resolvedOp.wrappers || resolvedOp.wrappers.length === 0) return [];

  const lines: string[] = [];

  for (const wrapper of resolvedOp.wrappers) {
    lines.push('');
    emitWrapperMethod(lines, resolvedOp, wrapper, ctx, isAsync);
  }

  return lines;
}

function emitWrapperMethod(
  lines: string[],
  resolvedOp: ResolvedOperation,
  wrapper: ResolvedWrapper,
  ctx: EmitterContext,
  isAsync: boolean,
): void {
  const op = resolvedOp.operation;
  const method = wrapper.name; // already snake_case
  const wrapperParams = resolveWrapperParams(wrapper, ctx);

  // Build signature
  const defKeyword = isAsync ? 'async def' : 'def';
  lines.push(`    ${defKeyword} ${method}(`);
  lines.push('        self,');

  // Path params as positional args
  for (const param of op.pathParams) {
    const paramName = fieldName(param.name);
    const paramType = resolveSimpleType(param.type);
    lines.push(`        ${paramName}: ${paramType},`);
  }

  lines.push('        *,');

  // Exposed params as keyword args
  for (const { paramName, field, isOptional } of wrapperParams) {
    const pyName = fieldName(paramName);
    const pyType = field ? resolveSimpleType(field.type) : 'str';

    if (isOptional) {
      lines.push(`        ${pyName}: Optional[${pyType}] = None,`);
    } else {
      lines.push(`        ${pyName}: ${pyType},`);
    }
  }

  lines.push('        request_options: Optional[RequestOptions] = None,');

  // Return type
  const responseType = wrapper.responseModelName ? className(wrapper.responseModelName) : 'None';

  lines.push(`    ) -> ${responseType}:`);

  // Docstring
  lines.push(`        """${formatWrapperDescription(wrapper.name)}."""`);

  // Build body dict
  lines.push('        body: Dict[str, Any] = {');

  // Constant defaults
  for (const [key, value] of Object.entries(wrapper.defaults)) {
    lines.push(`            "${key}": ${pythonLiteral(value)},`);
  }

  // Exposed params (required ones go directly)
  for (const { paramName, isOptional } of wrapperParams) {
    if (isOptional) continue;
    const pyName = fieldName(paramName);
    lines.push(`            "${paramName}": ${pyName},`);
  }

  lines.push('        }');

  // Inferred fields from client config
  for (const field of wrapper.inferFromClient) {
    const expr = clientFieldExpression(field);
    lines.push(`        if ${expr} is not None:`);
    lines.push(`            body["${field}"] = ${expr}`);
  }

  // Optional exposed params
  for (const { paramName, isOptional } of wrapperParams) {
    if (!isOptional) continue;
    const pyName = fieldName(paramName);
    lines.push(`        if ${pyName} is not None:`);
    lines.push(`            body["${paramName}"] = ${pyName}`);
  }

  // Build path expression
  const pathExpr = buildPythonPathExpression(op.path);

  // Make the request
  const awaitPrefix = isAsync ? 'await ' : '';
  lines.push('');

  if (wrapper.responseModelName) {
    lines.push(`        return ${awaitPrefix}self._client.request(`);
    lines.push(`            method="${op.httpMethod.toUpperCase()}",`);
    lines.push(`            path=${pathExpr},`);
    lines.push('            body=body,');
    lines.push(`            model=${className(wrapper.responseModelName)},`);
    lines.push('            request_options=request_options,');
    lines.push('        )');
  } else {
    lines.push(`        ${awaitPrefix}self._client.request(`);
    lines.push(`            method="${op.httpMethod.toUpperCase()}",`);
    lines.push(`            path=${pathExpr},`);
    lines.push('            body=body,');
    lines.push('            request_options=request_options,');
    lines.push('        )');
  }
}

/** Convert a value to a Python literal. */
export function pythonLiteral(value: string | number | boolean): string {
  if (typeof value === 'string') return `"${value.replace(/"/g, '\\"')}"`;
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return String(value);
}

/** Get the Python expression for reading a client config field. */
export function clientFieldExpression(field: string): string {
  switch (field) {
    case 'client_id':
      return 'self._client.client_id';
    case 'client_secret':
      return 'self._client._api_key';
    default:
      return `self._client.${toSnakeCase(field)}`;
  }
}

/** Resolve a TypeRef to a simple Python type string. */
function resolveSimpleType(ref: any): string {
  if (ref.kind === 'primitive') {
    switch (ref.type) {
      case 'string':
        return 'str';
      case 'integer':
        return 'int';
      case 'number':
        return 'float';
      case 'boolean':
        return 'bool';
      default:
        return 'Any';
    }
  }
  if (ref.kind === 'nullable') return resolveSimpleType(ref.inner);
  if (ref.kind === 'array') return `List[${resolveSimpleType(ref.items)}]`;
  if (ref.kind === 'model') return className(ref.name);
  if (ref.kind === 'enum') return className(ref.name);
  return 'Any';
}
