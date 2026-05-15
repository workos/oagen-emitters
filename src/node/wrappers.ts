import type { EmitterContext, ResolvedOperation, ResolvedWrapper } from '@workos/oagen';
import { toCamelCase } from '@workos/oagen';
import { fieldName, resolveInterfaceName, wireInterfaceName } from './naming.js';
import { mapTypeRef } from './type-map.js';
import { resolveWrapperParams, formatWrapperDescription } from '../shared/wrapper-utils.js';
import { buildNodePathExpression } from './path-expression.js';

/**
 * Generate TypeScript wrapper method lines for union split operations.
 */
export function generateWrapperMethods(resolvedOp: ResolvedOperation, ctx: EmitterContext): string[] {
  if (!resolvedOp.wrappers || resolvedOp.wrappers.length === 0) return [];

  const lines: string[] = [];

  for (const wrapper of resolvedOp.wrappers) {
    lines.push('');
    emitWrapperMethod(lines, resolvedOp, wrapper, ctx);
  }

  return lines;
}

/**
 * Collect response model names referenced by wrappers on a resolved operation.
 */
export function collectWrapperResponseModels(resolvedOp: ResolvedOperation): Set<string> {
  const models = new Set<string>();
  for (const wrapper of resolvedOp.wrappers ?? []) {
    if (wrapper.responseModelName) {
      models.add(wrapper.responseModelName);
    }
  }
  return models;
}

function emitWrapperMethod(
  lines: string[],
  resolvedOp: ResolvedOperation,
  wrapper: ResolvedWrapper,
  ctx: EmitterContext,
): void {
  const op = resolvedOp.operation;
  const method = toCamelCase(wrapper.name);
  const wrapperParams = resolveWrapperParams(wrapper, ctx);

  const paramParts: string[] = [];

  for (const p of op.pathParams) {
    paramParts.push(`${fieldName(p.name)}: string`);
  }

  for (const { paramName, field, isOptional } of wrapperParams) {
    if (isOptional) continue;
    const tsName = fieldName(paramName);
    const tsType = field ? mapTypeRef(field.type) : 'string';
    paramParts.push(`${tsName}: ${tsType}`);
  }

  for (const { paramName, field, isOptional } of wrapperParams) {
    if (!isOptional) continue;
    const tsName = fieldName(paramName);
    const tsType = field ? mapTypeRef(field.type) : 'string';
    paramParts.push(`${tsName}?: ${tsType}`);
  }

  const responseTypeName = wrapper.responseModelName ? resolveInterfaceName(wrapper.responseModelName, ctx) : null;
  const wireType = responseTypeName ? wireInterfaceName(responseTypeName) : null;
  const returnType = responseTypeName ?? 'void';

  // JSDoc
  const docParts: string[] = [];
  docParts.push(formatWrapperDescription(wrapper.name) + '.');

  for (const p of op.pathParams) {
    if (p.description) {
      docParts.push(`@param ${fieldName(p.name)} - ${p.description}`);
    }
  }

  for (const { paramName, field } of wrapperParams) {
    const tsName = fieldName(paramName);
    if (field?.description) {
      docParts.push(`@param ${tsName} - ${field.description}`);
    }
  }

  if (responseTypeName) {
    docParts.push(`@returns {Promise<${returnType}>}`);
  }

  if (docParts.length === 1) {
    lines.push(`  /** ${docParts[0]} */`);
  } else {
    lines.push('  /**');
    for (const part of docParts) {
      for (const line of part.split('\n')) {
        lines.push(line === '' ? '   *' : `   * ${line}`);
      }
    }
    lines.push('   */');
  }

  lines.push(`  async ${method}(${paramParts.join(', ')}): Promise<${returnType}> {`);

  lines.push('    const body: Record<string, unknown> = {');

  for (const [key, value] of Object.entries(wrapper.defaults)) {
    lines.push(`      ${key}: ${tsLiteral(value)},`);
  }

  for (const field of wrapper.inferFromClient) {
    const expr = clientFieldExpression(field);
    lines.push(`      ${field}: ${expr},`);
  }

  for (const { paramName, isOptional } of wrapperParams) {
    if (isOptional) continue;
    lines.push(`      ${paramName}: ${fieldName(paramName)},`);
  }

  lines.push('    };');

  for (const { paramName, isOptional } of wrapperParams) {
    if (!isOptional) continue;
    const tsName = fieldName(paramName);
    lines.push(`    if (${tsName} !== undefined) body.${paramName} = ${tsName};`);
  }

  const pathStr = buildPathStr(op);

  if (responseTypeName) {
    lines.push(`    const { data } = await this.workos.${op.httpMethod}<${wireType}>(${pathStr}, body);`);
    lines.push(`    return deserialize${responseTypeName}(data);`);
  } else {
    lines.push(`    await this.workos.${op.httpMethod}(${pathStr}, body);`);
  }

  lines.push('  }');
}

function buildPathStr(op: { path: string; pathParams: Array<{ name: string }> }): string {
  return buildNodePathExpression(op.path);
}

function tsLiteral(value: string | number | boolean): string {
  if (typeof value === 'string') return `'${value.replace(/'/g, "\\'")}'`;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function clientFieldExpression(field: string): string {
  switch (field) {
    case 'client_id':
      return 'this.workos.options.clientId';
    case 'client_secret':
      return 'this.workos.key';
    default:
      return `this.workos.${toCamelCase(field)}`;
  }
}
