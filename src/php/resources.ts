import type { Service, Operation, OperationPlan, EmitterContext, GeneratedFile, TypeRef } from '@workos/oagen';
import { planOperation } from '@workos/oagen';
import { mapTypeRef, mapTypeRefDoc } from './type-map.js';
import { className, fieldName, resolveMethodName, resolveClassName } from './naming.js';

/**
 * Resolve the resource class name for a service.
 */
export function resolveResourceClassName(service: Service, ctx: EmitterContext): string {
  return resolveClassName(service, ctx);
}

/**
 * Generate PHP resource classes from IR Service definitions.
 */
export function generateResources(services: Service[], ctx: EmitterContext): GeneratedFile[] {
  if (services.length === 0) return [];

  const files: GeneratedFile[] = [];

  for (const service of services) {
    if (service.operations.length === 0) continue;

    const resourceName = resolveResourceClassName(service, ctx);
    const lines: string[] = [];

    lines.push('<?php');
    lines.push('');
    lines.push(`namespace ${ctx.namespacePascal}\\Resources;`);
    lines.push('');

    // Collect imports
    const imports = collectResourceImports(service, ctx);
    for (const imp of imports) {
      lines.push(`use ${imp};`);
    }
    if (imports.length > 0) lines.push('');

    lines.push(`class ${resourceName}`);
    lines.push('{');
    lines.push(`    public function __construct(`);
    lines.push(`        private readonly \\${ctx.namespacePascal}\\HttpClient $client,`);
    lines.push('    ) {}');

    // Generate methods for each operation
    for (const op of service.operations) {
      const plan = planOperation(op);
      const method = resolveMethodName(op, service, ctx);

      lines.push('');
      emitMethod(lines, op, plan, method, service, ctx);
    }

    lines.push('}');

    files.push({
      path: `lib/Resources/${resourceName}.php`,
      content: lines.join('\n'),
      integrateTarget: true,
      overwriteExisting: true,
    });
  }

  return files;
}

