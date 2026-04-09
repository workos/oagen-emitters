import type { Service, Operation, Model, EmitterContext, GeneratedFile, ResolvedOperation } from '@workos/oagen';
import { planOperation, toCamelCase } from '@workos/oagen';
import { mapTypeRef, mapTypeRefForPHPDoc } from './type-map.js';
import { className, fieldName, resolveMethodName } from './naming.js';
import { isListWrapperModel } from './models.js';
import {
  groupByMount,
  buildResolvedLookup,
  lookupResolved,
  getOpDefaults,
  getOpInferFromClient,
} from '../shared/resolved-ops.js';
import { generateWrapperMethods } from './wrappers.js';
import { phpDocComment } from './utils.js';

/**
 * Resolve the resource class name for a service (used by client.ts).
 */
export function resolveResourceClassName(service: Service, ctx: EmitterContext): string {
  for (const r of ctx.resolvedOperations ?? []) {
    if (r.service.name === service.name) return r.mountOn;
  }
  return className(service.name);
}

/**
 * Generate PHP resource class files from IR services.
 * Uses mount-based grouping: one resource file per mount target.
 */
export function generateResources(services: Service[], ctx: EmitterContext): GeneratedFile[] {
  if (services.length === 0) return [];

  const files: GeneratedFile[] = [];
  const modelMap = new Map(ctx.spec.models.map((m) => [m.name, m]));

  // Group operations by mount target
  const mountGroups = groupByMount(ctx);
  const entries: Array<{ name: string; operations: Operation[] }> =
    mountGroups.size > 0
      ? [...mountGroups].map(([name, group]) => ({ name, operations: group.operations }))
      : services.map((s) => ({ name: className(s.name), operations: s.operations }));

  for (const { name: mountName, operations } of entries) {
    if (operations.length === 0) continue;
    const resourceName = className(mountName);
    const mergedService: Service = { name: mountName, operations };
    const lines: string[] = [];

    // No <?php here — the file header from fileHeader() provides it
    lines.push(`namespace ${ctx.namespacePascal}\\Service;`);
    lines.push('');

    // Collect imports
    const imports = collectImports(mergedService, ctx);
    for (const imp of imports) {
      lines.push(`use ${imp};`);
    }
    if (imports.length > 0) lines.push('');

    lines.push(`class ${resourceName}`);
    lines.push('{');
    lines.push('    public function __construct(');
    lines.push(`        private readonly \\${ctx.namespacePascal}\\HttpClient $client,`);
    lines.push('    ) {');
    lines.push('    }');

    // Track emitted method names to avoid duplicates
    const emittedMethods = new Set<string>();
    const resolvedLookup = buildResolvedLookup(ctx);
    for (const op of operations) {
      const method = resolveMethodName(op, mergedService, ctx);
      if (emittedMethods.has(method)) continue;
      emittedMethods.add(method);
      const resolved = lookupResolved(op, resolvedLookup);

      // When wrappers exist, skip the base method and only emit wrappers
      if (resolved?.wrappers && resolved.wrappers.length > 0) {
        lines.push(...generateWrapperMethods(resolved, ctx));
      } else {
        lines.push('');
        generateMethod(lines, op, mergedService, ctx, modelMap, resolved ?? undefined);
      }
    }

    lines.push('}');

    files.push({
      path: `lib/Service/${resourceName}.php`,
      content: lines.join('\n'),
      overwriteExisting: true,
    });
  }

  return files;
}

