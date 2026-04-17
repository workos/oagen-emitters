import type { EmitterContext, ResolvedOperation, ResolvedWrapper, TypeRef } from '@workos/oagen';
import { toCamelCase } from '@workos/oagen';
import { mapTypeRef, mapTypeRefForPHPDoc } from './type-map.js';
import { className, fieldName } from './naming.js';
import { phpDocComment } from './utils.js';
import { resolveWrapperParams } from '../shared/wrapper-utils.js';

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
  const wrapperParams = resolveWrapperParams(wrapper, ctx);

  lines.push('');

  // PHPDoc block
  const docParts: string[] = [];
  for (const { paramName, field, isOptional } of wrapperParams) {
    const docType = field ? mapTypeRefForPHPDoc(field.type) : 'string';
    const nullSuffix = isOptional && !docType.endsWith('|null') ? '|null' : '';
    docParts.push(`@param ${docType}${nullSuffix} $${fieldName(paramName)}`);
  }
  const op2 = resolvedOp.operation;
  const returnDocType = op2.response.kind === 'model' ? `\\${ns}\\Resource\\${className(op2.response.name)}` : 'mixed';
  docParts.push(`@return ${returnDocType}`);
  docParts.push(`@throws \\${ns}\\Exception\\WorkOSException`);
  lines.push(...phpDocComment(docParts.join('\n'), 4));

  lines.push(`    public function ${method}(`);

  // Build params: required first, then optional, to avoid PHP deprecation
  const requiredParams: string[] = [];
  const optionalParamLines: string[] = [];
  for (const { paramName, field, isOptional } of wrapperParams) {
    const phpName = fieldName(paramName);
    if (field) {
      const phpType = mapTypeRef(field.type);
      if (isOptional) {
        const nullableType = phpType.startsWith('?') ? phpType : `?${phpType}`;
        optionalParamLines.push(`        ${nullableType} $${phpName} = null,`);
      } else {
        requiredParams.push(`        ${phpType} $${phpName},`);
      }
    } else {
      if (isOptional) {
        optionalParamLines.push(`        ?string $${phpName} = null,`);
      } else {
        requiredParams.push(`        string $${phpName},`);
      }
    }
  }
  optionalParamLines.push(`        ?\\${ns}\\RequestOptions $options = null,`);
  for (const p of [...requiredParams, ...optionalParamLines]) {
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

  // Exposed params (extract enum values)
  for (const { paramName, field } of wrapperParams) {
    const phpName = fieldName(paramName);
    if (field && isEnumType(field.type)) {
      bodyEntries.push(`'${paramName}' => $${phpName}?->value`);
    } else {
      bodyEntries.push(`'${paramName}' => $${phpName}`);
    }
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

function isEnumType(ref: TypeRef): boolean {
  if (ref.kind === 'enum') return true;
  if (ref.kind === 'nullable') return isEnumType(ref.inner);
  return false;
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
