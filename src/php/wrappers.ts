import type { EmitterContext, ResolvedOperation, ResolvedWrapper } from '@workos/oagen';
import { toCamelCase } from '@workos/oagen';
import { className, fieldName } from './naming.js';

/**
 * Generate PHP wrapper method lines for split operations.
 *
 * Each wrapper is a typed convenience method that:
 * - Accepts only the exposed params (not the full union body)
 * - Injects constant defaults (e.g., grant_type)
 * - Reads inferred fields from client config (e.g., client_id)
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

  // Determine which fields are optional
  const optionalSet = new Set(wrapper.optionalParams);

  // Build required and optional params from exposed fields
  const requiredParams: string[] = [];
  const optionalParams: string[] = [];

  for (const paramName of wrapper.exposedParams) {
    const field = variantFields.find((f) => f.name === paramName);
    const phpName = fieldName(paramName);
    const phpType = field ? resolveSimpleType(field.type) : 'string';

    if (optionalSet.has(paramName) || !field?.required) {
      optionalParams.push(`?${phpType} $${phpName} = null`);
    } else {
      requiredParams.push(`${phpType} $${phpName}`);
    }
  }

  // Also add path params as required
  for (const p of op.pathParams) {
    const phpName = fieldName(p.name);
    const phpType = resolveSimpleType(p.type);
    requiredParams.unshift(`${phpType} $${phpName}`);
  }

  // Response type
  const responseType = wrapper.responseModelName ? className(wrapper.responseModelName) : 'array';

  // PHPDoc
  lines.push('    /**');
  lines.push(`     * ${formatMethodDescription(wrapper.name)}.`);
  lines.push('     *');
  for (const p of op.pathParams) {
    lines.push(`     * @param string $${fieldName(p.name)}`);
  }
  for (const paramName of wrapper.exposedParams) {
    const phpName = fieldName(paramName);
    const field = variantFields.find((f) => f.name === paramName);
    const phpType = field ? resolveSimpleType(field.type) : 'string';
    const isOptional = optionalSet.has(paramName) || !field?.required;
    lines.push(`     * @param ${isOptional ? phpType + '|null' : phpType} $${phpName}`);
  }
  lines.push(`     * @param \\${ctx.namespacePascal}\\RequestOptions|null $options`);
  if (wrapper.responseModelName) {
    lines.push(`     * @return ${className(wrapper.responseModelName)}`);
  } else {
    lines.push('     * @return array<string, mixed>');
  }
  lines.push('     *');
  lines.push(`     * @throws \\${ctx.namespacePascal}\\Exception\\ApiException`);
  lines.push('     */');

  // Method signature
  const allParams = [...requiredParams, ...optionalParams];
  lines.push(`    public function ${method}(`);
  for (const param of allParams) {
    lines.push(`        ${param},`);
  }
  lines.push(`        ?\\${ctx.namespacePascal}\\RequestOptions $options = null,`);
  lines.push(`    ): ${responseType}`);
  lines.push('    {');

  // Build body with defaults, inferred fields, and exposed params
  lines.push('        $body = array_filter([');

  // Constant defaults
  for (const [key, value] of Object.entries(wrapper.defaults)) {
    lines.push(`            '${key}' => ${phpLiteral(value)},`);
  }

  // Inferred fields from client config
  for (const field of wrapper.inferFromClient) {
    const expr = clientFieldExpression(field, ctx);
    lines.push(`            '${field}' => ${expr},`);
  }

  // Exposed params
  for (const paramName of wrapper.exposedParams) {
    const phpName = fieldName(paramName);
    lines.push(`            '${paramName}' => $${phpName},`);
  }

  lines.push('        ], fn ($v) => $v !== null);');

  // Build path expression
  let path = op.path.replace(/^\//, '');
  if (op.pathParams.length > 0) {
    for (const p of op.pathParams) {
      const phpVar = `$${fieldName(p.name)}`;
      path = path.replace(`{${p.name}}`, `{${phpVar}}`);
    }
  }
  const pathExpr = op.pathParams.length > 0 ? `"${path}"` : `'${path}'`;

  // Make the request
  lines.push('');
  lines.push(`        $response = $this->client->request(`);
  lines.push(`            method: '${op.httpMethod.toUpperCase()}',`);
  lines.push(`            path: ${pathExpr},`);
  lines.push('            query: null,');
  lines.push('            body: $body,');
  lines.push('            options: $options,');
  lines.push('        );');

  if (wrapper.responseModelName) {
    lines.push('');
    lines.push(
      `        return \\${ctx.namespacePascal}\\Resource\\${className(wrapper.responseModelName)}::fromArray($response);`,
    );
  } else {
    lines.push('');
    lines.push('        return $response;');
  }

  lines.push('    }');
}

/** Convert a value to a PHP literal. */
function phpLiteral(value: string | number | boolean): string {
  if (typeof value === 'string') return `'${value.replace(/'/g, "\\'")}'`;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/** Get the PHP expression for reading a client config field. */
function clientFieldExpression(field: string, ctx: EmitterContext): string {
  switch (field) {
    case 'client_id':
      return `\\${ctx.namespacePascal}::getClientId()`;
    case 'client_secret':
      return `\\${ctx.namespacePascal}::getApiKey()`;
    default:
      return `$this->client->get${toCamelCase(field).replace(/^./, (c) => c.toUpperCase())}()`;
  }
}

/** Resolve a TypeRef to a simple PHP type string. */
function resolveSimpleType(ref: any): string {
  if (ref.kind === 'primitive') {
    switch (ref.type) {
      case 'string':
        return 'string';
      case 'integer':
        return 'int';
      case 'number':
        return 'float';
      case 'boolean':
        return 'bool';
      default:
        return 'mixed';
    }
  }
  if (ref.kind === 'nullable') return resolveSimpleType(ref.inner);
  if (ref.kind === 'array') return 'array';
  if (ref.kind === 'model') return className(ref.name);
  if (ref.kind === 'enum') return className(ref.name);
  return 'mixed';
}

/** Format a snake_case method name into a human-readable description. */
function formatMethodDescription(name: string): string {
  return name
    .split('_')
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}