function generateMethod(
  lines: string[],
  op: Operation,
  service: Service,
  ctx: EmitterContext,
  modelMap: Map<string, Model>,
  resolvedOp?: ResolvedOperation,
): void {
  const plan = planOperation(op);
  const method = resolveMethodName(op, service, ctx);

  // Build the set of params hidden from the method signature
  // (injected from client config or as constant defaults)
  const hiddenParams = new Set<string>([
    ...Object.keys(getOpDefaults(resolvedOp)),
    ...getOpInferFromClient(resolvedOp),
  ]);

  const params = buildMethodParams(op, plan, modelMap, ctx, hiddenParams);
  const returnType = getReturnType(plan, ctx);

  // PHPDoc block
  const docParts: string[] = [];
  if (op.description) docParts.push(op.description);
  const seenDocParams = new Set<string>();

  // @param for path params
  for (const p of op.pathParams) {
    const docType = mapTypeRefForPHPDoc(p.type);
    const phpName = fieldName(p.name);
    seenDocParams.add(phpName);
    const prefix = p.deprecated ? '(deprecated) ' : '';
    let desc = p.description ? ` ${prefix}${p.description}` : p.deprecated ? ' (deprecated)' : '';
    if (p.default != null) desc += ` Defaults to ${JSON.stringify(p.default)}.`;
    docParts.push(`@param ${docType} $${phpName}${desc}`);
  }

  // @param for body fields
  if (plan.hasBody && op.requestBody?.kind === 'model') {
    const bodyModel = modelMap.get(op.requestBody.name);
    if (bodyModel) {
      const bodyParamMap = buildBodyParamMap(op, bodyModel);
      for (const field of bodyModel.fields) {
        if (hiddenParams.has(field.name)) continue;
        const docType = mapTypeRefForPHPDoc(field.type);
        const phpName = bodyParamMap.get(field.name) ?? fieldName(field.name);
        if (seenDocParams.has(phpName)) continue;
        seenDocParams.add(phpName);
        const nullSuffix = !field.required && !docType.endsWith('|null') ? '|null' : '';
        const prefix = field.deprecated ? '(deprecated) ' : '';
        const desc = field.description ? ` ${prefix}${field.description}` : field.deprecated ? ' (deprecated)' : '';
        docParts.push(`@param ${docType}${nullSuffix} $${phpName}${desc}`);
      }
    }
  }

  // @param for query params
  for (const q of op.queryParams) {
    if (hiddenParams.has(q.name)) continue;
    const docType = mapTypeRefForPHPDoc(q.type);
    const phpName = fieldName(q.name);
    if (seenDocParams.has(phpName)) continue;
    seenDocParams.add(phpName);
    const nullSuffix = !q.required && !docType.endsWith('|null') ? '|null' : '';
    const prefix = q.deprecated ? '(deprecated) ' : '';
    let desc = q.description ? ` ${prefix}${q.description}` : q.deprecated ? ' (deprecated)' : '';
    if (q.default != null) desc += ` Defaults to ${JSON.stringify(q.default)}.`;
    docParts.push(`@param ${docType}${nullSuffix} $${phpName}${desc}`);
  }

  // @return -- use generic annotation for paginated responses
  if (plan.isPaginated && op.pagination?.itemType.kind === 'model') {
    const itemType = op.pagination.itemType;
    const itemModel = ctx.spec.models.find((m) => m.name === itemType.name);
    let resolvedName = itemType.name;
    if (itemModel && isListWrapperModel(itemModel)) {
      const dataField = itemModel.fields.find((f) => f.name === 'data');
      if (dataField?.type.kind === 'array' && dataField.type.items.kind === 'model') {
        resolvedName = dataField.type.items.name;
      }
    }
    const itemClass = className(resolvedName);
    docParts.push(
      `@return \\${ctx.namespacePascal}\\PaginatedResponse<\\${ctx.namespacePascal}\\Resource\\${itemClass}>`,
    );
  } else {
    docParts.push(`@return ${returnType}`);
  }

  if (op.deprecated) docParts.push('@deprecated');
  lines.push(...phpDocComment(docParts.join('\n'), 4));

  // Method signature
  lines.push(`    public function ${method}(`);
  for (let i = 0; i < params.length; i++) {
    const comma = i < params.length - 1 ? ',' : ',';
    lines.push(`        ${params[i]}${comma}`);
  }
  lines.push(`    ): ${returnType} {`);

  // Method body
  const httpMethod = op.httpMethod.toUpperCase();
  const path = buildPathString(op);

  if (plan.isPaginated) {
    const queryLines = buildQueryArray(op);
    if (queryLines.length > 0) {
      lines.push('        $query = array_filter([');
      for (const q of queryLines) {
        lines.push(`            ${q}`);
      }
      lines.push('        ], fn ($v) => $v !== null);');
    }
    lines.push('        return $this->client->requestPage(');
    lines.push(`            method: '${httpMethod}',`);
    lines.push(`            path: ${path},`);
    if (queryLines.length > 0) {
      lines.push('            query: $query,');
    }
    const itemType = op.pagination?.itemType;
    if (itemType?.kind === 'model') {
      // Unwrap list wrapper models to the inner item type
      const itemModel = ctx.spec.models.find((m) => m.name === itemType.name);
      let resolvedName = itemType.name;
      if (itemModel && isListWrapperModel(itemModel)) {
        const dataField = itemModel.fields.find((f) => f.name === 'data');
        if (dataField?.type.kind === 'array' && dataField.type.items.kind === 'model') {
          resolvedName = dataField.type.items.name;
        }
      }
      const itemClass = className(resolvedName);
      lines.push(`            modelClass: ${itemClass}::class,`);
    }
    lines.push('            options: $options,');
    lines.push('        );');
  } else if (plan.isDelete) {
    // Build body if the operation has a request body (e.g., DELETE with criteria)
    if (plan.hasBody) {
      const bodyModel = op.requestBody?.kind === 'model' ? modelMap.get(op.requestBody.name) : null;
      const bodyParamMap = buildBodyParamMap(op, bodyModel ?? null);
      const visibleFields = bodyModel?.fields.filter((f) => !hiddenParams.has(f.name)) ?? [];
      const hasOptionalFields = visibleFields.some((f) => !f.required);
      if (hasOptionalFields) {
        lines.push('        $body = array_filter([');
      } else {
        lines.push('        $body = [');
      }
      for (const field of visibleFields) {
        const phpName = bodyParamMap.get(field.name) ?? fieldName(field.name);
        const nullsafe = field.required ? '' : '?';
        const valueExpr = isEnumType(field.type) ? `$${phpName}${nullsafe}->value` : `$${phpName}`;
        lines.push(`            '${field.name}' => ${valueExpr},`);
      }
      // Inject constant defaults
      for (const [key, value] of Object.entries(getOpDefaults(resolvedOp))) {
        lines.push(`            '${key}' => ${phpLiteral(value)},`);
      }
      if (hasOptionalFields) {
        lines.push('        ], fn ($v) => $v !== null);');
      } else {
        lines.push('        ];');
      }
      // Inject fields from client config
      for (const clientField of getOpInferFromClient(resolvedOp)) {
        lines.push(`        $body['${clientField}'] = ${clientFieldExpression(clientField)};`);
      }
    }
    // Build query params if present
    const deleteQueryLines = buildQueryArray(op);
    if (deleteQueryLines.length > 0) {
      lines.push('        $query = array_filter([');
      for (const q of deleteQueryLines) {
        lines.push(`            ${q}`);
      }
      lines.push('        ], fn ($v) => $v !== null);');
    }

    lines.push('        $this->client->request(');
    lines.push(`            method: '${httpMethod}',`);
    lines.push(`            path: ${path},`);
    if (plan.hasBody) {
      lines.push('            body: $body,');
    }
    if (deleteQueryLines.length > 0) {
      lines.push('            query: $query,');
    }
    lines.push('            options: $options,');
    lines.push('        );');
  } else if (plan.hasBody) {
    const bodyModel = op.requestBody?.kind === 'model' ? modelMap.get(op.requestBody.name) : null;
    const bodyParamMap = buildBodyParamMap(op, bodyModel ?? null);
    const visibleFields = bodyModel?.fields.filter((f) => !hiddenParams.has(f.name)) ?? [];
    const hasOptionalFields = visibleFields.some((f) => !f.required);
    if (hasOptionalFields) {
      lines.push('        $body = array_filter([');
    } else {
      lines.push('        $body = [');
    }
    for (const field of visibleFields) {
      const phpName = bodyParamMap.get(field.name) ?? fieldName(field.name);
      const nullsafe = field.required ? '' : '?';
      const valueExpr = isEnumType(field.type) ? `$${phpName}${nullsafe}->value` : `$${phpName}`;
      lines.push(`            '${field.name}' => ${valueExpr},`);
    }
    // Inject constant defaults
    for (const [key, value] of Object.entries(getOpDefaults(resolvedOp))) {
      lines.push(`            '${key}' => ${phpLiteral(value)},`);
    }
    if (hasOptionalFields) {
      lines.push('        ], fn ($v) => $v !== null);');
    } else {
      lines.push('        ];');
    }
    // Inject fields from client config
    for (const clientField of getOpInferFromClient(resolvedOp)) {
      lines.push(`        $body['${clientField}'] = ${clientFieldExpression(clientField)};`);
    }
    lines.push('        $response = $this->client->request(');
    lines.push(`            method: '${httpMethod}',`);
    lines.push(`            path: ${path},`);
    lines.push('            body: $body,');
    lines.push('            options: $options,');
    lines.push('        );');

    if (plan.responseModelName) {
      const responseClass = className(plan.responseModelName);
      if (op.response.kind === 'array') {
        lines.push(`        return array_map(fn ($item) => ${responseClass}::fromArray($item), $response);`);
      } else {
        lines.push(`        return ${responseClass}::fromArray($response);`);
      }
    } else {
      lines.push('        return $response;');
    }
  } else {
    const queryLines = buildQueryArray(op, hiddenParams);
    const hasDefaults = Object.keys(getOpDefaults(resolvedOp)).length > 0;
    const hasInferred = getOpInferFromClient(resolvedOp).length > 0;
    const needsQuery = queryLines.length > 0 || hasDefaults || hasInferred;

    if (needsQuery) {
      const hasOptionalQuery = op.queryParams.some((q) => !q.required && !hiddenParams.has(q.name));
      if (hasOptionalQuery) {
        lines.push('        $query = array_filter([');
      } else {
        lines.push('        $query = [');
      }
      for (const q of queryLines) {
        lines.push(`            ${q}`);
      }
      // Inject constant defaults
      for (const [key, value] of Object.entries(getOpDefaults(resolvedOp))) {
        lines.push(`            '${key}' => ${phpLiteral(value)},`);
      }
      if (hasOptionalQuery) {
        lines.push('        ], fn ($v) => $v !== null);');
      } else {
        lines.push('        ];');
      }
      // Inject fields from client config
      for (const clientField of getOpInferFromClient(resolvedOp)) {
        lines.push(`        $query['${clientField}'] = ${clientFieldExpression(clientField)};`);
      }
    }
    lines.push('        $response = $this->client->request(');
    lines.push(`            method: '${httpMethod}',`);
    lines.push(`            path: ${path},`);
    if (needsQuery) {
      lines.push('            query: $query,');
    }
    lines.push('            options: $options,');
    lines.push('        );');

    if (plan.responseModelName) {
      const responseClass = className(plan.responseModelName);
      if (op.response.kind === 'array') {
        lines.push(`        return array_map(fn ($item) => ${responseClass}::fromArray($item), $response);`);
      } else {
        lines.push(`        return ${responseClass}::fromArray($response);`);
      }
    } else {
      lines.push('        return $response;');
    }
  }

  lines.push('    }');
}

