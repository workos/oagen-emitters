import type { EmitterContext, ResolvedOperation, ResolvedWrapper } from '@workos/oagen';
import { toCamelCase } from '@workos/oagen';
import { mapTypeRef } from './type-map.js';
import { className, fieldName } from './naming.js';

/**
 * Generate PHP wrapper methods for split union operations.
 */
export function generateWrapperMethods(resolvedOp: ResolvedOperation, ctx: EmitterContext): string[] {
  const lines: string[] = [];
  for (const wrapper of resolvedOp.wrappers ?? []) {
    emitWrapperMethod(lines, resolvedOp, wrapper, ctx);
  }
  return lines;
}

function emitWrapperMethod(
  lines: string[],
  resolvedOp: ResolvedOperation,
  wrapper: ResolvedWrapper,
  ctx: EmitterContext,
): void {
  const method = toCamelCase(wrapper.name);
  const ns = ctx.namespacePascal;

  lines.push('');
  lines.push(`    public function ${method}(`);

  // Exposed params
  const params: string[] = [];
  for (const paramName of wrapper.exposedParams) {
    const field = findFieldInVariant(wrapper, paramName, resolvedOp);
    if (field) {
      const phpType = mapTypeRef(field.type);
      const phpName = fieldName(paramName);
      if (field.required) {
        params.push(`        ${phpType} $${phpName},`);
      } else {
        params.push(`        ?${phpType} $${phpName} = null,`);
      }
    } else {
      params.push(`        mixed $${fieldName(paramName)} = null,`);
    }
  }
  params.push(`        ?\\${ns}\\RequestOptions $options = null,`);
  for (const p of params) {
    lines.push(p);
  }

  // Return type
  const op = resolvedOp.operation;
  const responseType = op.response.kind === 'model' ? `\\${ns}\\Resource\\${className(op.response.name)}` : 'mixed';
  lines.push(`    ): ${responseType} {`);

  // Build body using array_filter for consistency
  const bodyEntries: string[] = [];

  // Defaults (always included)
  if (wrapper.defaults) {
    for (const [key, value] of Object.entries(wrapper.defaults)) {
      bodyEntries.push(`'${key}' => ${phpLiteral(value)}`);
    }
  }

  // Exposed params
  for (const paramName of wrapper.exposedParams) {
    bodyEntries.push(`'${paramName}' => $${fieldName(paramName)}`);
  }

  lines.push('        $body = array_filter([');
  for (const entry of bodyEntries) {
    lines.push(`            ${entry},`);
  }
  lines.push('        ], fn ($v) => $v !== null);');

  // inferFromClient fields need special handling (conditional injection)
  for (const clientField of wrapper.inferFromClient ?? []) {
    const clientExpr = clientFieldExpression(clientField);
    lines.push(`        $body['${clientField}'] = ${clientExpr};`);
  }

  // Delegate to HTTP client
  const httpMethod = op.httpMethod.toUpperCase();
  let path = op.path.startsWith('/') ? op.path.slice(1) : op.path;
  const hasInterpolation = /\{[^}]+\}/.test(path);
  path = path.replace(/\{([^}]+)\}/g, (_match, param) => `{$${fieldName(param)}}`);
  const pathQuote = hasInterpolation ? '"' : "'";

  lines.push('');
  lines.push('        $response = $this->client->request(');
  lines.push(`            method: '${httpMethod}',`);
  lines.push(`            path: ${pathQuote}${path}${pathQuote},`);
  lines.push('            body: $body,');
  lines.push('            options: $options,');
  lines.push('        );');

  if (op.response.kind === 'model') {
    lines.push(`        return ${className(op.response.name)}::fromArray($response);`);
  } else {
    lines.push('        return $response;');
  }

  lines.push('    }');
}

function findFieldInVariant(
  _wrapper: ResolvedWrapper,
  _paramName: string,
  _resolvedOp: ResolvedOperation,
): { type: import('@workos/oagen').TypeRef; required: boolean } | null {
  // For wrappers, exposed params are generally optional
  return { type: { kind: 'primitive', type: 'string' }, required: false };
}

function phpLiteral(value: unknown): string {
  if (typeof value === 'string') return `'${value}'`;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return 'null';
}

function clientFieldExpression(field: string): string {
  // Map inferFromClient fields to the actual client/config accessors
  switch (field) {
    case 'client_id':
      return '$this->client->requireClientId()';
    case 'client_secret':
      return '$this->client->requireApiKey()';
    default:
      return `$this->client->${toCamelCase(field)}`;
  }
}
