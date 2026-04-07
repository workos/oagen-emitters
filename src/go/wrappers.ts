import type { EmitterContext, ResolvedOperation, ResolvedWrapper } from '@workos/oagen';
import {
  className as goClassName,
  fieldName as goFieldName,
  methodName as goMethodName,
  unexportedName,
} from './naming.js';
import { sortPathParamsByTemplateOrder } from './resources.js';
import { resolveWrapperParams, formatWrapperDescription, type ResolvedWrapperParam } from '../shared/wrapper-utils.js';
import { lowerFirstForDoc, fieldDocComment } from '../shared/naming-utils.js';

/**
 * Generate Go wrapper method lines for union split operations.
 *
 * Each wrapper is a typed convenience method that:
 * - Accepts only the exposed params (not the full union body)
 * - Injects constant defaults (e.g., grant_type)
 * - Reads inferred fields from client config (e.g., client_id)
 * - Delegates to the HTTP client with the constructed body
 */
export function generateWrapperMethods(
  serviceType: string,
  resolvedOp: ResolvedOperation,
  ctx: EmitterContext,
): string[] {
  if (!resolvedOp.wrappers || resolvedOp.wrappers.length === 0) return [];

  const lines: string[] = [];

  for (const wrapper of resolvedOp.wrappers) {
    const wrapperParams = resolveWrapperParams(wrapper, ctx);
    lines.push('');
    emitWrapperParamsStruct(lines, wrapper, wrapperParams);
    lines.push('');
    emitWrapperMethod(lines, serviceType, resolvedOp, wrapper, wrapperParams);
  }

  return lines;
}

function emitWrapperParamsStruct(
  lines: string[],
  wrapper: ResolvedWrapper,
  wrapperParams: ResolvedWrapperParam[],
): void {
  const structName = `${goMethodName(wrapper.name)}Params`;

  lines.push(`// ${structName} contains the parameters for ${goMethodName(wrapper.name)}.`);
  lines.push(`type ${structName} struct {`);

  for (const { paramName, field, isOptional } of wrapperParams) {
    const goField = goFieldName(paramName);
    const goType = field ? resolveSimpleGoType(field.type) : 'string';

    if (field?.description) {
      const fdLines = field.description.split('\n').filter((l: string) => l.trim());
      lines.push(`\t// ${fieldDocComment(goField, fdLines[0])}`);
      for (let i = 1; i < fdLines.length; i++) {
        lines.push(`\t// ${fdLines[i].trim()}`);
      }
    }
    if (isOptional) {
      const optType = goType.startsWith('*') || goType.startsWith('[]') ? goType : `*${goType}`;
      lines.push(`\t${goField} ${optType} \`json:"${paramName},omitempty"\``);
    } else {
      lines.push(`\t${goField} ${goType} \`json:"${paramName}"\``);
    }
  }

  lines.push('}');
}