function buildMethodParams(
  op: Operation,
  plan: ReturnType<typeof planOperation>,
  modelMap: Map<string, Model>,
  ctx: EmitterContext,
  hiddenParams?: Set<string>,
): string[] {
  // Collect all params into required/optional buckets to avoid
  // PHP's "required after optional" deprecation.
  const required: string[] = [];
  const optional: string[] = [];
  const usedNames = new Set<string>();
  const hidden = hiddenParams ?? new Set();

  // Path params (always required)
  for (const p of op.pathParams) {
    const phpType = mapTypeRef(p.type, { qualified: true });
    let phpName = fieldName(p.name);
    if (usedNames.has(phpName)) phpName = `path${phpName.charAt(0).toUpperCase()}${phpName.slice(1)}`;
    usedNames.add(phpName);
    required.push(`${phpType} $${phpName}`);
  }

  // Body fields
  if (plan.hasBody && op.requestBody?.kind === 'model') {
    const bodyModel = modelMap.get(op.requestBody.name);
    if (bodyModel) {
      for (const field of bodyModel.fields) {
        if (hidden.has(field.name)) continue;
        const phpType = mapTypeRef(field.type, { qualified: true });
        let phpName = fieldName(field.name);
        if (usedNames.has(phpName)) {
          // Disambiguate body field from path param with same name
          phpName = `body${phpName.charAt(0).toUpperCase()}${phpName.slice(1)}`;
          if (usedNames.has(phpName)) continue; // truly duplicate, skip
        }
        usedNames.add(phpName);
        if (field.required) {
          required.push(`${phpType} $${phpName}`);
        } else {
          const nullableType = phpType.startsWith('?') ? phpType : `?${phpType}`;
          optional.push(`${nullableType} $${phpName} = null`);
        }
      }
    }
  }

  // Query params
  for (const q of op.queryParams) {
    if (hidden.has(q.name)) continue;
    const phpType = mapTypeRef(q.type, { qualified: true });
    let phpName = fieldName(q.name);
    if (usedNames.has(phpName)) continue;
    usedNames.add(phpName);
    if (q.required) {
      required.push(`${phpType} $${phpName}`);
    } else {
      const nullableType = phpType.startsWith('?') ? phpType : `?${phpType}`;
      optional.push(`${nullableType} $${phpName} = null`);
    }
  }

  // RequestOptions (always last, always optional)
  optional.push(`?\\${ctx.namespacePascal}\\RequestOptions $options = null`);

  return [...required, ...optional];
}

