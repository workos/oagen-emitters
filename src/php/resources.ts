import type { Service, Operation, OperationPlan, EmitterContext, GeneratedFile, TypeRef } from '@workos/oagen';
import { planOperation, toCamelCase } from '@workos/oagen';
import { mapTypeRef, mapTypeRefDoc } from './type-map.js';
import { className, enumClassName, fieldName, resolveClassName } from './naming.js';
import { buildResolvedLookup, lookupMethodName, lookupResolved, groupByMount } from '../shared/resolved-ops.js';
import { generateWrapperMethods } from './wrappers.js';
import { isListWrapperModel } from './models.js';

/**
 * A map from "source:originalName" (e.g. "path:slug", "body:slug") to disambiguated PHP name.
 */
type ParamNameMap = Map<string, string>;

/**
 * Build a disambiguation map for all parameters in an operation.
 * When a body field, query param, or path param share the same PHP name,
 * disambiguate using context from the path or source.
 */
function buildParamNameMap(op: Operation, plan: OperationPlan, ctx: EmitterContext): ParamNameMap {
  const entries: { key: string; phpName: string }[] = [];

  for (const p of op.pathParams) {
    entries.push({ key: `path:${p.name}`, phpName: fieldName(p.name) });
  }

  if (plan.hasBody && op.requestBody?.kind === 'model') {
    const bodyModel = ctx.spec.models.find((m) => m.name === (op.requestBody as any).name);
    if (bodyModel) {
      for (const f of bodyModel.fields) {
        entries.push({ key: `body:${f.name}`, phpName: fieldName(f.name) });
      }
    }
  }

  const queryParams = plan.isPaginated ? getNonPaginationQueryParams(op) : op.queryParams;
  for (const p of queryParams) {
    entries.push({ key: `query:${p.name}`, phpName: fieldName(p.name) });
  }

  // Count occurrences of each PHP name
  const counts = new Map<string, number>();
  for (const e of entries) {
    counts.set(e.phpName, (counts.get(e.phpName) || 0) + 1);
  }

  const result: ParamNameMap = new Map();
  const usedNames = new Set<string>();

  for (const e of entries) {
    if (counts.get(e.phpName)! <= 1) {
      result.set(e.key, e.phpName);
      usedNames.add(e.phpName);
    } else {
      // Collision — disambiguate based on source
      const [source, origName] = e.key.split(':', 2);
      let disambiguated: string;
      if (source === 'path') {
        // Use preceding path segment for context (e.g., /roles/{slug} → roleSlug)
        const context = getPathParamContext(op.path, origName);
        disambiguated = context ? fieldName(`${context}_${origName}`) : fieldName(`path_${origName}`);
      } else if (source === 'query') {
        disambiguated = fieldName(`query_${origName}`);
      } else {
        disambiguated = fieldName(`body_${origName}`);
      }
      // Ensure no further collision
      while (usedNames.has(disambiguated)) {
        disambiguated += '_';
      }
      result.set(e.key, disambiguated);
      usedNames.add(disambiguated);
    }
  }

  return result;
}

/** Extract context from path segment preceding a path param. */
function getPathParamContext(path: string, paramName: string): string | null {
  const segments = path.split('/').filter(Boolean);
  const paramToken = `{${paramName}}`;
  for (let i = 0; i < segments.length; i++) {
    if (segments[i] === paramToken && i > 0) {
      const prev = segments[i - 1].replace(/_/g, ' ');
      // Simple singularization
      let singular = prev;
      if (singular.endsWith('ies')) singular = singular.slice(0, -3) + 'y';
      else if (singular.endsWith('ses') || singular.endsWith('xes') || singular.endsWith('zes'))
        singular = singular.slice(0, -2);
      else if (singular.endsWith('s') && !singular.endsWith('ss')) singular = singular.slice(0, -1);
      return singular;
    }
  }
  return null;
}

/** Resolve a param's PHP name, falling back to fieldName if not in the map. */
function resolveParam(nameMap: ParamNameMap, source: string, originalName: string): string {
  return nameMap.get(`${source}:${originalName}`) ?? fieldName(originalName);
}

/**
 * Resolve the resource class name for a service.
 */