function emitMethod(
  lines: string[],
  op: Operation,
  plan: OperationPlan,
  method: string,
  service: Service,
  ctx: EmitterContext,
): void {
  const isPaginated = plan.isPaginated;
  const isDelete = plan.isDelete;

  // PHPDoc
  lines.push('    /**');
  if (op.description) {
    lines.push(`     * ${op.description}`);
    lines.push('     *');
  }
  // Parameter docs
  for (const p of op.pathParams) {
    lines.push(`     * @param ${mapTypeRefDoc(p.type)} $${fieldName(p.name)}`);
  }
  if (plan.hasBody && op.requestBody) {
    emitBodyParamDocs(lines, op, ctx);
  }
  if (plan.hasQueryParams && !isPaginated) {
    for (const p of op.queryParams) {
      const phpName = fieldName(p.name);
      lines.push(`     * @param ${mapTypeRefDoc(p.type)}|null $${phpName}`);
    }
  }
  if (isPaginated) {
    lines.push('     * @param int|null $limit');
    lines.push('     * @param string|null $after');
    lines.push('     * @param string|null $before');
  }

  // Return type doc
  if (isPaginated) {
    const itemType = op.pagination?.itemType;
    const itemName = itemType?.kind === 'model' ? className(itemType.name) : 'mixed';
    lines.push(`     * @return \\${ctx.namespacePascal}\\PaginatedResponse<${itemName}>`);
  } else if (isDelete) {
    lines.push('     * @return void');
  } else if (plan.responseModelName) {
    lines.push(`     * @return ${className(plan.responseModelName)}`);
  }
  lines.push('     */');

  // Method signature
  const returnType = isDelete
    ? 'void'
    : isPaginated
      ? `\\${ctx.namespacePascal}\\PaginatedResponse`
      : plan.responseModelName
        ? className(plan.responseModelName)
        : 'array';

  const params = buildMethodParams(op, plan, ctx);
  lines.push(`    public function ${method}(`);
  for (let i = 0; i < params.length; i++) {
    lines.push(`        ${params[i]}${i < params.length - 1 ? ',' : ','}`);
  }
  // Always add options as last param
  lines.push(`        ?\\${ctx.namespacePascal}\\RequestOptions $options = null,`);
  lines.push(`    ): ${returnType}`);
  lines.push('    {');

  // Build path with interpolation
  const pathExpr = buildPathExpression(op);

  // Build request body
  if (plan.hasBody && op.requestBody) {
    emitBodyBuilder(lines, op, ctx);
  }

  // Build query params
  if ((plan.hasQueryParams && !isPaginated) || isPaginated) {
    emitQueryBuilder(lines, op, plan, isPaginated);
  }

  // Make the request
  const httpMethod = `'${op.httpMethod.toUpperCase()}'`;
  const queryArg = plan.hasQueryParams || isPaginated ? '$query' : 'null';
  const bodyArg = plan.hasBody ? '$body' : 'null';

  if (isDelete) {
    lines.push(`        $this->client->request(`);
    lines.push(`            method: ${httpMethod},`);
    lines.push(`            path: ${pathExpr},`);
    lines.push(`            query: ${queryArg},`);
    lines.push(`            body: ${bodyArg},`);
    lines.push(`            options: $options,`);
    lines.push('        );');
  } else if (isPaginated) {
    const itemType = op.pagination?.itemType;
    const itemClassName =
      itemType?.kind === 'model' ? `\\${ctx.namespacePascal}\\Models\\${className(itemType.name)}` : null;
    const modelClass = itemClassName ? `${itemClassName}::class` : 'null';

    lines.push(`        $response = $this->client->request(`);
    lines.push(`            method: ${httpMethod},`);
    lines.push(`            path: ${pathExpr},`);
    lines.push(`            query: ${queryArg},`);
    lines.push(`            body: ${bodyArg},`);
    lines.push(`            options: $options,`);
    lines.push('        );');
    lines.push('');
    lines.push(`        return \\${ctx.namespacePascal}\\PaginatedResponse::fromArray(`);
    lines.push(`            $response,`);
    lines.push(`            ${modelClass},`);

    // Create a fetch callback for auto-pagination
    lines.push(`            fn (array $params) => $this->${method}(`);
    if (op.pathParams.length > 0) {
      for (const p of op.pathParams) {
        lines.push(`                ${fieldName(p.name)}: $${fieldName(p.name)},`);
      }
    }
    lines.push(`                limit: $params['limit'] ?? $limit,`);
    lines.push(`                after: $params['after'] ?? null,`);
    lines.push('                options: $options,');
    lines.push('            ),');
    lines.push('        );');
  } else {
    lines.push(`        $response = $this->client->request(`);
    lines.push(`            method: ${httpMethod},`);
    lines.push(`            path: ${pathExpr},`);
    lines.push(`            query: ${queryArg},`);
    lines.push(`            body: ${bodyArg},`);
    lines.push(`            options: $options,`);
    lines.push('        );');
    lines.push('');
    if (plan.responseModelName) {
      lines.push(
        `        return \\${ctx.namespacePascal}\\Models\\${className(plan.responseModelName)}::fromArray($response);`,
      );
    } else {
      lines.push('        return $response;');
    }
  }

  lines.push('    }');
}

function buildMethodParams(op: Operation, plan: OperationPlan, ctx: EmitterContext): string[] {
  const params: string[] = [];

  // Path params
  for (const p of op.pathParams) {
    const phpType = mapTypeRef(p.type);
    params.push(`${phpType} $${fieldName(p.name)}`);
  }

  // Request body fields
  if (plan.hasBody && op.requestBody) {
    const bodyModel =
      op.requestBody.kind === 'model' ? ctx.spec.models.find((m) => m.name === (op.requestBody as any).name) : null;
    if (bodyModel) {
      const reqFields = bodyModel.fields.filter((f) => f.required);
      const optFields = bodyModel.fields.filter((f) => !f.required);
      for (const f of reqFields) {
        const phpType = mapTypeRef(f.type);
        params.push(`${phpType} $${fieldName(f.name)}`);
      }
      for (const f of optFields) {
        const innerType = f.type.kind === 'nullable' ? mapTypeRef(f.type.inner) : mapTypeRef(f.type);
        params.push(`?${innerType} $${fieldName(f.name)} = null`);
      }
    } else {
      params.push('?array $body = null');
    }
  }

  // Query params for non-paginated methods
  if (plan.hasQueryParams && !plan.isPaginated) {
    for (const p of op.queryParams) {
      const phpType = mapTypeRef(p.type);
      if (p.required) {
        params.push(`${phpType} $${fieldName(p.name)}`);
      } else {
        params.push(`?${phpType} $${fieldName(p.name)} = null`);
      }
    }
  }

  // Pagination params
  if (plan.isPaginated) {
    params.push('?int $limit = null');
    params.push('?string $after = null');
    params.push('?string $before = null');
  }

  // Idempotency key
  if (op.injectIdempotencyKey) {
    params.push('?string $idempotencyKey = null');
  }

  return params;
}

