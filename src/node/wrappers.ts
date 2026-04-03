import type { EmitterContext, ResolvedOperation, ResolvedWrapper } from '@workos/oagen';
import { toCamelCase } from '@workos/oagen';
import { fieldName, resolveInterfaceName, wireInterfaceName } from './naming.js';
import { mapTypeRef } from './type-map.js';

/**
 * Generate TypeScript wrapper method lines for union split operations.
 *
 * Each wrapper is a typed convenience method that:
 * - Accepts only the exposed params (not the full union body)
 * - Injects constant defaults (e.g., grant_type)
 * - Reads inferred fields from client config (e.g., clientId)
 * - Delegates to the HTTP client with the constructed body
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
 * Used by the resource generator to ensure the correct imports are emitted.
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

  // Find the variant model to determine field types
  const variantModel = ctx.spec.models.find((m) => m.name === wrapper.targetVariant);
  const variantFields = variantModel?.fields ?? [];

  const optionalSet = new Set(wrapper.optionalParams);

  // Build parameter list: path params, then required exposed, then optional exposed
  const paramParts: string[] = [];

  for (const p of op.pathParams) {
    paramParts.push(`${fieldName(p.name)}: string`);
  }

  for (const paramName of wrapper.exposedParams) {
    const field = variantFields.find((f) => f.name === paramName);
    const tsName = fieldName(paramName);
    const tsType = field ? mapTypeRef(field.type) : 'string';
    if (!optionalSet.has(paramName) && field?.required) {
      paramParts.push(`${tsName}: ${tsType}`);
    }
  }

  for (const paramName of wrapper.exposedParams) {
    const field = variantFields.find((f) => f.name === paramName);
    const tsName = fieldName(paramName);
    const tsType = field ? mapTypeRef(field.type) : 'string';
    if (optionalSet.has(paramName) || !field?.required) {
      paramParts.push(`${tsName}?: ${tsType}`);
    }
  }

  // Response type
  const responseTypeName = wrapper.responseModelName ? resolveInterfaceName(wrapper.responseModelName, ctx) : null;
  const wireType = responseTypeName ? wireInterfaceName(responseTypeName) : null;
  const returnType = responseTypeName ?? 'void';

  // JSDoc
  lines.push(`  /** ${formatMethodDescription(wrapper.name)}. */`);

  // Method signature
  lines.push(`  async ${method}(${paramParts.join(', ')}): Promise<${returnType}> {`);

  // Build body with wire-format (snake_case) keys
  lines.push('    const body: Record<string, unknown> = {');

  // Constant defaults
  for (const [key, value] of Object.entries(wrapper.defaults)) {
    lines.push(`      ${key}: ${tsLiteral(value)},`);
  }

  // Inferred fields from client config
  for (const field of wrapper.inferFromClient) {
    const expr = clientFieldExpression(field);
    lines.push(`      ${field}: ${expr},`);
  }

  // Required exposed params (wire-format key, camelCase value)
  for (const paramName of wrapper.exposedParams) {
    const field = variantFields.find((f) => f.name === paramName);
    if (!optionalSet.has(paramName) && field?.required) {
      lines.push(`      ${paramName}: ${fieldName(paramName)},`);
    }
  }

  lines.push('    };');

  // Optional exposed params — add conditionally
  for (const paramName of wrapper.exposedParams) {
    const field = variantFields.find((f) => f.name === paramName);
    if (optionalSet.has(paramName) || !field?.required) {
      const tsName = fieldName(paramName);
      lines.push(`    if (${tsName} !== undefined) body.${paramName} = ${tsName};`);
    }
  }

  // Build path expression
  const pathStr = buildPathStr(op);

  // Make the request
  if (responseTypeName) {
    lines.push(`    const { data } = await this.workos.${op.httpMethod}<${wireType}>(${pathStr}, body);`);
    lines.push(`    return deserialize${responseTypeName}(data);`);
  } else {
    lines.push(`    await this.workos.${op.httpMethod}(${pathStr}, body);`);
  }

  lines.push('  }');
}

/** Build a path template string from an Operation. */
function buildPathStr(op: { path: string; pathParams: Array<{ name: string }> }): string {
  const interpolated = op.path.replace(/\{(\w+)\}/g, (_, p) => `\${${fieldName(p)}}`);
  return interpolated.includes('${') ? `\`${interpolated}\`` : `'${op.path}'`;
}

/** Convert a JS value to a TypeScript literal. */
function tsLiteral(value: string | number | boolean): string {
  if (typeof value === 'string') return `'${value.replace(/'/g, "\\'")}'`;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/** Get the TypeScript expression for reading a client config field. */
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

/** Format a snake_case method name into a human-readable description. */
function formatMethodDescription(name: string): string {
  return name
    .split('_')
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}
