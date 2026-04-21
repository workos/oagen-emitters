import type { EmitterContext, ResolvedOperation, ResolvedWrapper } from '@workos/oagen';
import {
  className as goClassName,
  fieldName as goFieldName,
  methodName as goMethodName,
  unexportedName,
} from './naming.js';
import { sortPathParamsByTemplateOrder, paramsStructName } from './resources.js';
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
  mountName: string,
  resolvedOp: ResolvedOperation,
  ctx: EmitterContext,
): string[] {
  if (!resolvedOp.wrappers || resolvedOp.wrappers.length === 0) return [];

  const lines: string[] = [];

  for (const wrapper of resolvedOp.wrappers) {
    const wrapperParams = resolveWrapperParams(wrapper, ctx);
    lines.push('');
    emitWrapperParamsStruct(lines, mountName, wrapper, wrapperParams);
    lines.push('');
    emitWrapperBodyStruct(lines, wrapper, wrapperParams);
    lines.push('');
    emitWrapperMethod(lines, serviceType, mountName, resolvedOp, wrapper, wrapperParams);
  }

  return lines;
}

/** Unexported struct name used as the typed JSON body for a wrapper method. */
function wrapperBodyStructName(wrapper: ResolvedWrapper): string {
  return `${unexportedName(goMethodName(wrapper.name))}Body`;
}

/**
 * Emit the private body struct used to serialize the JSON request for a
 * wrapper method. Fields come from: constant defaults, required exposed
 * params, client-inferred fields, and optional exposed params (in that
 * order to match how bodies are constructed at call sites).
 */
function emitWrapperBodyStruct(lines: string[], wrapper: ResolvedWrapper, wrapperParams: ResolvedWrapperParam[]): void {
  const structName = wrapperBodyStructName(wrapper);
  lines.push(`// ${structName} is the JSON request body for ${goMethodName(wrapper.name)}.`);
  lines.push(`type ${structName} struct {`);

  // Constant defaults (always sent — no omitempty so the wire format is deterministic)
  for (const [key, value] of Object.entries(wrapper.defaults)) {
    const goField = goFieldName(key);
    const goType = typeof value === 'boolean' ? 'bool' : typeof value === 'number' ? 'int' : 'string';
    lines.push(`\t${goField} ${goType} \`json:"${key}"\``);
  }

  // Required exposed params
  for (const { paramName, field, isOptional } of wrapperParams) {
    if (isOptional) continue;
    const goField = goFieldName(paramName);
    const goType = field ? resolveSimpleGoType(field.type) : 'string';
    lines.push(`\t${goField} ${goType} \`json:"${paramName}"\``);
  }

  // Inferred fields (from client config) — omit when empty
  for (const inferred of wrapper.inferFromClient) {
    const goField = goFieldName(inferred);
    lines.push(`\t${goField} string \`json:"${inferred},omitempty"\``);
  }

  // Optional exposed params
  for (const { paramName, field, isOptional } of wrapperParams) {
    if (!isOptional) continue;
    const goField = goFieldName(paramName);
    const baseType = field ? resolveSimpleGoType(field.type) : 'string';
    const optType = baseType.startsWith('*') || baseType.startsWith('[]') ? baseType : `*${baseType}`;
    lines.push(`\t${goField} ${optType} \`json:"${paramName},omitempty"\``);
  }

  lines.push('}');
}

function emitWrapperParamsStruct(
  lines: string[],
  mountName: string,
  wrapper: ResolvedWrapper,
  wrapperParams: ResolvedWrapperParam[],
): void {
  const structName = paramsStructName(mountName, goMethodName(wrapper.name));

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
  mountName: string,
  resolvedOp: ResolvedOperation,
  wrapper: ResolvedWrapper,
  wrapperParams: ResolvedWrapperParam[],
): void {
  const op = resolvedOp.operation;
  const method = goMethodName(wrapper.name);
  const paramsStruct = paramsStructName(mountName, method);

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

  // Build typed body struct — defaults + required params set at literal,
  // inferred + optional fields assigned after (conditional on presence).
  const bodyType = wrapperBodyStructName(wrapper);
  lines.push(`\tbody := ${bodyType}{`);

  // Constant defaults (e.g., grant_type)
  for (const [key, value] of Object.entries(wrapper.defaults)) {
    lines.push(`\t\t${goFieldName(key)}: ${goLiteral(value)},`);
  }

  // Required exposed params
  for (const { paramName, isOptional } of wrapperParams) {
    if (isOptional) continue;
    const goField = goFieldName(paramName);
    lines.push(`\t\t${goField}: params.${goField},`);
  }

  lines.push('\t}');

  // Inferred fields from client config — omitempty handles the unset case
  for (const inferred of wrapper.inferFromClient) {
    const goField = goFieldName(inferred);
    lines.push(`\tbody.${goField} = ${clientFieldExpression(inferred)}`);
  }

  // Optional exposed params copy through as pointers — encoding/json +
  // omitempty will drop nil fields on the wire.
  for (const { paramName, isOptional } of wrapperParams) {
    if (!isOptional) continue;
    const goField = goFieldName(paramName);
    lines.push(`\tbody.${goField} = params.${goField}`);
  }

  // Build path expression
  let pathExpr: string;
  if (op.pathParams.length > 0) {
    let fmtStr = op.path;
    const fmtArgs: string[] = [];
    for (const p of sortPathParamsByTemplateOrder(op)) {
      fmtStr = fmtStr.replace(`{${p.name}}`, '%s');
      fmtArgs.push(`url.PathEscape(string(${lowerFirstSafe(goFieldName(p.name))}))`);
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
  if (ref.kind === 'nullable') {
    const inner = resolveSimpleGoType(ref.inner);
    // Slices, maps, and pointer types don't get pointer-wrapped (mirrors type-map.ts).
    if (inner.startsWith('*') || inner.startsWith('[]') || inner.startsWith('map[')) return inner;
    return `*${inner}`;
  }
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