function buildPathExpression(op: Operation): string {
  let path = op.path.replace(/^\//, '');
  if (op.pathParams.length === 0) {
    return `'${path}'`;
  }
  // Replace {paramName} with PHP string interpolation
  for (const p of op.pathParams) {
    const phpVar = `$${fieldName(p.name)}`;
    path = path.replace(`{${p.name}}`, `{${phpVar}}`);
  }
  return `"${path}"`;
}

function emitBodyBuilder(lines: string[], op: Operation, ctx: EmitterContext): void {
  const bodyModel =
    op.requestBody?.kind === 'model' ? ctx.spec.models.find((m) => m.name === (op.requestBody as any).name) : null;

  if (bodyModel) {
    lines.push('        $body = array_filter([');
    for (const f of bodyModel.fields) {
      const phpProp = fieldName(f.name);
      const wire = f.name;
      lines.push(`            '${wire}' => $${phpProp} instanceof \\BackedEnum ? $${phpProp}->value : $${phpProp},`);
    }
    lines.push('        ], fn (\\$v) => \\$v !== null);');
  } else {
    lines.push('        $body = $body ?? [];');
  }
}

function emitQueryBuilder(lines: string[], op: Operation, plan: OperationPlan, isPaginated: boolean): void {
  lines.push('        $query = array_filter([');
  if (isPaginated) {
    // Use the actual pagination param names from the spec
    const paginationParam = op.pagination?.param ?? 'after';
    const limitParam = op.pagination?.limitParam ?? 'limit';
    lines.push(`            '${limitParam}' => $limit,`);
    lines.push("            'after' => $after,");
    lines.push("            'before' => $before,");
    // Skip query params already covered by pagination
    const paginationParamNames = new Set([limitParam, paginationParam, 'after', 'before', 'order', 'cursor']);
    for (const p of op.queryParams) {
      if (paginationParamNames.has(p.name)) continue;
      lines.push(`            '${p.name}' => $${fieldName(p.name)},`);
    }
  } else {
    for (const p of op.queryParams) {
      lines.push(
        `            '${p.name}' => $${fieldName(p.name)} instanceof \\BackedEnum ? $${fieldName(p.name)}->value : $${fieldName(p.name)},`,
      );
    }
  }
  lines.push('        ], fn (\\$v) => \\$v !== null);');
}

function emitBodyParamDocs(lines: string[], op: Operation, ctx: EmitterContext): void {
  const bodyModel =
    op.requestBody?.kind === 'model' ? ctx.spec.models.find((m) => m.name === (op.requestBody as any).name) : null;
  if (bodyModel) {
    for (const f of bodyModel.fields) {
      const phpName = fieldName(f.name);
      const docType = mapTypeRefDoc(f.type);
      const isOptional = !f.required;
      lines.push(`     * @param ${docType}${isOptional ? '|null' : ''} $${phpName}`);
    }
  }
}

function collectResourceImports(service: Service, ctx: EmitterContext): string[] {
  const imports = new Set<string>();

  for (const op of service.operations) {
    const plan = planOperation(op);
    // Model imports for return types
    if (plan.responseModelName) {
      imports.add(`${ctx.namespacePascal}\\Models\\${className(plan.responseModelName)}`);
    }
    // Model imports for request body
    if (op.requestBody?.kind === 'model') {
      const bodyModel = ctx.spec.models.find((m) => m.name === (op.requestBody as any)?.name);
      if (bodyModel) {
        for (const f of bodyModel.fields) {
          addTypeImports(f.type, ctx, imports);
        }
      }
    }
    // Enum imports for params
    for (const p of [...op.pathParams, ...op.queryParams]) {
      addTypeImports(p.type, ctx, imports);
    }
    // Pagination item type
    if (op.pagination?.itemType?.kind === 'model') {
      imports.add(`${ctx.namespacePascal}\\Models\\${className(op.pagination.itemType.name)}`);
    }
  }

  return [...imports].sort();
}

function addTypeImports(ref: TypeRef, ctx: EmitterContext, imports: Set<string>): void {
  if (ref.kind === 'enum') {
    imports.add(`${ctx.namespacePascal}\\Enums\\${className(ref.name)}`);
  } else if (ref.kind === 'model') {
    imports.add(`${ctx.namespacePascal}\\Models\\${className(ref.name)}`);
  } else if (ref.kind === 'array') {
    addTypeImports(ref.items, ctx, imports);
  } else if (ref.kind === 'nullable') {
    addTypeImports(ref.inner, ctx, imports);
  } else if (ref.kind === 'union') {
    for (const v of ref.variants) {
      addTypeImports(v, ctx, imports);
    }
  }
}