export function resolveResourceClassName(service: Service, ctx: EmitterContext): string {
  return resolveClassName(service, ctx);
}

/**
 * Generate PHP resource classes from IR Service definitions.
 * Uses mount-based grouping: one resource file per mount target with all
 * co-mounted operations merged into a single class.
 */
export function generateResources(services: Service[], ctx: EmitterContext): GeneratedFile[] {
  if (services.length === 0) return [];

  const files: GeneratedFile[] = [];
  const resolvedLookup = buildResolvedLookup(ctx);
  const mountGroups = groupByMount(ctx);

  // Build entries: when resolved operations are available, group by mount target.
  // Otherwise fall back to one group per service.
  const entries: Array<{ name: string; operations: Operation[] }> =
    mountGroups.size > 0
      ? [...mountGroups].map(([name, group]) => ({ name, operations: group.operations }))
      : services.map((s) => ({ name: resolveResourceClassName(s, ctx), operations: s.operations }));

  for (const { name: mountName, operations } of entries) {
    if (operations.length === 0) continue;

    const resourceName = className(mountName);
    const mergedService: Service = { name: mountName, operations };
    const lines: string[] = [];

    lines.push('');
    lines.push(`namespace ${ctx.namespacePascal}\\Resources;`);
    lines.push('');

    // Collect imports from all operations in the mount group
    const imports = collectResourceImports(mergedService, ctx);
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
    for (const op of operations) {
      const plan = planOperation(op);
      const resolvedName = lookupMethodName(op, resolvedLookup);
      const method = resolvedName ? toCamelCase(resolvedName) : toCamelCase(op.name);

      lines.push('');
      emitMethod(lines, op, plan, method, mergedService, ctx);

      // Emit union split wrapper methods (typed convenience methods for each variant)
      const resolved = lookupResolved(op, resolvedLookup);
      if (resolved?.wrappers && resolved.wrappers.length > 0) {
        lines.push(...generateWrapperMethods(resolved, ctx));
      }
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

/** Get the set of query param names that are handled by pagination infrastructure. */
function getPaginationParamNames(op: Operation): Set<string> {
  const paginationParam = op.pagination?.param ?? 'after';
  const limitParam = op.pagination?.limitParam ?? 'limit';
  return new Set([limitParam, paginationParam, 'after', 'before', 'cursor']);
}

/** Get non-pagination query params for a paginated operation. */
function getNonPaginationQueryParams(op: Operation): typeof op.queryParams {
  const paginationNames = getPaginationParamNames(op);
  return op.queryParams.filter((p) => !paginationNames.has(p.name));
}

/**
 * Resolve the actual pagination item model name by unwrapping list wrapper models.
 * If itemType points to a list wrapper (e.g., "DirectoryList"), unwrap to the inner item model.
 */
function resolvePaginationItemName(op: Operation, ctx: EmitterContext): string | null {
  const itemType = op.pagination?.itemType;
  if (!itemType || itemType.kind !== 'model') return null;

  // Check if the item type is a list wrapper — if so, unwrap to the actual item
  const model = ctx.spec.models.find((m) => m.name === itemType.name);
  if (model && isListWrapperModel(model)) {
    const dataField = model.fields.find((f) => f.name === 'data');
    if (dataField?.type.kind === 'array' && dataField.type.items.kind === 'model') {
      return dataField.type.items.name;
    }
  }

  return itemType.name;
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
  const nameMap = buildParamNameMap(op, plan, ctx);

  // PHPDoc
  lines.push('    /**');
  if (op.description) {
    lines.push(`     * ${op.description}`);
    lines.push('     *');
  }
  // Parameter docs
  for (const p of op.pathParams) {
    lines.push(`     * @param ${mapTypeRefDoc(p.type)} $${resolveParam(nameMap, 'path', p.name)}`);
  }
  if (plan.hasBody && op.requestBody) {
    emitBodyParamDocs(lines, op, ctx, nameMap);
  }
  if (plan.hasQueryParams && !isPaginated) {
    for (const p of op.queryParams) {
      const phpName = resolveParam(nameMap, 'query', p.name);
      lines.push(`     * @param ${nullableDocType(mapTypeRefDoc(p.type))} $${phpName}`);
    }
  }
  if (isPaginated) {
    // Non-pagination query params (filters)
    for (const p of getNonPaginationQueryParams(op)) {
      const phpName = resolveParam(nameMap, 'query', p.name);
      lines.push(`     * @param ${nullableDocType(mapTypeRefDoc(p.type))} $${phpName}`);
    }
    lines.push('     * @param int|null $limit');
    lines.push('     * @param string|null $after');
    lines.push('     * @param string|null $before');
  }

  // RequestOptions param doc
  lines.push(`     * @param \\${ctx.namespacePascal}\\RequestOptions|null $options`);

  // Return type doc
  const isArrayResponse = !isPaginated && !isDelete && op.response.kind === 'array';
  if (isPaginated) {
    const resolvedItemName = resolvePaginationItemName(op, ctx);
    const itemDocName = resolvedItemName ? className(resolvedItemName) : 'mixed';
    lines.push(`     * @return \\${ctx.namespacePascal}\\PaginatedResponse<${itemDocName}>`);
  } else if (isDelete) {
    lines.push('     * @return void');
  } else if (isArrayResponse && plan.responseModelName) {
    lines.push(`     * @return array<${className(plan.responseModelName)}>`);
  } else if (plan.responseModelName) {
    lines.push(`     * @return ${className(plan.responseModelName)}`);
  } else {
    lines.push('     * @return array<string, mixed>');
  }

  // Throws doc
  lines.push('     *');
  lines.push(`     * @throws \\${ctx.namespacePascal}\\Exception\\ApiException`);
  lines.push('     */');

  // Method signature
  const returnType = isDelete
    ? 'void'
    : isPaginated
      ? `\\${ctx.namespacePascal}\\PaginatedResponse`
      : isArrayResponse
        ? 'array'
        : plan.responseModelName
          ? className(plan.responseModelName)
          : 'array';

  const params = buildMethodParams(op, plan, ctx, nameMap);
  lines.push(`    public function ${method}(`);
  for (let i = 0; i < params.length; i++) {
    lines.push(`        ${params[i]}${i < params.length - 1 ? ',' : ','}`);
  }
  // Always add options as last param
  lines.push(`        ?\\${ctx.namespacePascal}\\RequestOptions $options = null,`);
  lines.push(`    ): ${returnType}`);
  lines.push('    {');

  // Build path with interpolation
  const pathExpr = buildPathExpression(op, nameMap);

  // Build request body
  if (plan.hasBody && op.requestBody) {
    emitBodyBuilder(lines, op, ctx, nameMap);
  }

  // Build query params
  if ((plan.hasQueryParams && !isPaginated) || isPaginated) {
    emitQueryBuilder(lines, op, plan, isPaginated, nameMap, ctx);
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
    const resolvedItemName = resolvePaginationItemName(op, ctx);
    const itemClassName = resolvedItemName
      ? `\\${ctx.namespacePascal}\\Resource\\${className(resolvedItemName)}`
      : null;
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

    // Create a fetch callback for auto-pagination — forward all original filters
    lines.push(`            fn (array $params) => $this->${method}(`);
    if (op.pathParams.length > 0) {
      for (const p of op.pathParams) {
        const phpName = resolveParam(nameMap, 'path', p.name);
        lines.push(`                ${phpName}: $${phpName},`);
      }
    }
    // Forward non-pagination query params (filters)
    for (const p of getNonPaginationQueryParams(op)) {
      const phpName = resolveParam(nameMap, 'query', p.name);
      lines.push(`                ${phpName}: $${phpName},`);
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
    if (isArrayResponse && plan.responseModelName) {
      const modelRef = `\\${ctx.namespacePascal}\\Resource\\${className(plan.responseModelName)}`;
      lines.push(`        return array_map(fn (array $item) => ${modelRef}::fromArray($item), $response);`);
    } else if (plan.responseModelName) {
      lines.push(
        `        return \\${ctx.namespacePascal}\\Resource\\${className(plan.responseModelName)}::fromArray($response);`,
      );
    } else {
      lines.push('        return $response;');
    }
  }

  lines.push('    }');
}

function buildMethodParams(op: Operation, plan: OperationPlan, ctx: EmitterContext, nameMap: ParamNameMap): string[] {
  const required: string[] = [];
  const optional: string[] = [];

  // Path params (always required)
  for (const p of op.pathParams) {
    const phpType = mapTypeRef(p.type);
    required.push(`${phpType} $${resolveParam(nameMap, 'path', p.name)}`);
  }

  // Request body fields
  const isUpdateOp = op.httpMethod === 'put' || op.httpMethod === 'patch';
  if (plan.hasBody && op.requestBody) {
    const bodyModel =
      op.requestBody.kind === 'model' ? ctx.spec.models.find((m) => m.name === (op.requestBody as any).name) : null;
    if (bodyModel) {
      for (const f of bodyModel.fields) {
        const phpName = resolveParam(nameMap, 'body', f.name);
        if (f.required) {
          const phpType = mapTypeRef(f.type);
          required.push(`${phpType} $${phpName}`);
        } else if (isUpdateOp) {
          // Use Undefined sentinel for update operations to distinguish "not provided" from "explicitly null"
          const baseType = f.type.kind === 'nullable' ? mapTypeRef(f.type.inner) : mapTypeRef(f.type);
          const nullPart = f.type.kind === 'nullable' ? '|null' : '';
          optional.push(
            `${baseType}${nullPart}|\\${ctx.namespacePascal}\\Undefined $${phpName} = \\${ctx.namespacePascal}\\Undefined::Value`,
          );
        } else {
          const innerType = f.type.kind === 'nullable' ? mapTypeRef(f.type.inner) : mapTypeRef(f.type);
          optional.push(`?${innerType} $${phpName} = null`);
        }
      }
    } else {
      optional.push('?array $body = null');
    }
  }

  // Query params for non-paginated methods
  if (plan.hasQueryParams && !plan.isPaginated) {
    for (const p of op.queryParams) {
      const phpType = mapTypeRef(p.type);
      const phpName = resolveParam(nameMap, 'query', p.name);
      if (p.required) {
        required.push(`${phpType} $${phpName}`);
      } else {
        optional.push(`?${phpType} $${phpName} = null`);
      }
    }
  }

  // Paginated: non-pagination query params (filters) + pagination params
  if (plan.isPaginated) {
    for (const p of getNonPaginationQueryParams(op)) {
      const phpType = mapTypeRef(p.type);
      const phpName = resolveParam(nameMap, 'query', p.name);
      if (p.required) {
        required.push(`${phpType} $${phpName}`);
      } else {
        optional.push(`?${phpType} $${phpName} = null`);
      }
    }
    optional.push('?int $limit = null');
    optional.push('?string $after = null');
    optional.push('?string $before = null');
  }

  // Idempotency key
  if (op.injectIdempotencyKey) {
    optional.push('?string $idempotencyKey = null');
  }

  return [...required, ...optional];
}

function buildPathExpression(op: Operation, nameMap: ParamNameMap): string {
  let path = op.path.replace(/^\//, '');
  if (op.pathParams.length === 0) {
    return `'${path}'`;
  }
  // Replace {paramName} with PHP string interpolation
  for (const p of op.pathParams) {
    const phpVar = `$${resolveParam(nameMap, 'path', p.name)}`;
    path = path.replace(`{${p.name}}`, `{${phpVar}}`);
  }
  return `"${path}"`;
}

function emitBodyBuilder(lines: string[], op: Operation, ctx: EmitterContext, nameMap: ParamNameMap): void {
  const bodyModel =
    op.requestBody?.kind === 'model' ? ctx.spec.models.find((m) => m.name === (op.requestBody as any).name) : null;
  const isUpdateOp = op.httpMethod === 'put' || op.httpMethod === 'patch';

  if (bodyModel) {
    const enumNames = new Set(ctx.spec.enums.map((e) => e.name));
    lines.push('        $body = array_filter([');
    for (const f of bodyModel.fields) {
      const phpProp = resolveParam(nameMap, 'body', f.name);
      const wire = f.name;
      const isEnum = isEnumType(f.type, enumNames);
      if (isEnum) {
        lines.push(`            '${wire}' => $${phpProp} instanceof \\BackedEnum ? $${phpProp}->value : $${phpProp},`);
      } else {
        lines.push(`            '${wire}' => $${phpProp},`);
      }
    }
    if (isUpdateOp) {
      // Use Undefined sentinel for update ops: preserves explicit null, strips only unprovided fields
      lines.push(`        ], fn ($v) => !$v instanceof \\${ctx.namespacePascal}\\Undefined);`);
    } else {
      lines.push('        ], fn ($v) => $v !== null);');
    }
  } else {
    lines.push('        $body = $body ?? [];');
  }
}

/** Check if a TypeRef is an enum type (directly or via model-ref to an enum). */
function isEnumType(ref: TypeRef, enumNames: Set<string>): boolean {
  if (ref.kind === 'enum') return true;
  if (ref.kind === 'model' && enumNames.has(ref.name)) return true;
  if (ref.kind === 'nullable') return isEnumType(ref.inner, enumNames);
  return false;
}

function emitQueryBuilder(
  lines: string[],
  op: Operation,
  plan: OperationPlan,
  isPaginated: boolean,
  nameMap: ParamNameMap,
  ctx: EmitterContext,
): void {
  const enumNameSet = new Set(ctx.spec.enums.map((e) => e.name));

  lines.push('        $query = array_filter([');
  if (isPaginated) {
    const limitParam = op.pagination?.limitParam ?? 'limit';
    lines.push(`            '${limitParam}' => $limit,`);
    lines.push("            'after' => $after,");
    lines.push("            'before' => $before,");
    for (const p of getNonPaginationQueryParams(op)) {
      const phpName = resolveParam(nameMap, 'query', p.name);
      if (isEnumType(p.type, enumNameSet)) {
        lines.push(
          `            '${p.name}' => $${phpName} instanceof \\BackedEnum ? $${phpName}->value : $${phpName},`,
        );
      } else {
        lines.push(`            '${p.name}' => $${phpName},`);
      }
    }
  } else {
    for (const p of op.queryParams) {
      const phpName = resolveParam(nameMap, 'query', p.name);
      if (isEnumType(p.type, enumNameSet)) {
        lines.push(
          `            '${p.name}' => $${phpName} instanceof \\BackedEnum ? $${phpName}->value : $${phpName},`,
        );
      } else {
        lines.push(`            '${p.name}' => $${phpName},`);
      }
    }
  }
  lines.push('        ], fn ($v) => $v !== null);');
}

/** Append |null to a PHPDoc type only if it doesn't already end with |null. */
function nullableDocType(docType: string): string {
  return docType.endsWith('|null') || docType === 'null' ? docType : `${docType}|null`;
}

function emitBodyParamDocs(lines: string[], op: Operation, ctx: EmitterContext, nameMap: ParamNameMap): void {
  const bodyModel =
    op.requestBody?.kind === 'model' ? ctx.spec.models.find((m) => m.name === (op.requestBody as any).name) : null;
  if (bodyModel) {
    for (const f of bodyModel.fields) {
      const phpName = resolveParam(nameMap, 'body', f.name);
      const docType = mapTypeRefDoc(f.type);
      const isOptional = !f.required;
      lines.push(`     * @param ${isOptional ? nullableDocType(docType) : docType} $${phpName}`);
    }
  }
}

function collectResourceImports(service: Service, ctx: EmitterContext): string[] {
  const imports = new Set<string>();

  for (const op of service.operations) {
    const plan = planOperation(op);
    // Model imports for return types (skip for paginated ops — list wrapper models aren't generated)
    if (plan.responseModelName && !plan.isPaginated) {
      imports.add(`${ctx.namespacePascal}\\Resource\\${className(plan.responseModelName)}`);
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
    // Pagination item type (unwrap list wrappers)
    if (op.pagination) {
      const resolvedItemName = resolvePaginationItemName(op, ctx);
      if (resolvedItemName) {
        imports.add(`${ctx.namespacePascal}\\Resource\\${className(resolvedItemName)}`);
      }
    }
  }

  return [...imports].sort();
}

function addTypeImports(ref: TypeRef, ctx: EmitterContext, imports: Set<string>): void {
  if (ref.kind === 'enum') {
    imports.add(`${ctx.namespacePascal}\\Resource\\${enumClassName(ref.name)}`);
  } else if (ref.kind === 'model') {
    imports.add(`${ctx.namespacePascal}\\Resource\\${className(ref.name)}`);
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