function getReturnType(plan: ReturnType<typeof planOperation>, ctx: EmitterContext): string {
  if (plan.isDelete) return 'void';
  if (plan.isPaginated) return `\\${ctx.namespacePascal}\\PaginatedResponse`;
  if (plan.responseModelName) {
    if (plan.operation.response.kind === 'array') {
      return 'array';
    }
    return `\\${ctx.namespacePascal}\\Resource\\${className(plan.responseModelName)}`;
  }
  return 'mixed';
}

/**
 * Build a mapping from wire name to PHP variable name for body fields,
 * disambiguating collisions with path param names.
 */
function buildBodyParamMap(op: Operation, bodyModel: Model | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!bodyModel) return map;
  const pathParamNames = new Set(op.pathParams.map((p) => fieldName(p.name)));
  for (const field of bodyModel.fields) {
    let phpName = fieldName(field.name);
    if (pathParamNames.has(phpName)) {
      phpName = `body${phpName.charAt(0).toUpperCase()}${phpName.slice(1)}`;
    }
    map.set(field.name, phpName);
  }
  return map;
}

function buildPathString(op: Operation): string {
  let path = op.path.startsWith('/') ? op.path.slice(1) : op.path;
  if (op.pathParams.length === 0) {
    return `'${path}'`;
  }
  // Build a map of param name → PHP expression (with ->value for enum types)
  const paramExprs = new Map<string, string>();
  for (const p of op.pathParams) {
    const phpName = fieldName(p.name);
    const isEnum = p.type.kind === 'enum' || p.type.kind === 'model';
    paramExprs.set(p.name, isEnum ? `{$${phpName}->value}` : `{$${phpName}}`);
  }
  path = path.replace(/\{([^}]+)\}/g, (_match, param) => paramExprs.get(param) ?? `{$${fieldName(param)}}`);
  return `"${path}"`;
}