function emitWrapperMethod(
  lines: string[],
  serviceType: string,
  resolvedOp: ResolvedOperation,
  wrapper: ResolvedWrapper,
  wrapperParams: ResolvedWrapperParam[],
): void {
  const op = resolvedOp.operation;
  const method = goMethodName(wrapper.name);
  const paramsStruct = `${method}Params`;

  // Return type
  const responseType = wrapper.responseModelName ? goClassName(wrapper.responseModelName) : null;

  // GoDoc
  lines.push(`// ${method} ${formatWrapperDescription(wrapper.name)}.`);

  // Signature
  const sigParams: string[] = ['ctx context.Context'];

  // Path params as positional args (sorted by template order)
  for (const p of sortPathParamsByTemplateOrder(op)) {
    sigParams.push(`${lowerFirstSafe(goFieldName(p.name))} ${resolveSimpleGoType(p.type)}`);
  }

  sigParams.push(`params *${paramsStruct}`);
  sigParams.push('opts ...RequestOption');

  if (responseType) {
    lines.push(`func (s *${serviceType}) ${method}(${sigParams.join(', ')}) (*${responseType}, error) {`);
  } else {
    lines.push(`func (s *${serviceType}) ${method}(${sigParams.join(', ')}) error {`);
  }

  // Build body map with defaults + exposed params
  lines.push('\tbody := map[string]interface{}{');

  // Constant defaults (e.g., grant_type)
  for (const [key, value] of Object.entries(wrapper.defaults)) {
    lines.push(`\t\t"${key}": ${goLiteral(value)},`);
  }

  // Required exposed params
  for (const { paramName, isOptional } of wrapperParams) {
    if (isOptional) continue;
    const goField = goFieldName(paramName);
    lines.push(`\t\t"${paramName}": params.${goField},`);
  }

  lines.push('\t}');

  // Inferred fields from client config
  for (const field of wrapper.inferFromClient) {
    const expr = clientFieldExpression(field);
    lines.push(`\tif ${expr} != "" {`);
    lines.push(`\t\tbody["${field}"] = ${expr}`);
    lines.push('\t}');
  }

  // Optional exposed params
  for (const { paramName, isOptional } of wrapperParams) {
    if (!isOptional) continue;
    const goField = goFieldName(paramName);
    lines.push(`\tif params.${goField} != nil {`);
    lines.push(`\t\tbody["${paramName}"] = *params.${goField}`);
    lines.push('\t}');
  }

  // Build path expression
  let pathExpr: string;
  if (op.pathParams.length > 0) {
    let fmtStr = op.path;
    const fmtArgs: string[] = [];
    for (const p of sortPathParamsByTemplateOrder(op)) {
      fmtStr = fmtStr.replace(`{${p.name}}`, '%s');
      fmtArgs.push(lowerFirstSafe(goFieldName(p.name)));
    }
    pathExpr = `fmt.Sprintf("${fmtStr}", ${fmtArgs.join(', ')})`;
  } else {
    pathExpr = `"${op.path}"`;
  }

  // Make the request
  if (responseType) {
    lines.push(`\tvar result ${responseType}`);
    lines.push(
      `\t_, err := s.client.request(ctx, "${op.httpMethod.toUpperCase()}", ${pathExpr}, nil, body, &result, opts)`,
    );
    lines.push('\tif err != nil {');
    lines.push('\t\treturn nil, err');
    lines.push('\t}');
    lines.push('\treturn &result, nil');
  } else {
    lines.push(
      `\t_, err := s.client.request(ctx, "${op.httpMethod.toUpperCase()}", ${pathExpr}, nil, body, nil, opts)`,
    );
    lines.push('\treturn err');
  }

  lines.push('}');
}

/** Convert a value to a Go literal. */
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
      return `s.client.${lowerFirstSafe(goFieldName(field))}`;
  }
}

/** Resolve a TypeRef to a simple Go type string. */
function resolveSimpleGoType(ref: any): string {
  if (ref.kind === 'primitive') {
    switch (ref.type) {
      case 'string':
        return 'string';
      case 'integer':
        return 'int';
      case 'number':
        return 'float64';
      case 'boolean':
        return 'bool';
      default:
        return 'interface{}';
    }
  }
  if (ref.kind === 'nullable') return `*${resolveSimpleGoType(ref.inner)}`;
  if (ref.kind === 'array') return `[]${resolveSimpleGoType(ref.items)}`;
  if (ref.kind === 'model') return `*${goClassName(ref.name)}`;
  if (ref.kind === 'enum') return goClassName(ref.name);
  if (ref.kind === 'union') {
    // For oneOf with a single non-null variant, use that variant's type
    const nonNull = ref.variants.filter((v: any) => v.kind !== 'literal' || v.value !== null);
    if (nonNull.length === 1) return resolveSimpleGoType(nonNull[0]);
    return 'interface{}';
  }
  return 'interface{}';
}

/** Go reserved words set. */
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

function lowerFirstSafe(s: string): string {
  if (!s) return s;
  const result = unexportedName(s);
  if (GO_RESERVED.has(result)) return `${result}Param`;
  return result;
}

function _lowerFirstField(s: string): string {
  return lowerFirstForDoc(s);
}