function isEnumType(ref: import('@workos/oagen').TypeRef): boolean {
  if (ref.kind === 'enum') return true;
  if (ref.kind === 'nullable') return isEnumType(ref.inner);
  return false;
}

function buildQueryArray(op: Operation, hiddenParams?: Set<string>): string[] {
  const hidden = hiddenParams ?? new Set();
  return op.queryParams
    .filter((q) => !hidden.has(q.name))
    .map((q) => {
      const phpName = fieldName(q.name);
      if (isEnumType(q.type)) {
        const nullsafe = q.required ? '' : '?';
        return `'${q.name}' => $${phpName}${nullsafe}->value,`;
      }
      return `'${q.name}' => $${phpName},`;
    });
}

function phpLiteral(value: unknown): string {
  if (typeof value === 'string') return `'${value}'`;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return 'null';
}

function clientFieldExpression(field: string): string {
  switch (field) {
    case 'client_id':
      return '$this->client->requireClientId()';
    case 'client_secret':
      return '$this->client->requireApiKey()';
    default:
      return `$this->client->${toCamelCase(field)}`;
  }
}

function collectImports(service: Service, ctx: EmitterContext): string[] {
  const imports = new Set<string>();
  const ns = ctx.namespacePascal;

  for (const op of service.operations) {
    const plan = planOperation(op);
    if (plan.responseModelName && !plan.isPaginated) {
      imports.add(`${ns}\\Resource\\${className(plan.responseModelName)}`);
    }
    if (op.pagination?.itemType.kind === 'model') {
      // Unwrap list wrapper models to import the inner item type
      const itemModel = ctx.spec.models.find((m) => m.name === (op.pagination!.itemType as { name: string }).name);
      let resolvedName = (op.pagination!.itemType as { name: string }).name;
      if (itemModel && isListWrapperModel(itemModel)) {
        const dataField = itemModel.fields.find((f) => f.name === 'data');
        if (dataField?.type.kind === 'array' && dataField.type.items.kind === 'model') {
          resolvedName = dataField.type.items.name;
        }
      }
      imports.add(`${ns}\\Resource\\${className(resolvedName)}`);
    }
  }

  return [...imports].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}
