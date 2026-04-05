import type { Service, Operation, Model, EmitterContext, GeneratedFile } from '@workos/oagen';
import { planOperation } from '@workos/oagen';
import { mapTypeRef } from './type-map.js';
import { className, fieldName, resolveMethodName } from './naming.js';
import { isListWrapperModel } from './models.js';
import { groupByMount, buildResolvedLookup, lookupResolved } from '../shared/resolved-ops.js';
import { generateWrapperMethods } from './wrappers.js';

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
      lines.push('');
      generateMethod(lines, op, mergedService, ctx, modelMap);

      // Generate union split wrapper methods if this operation has them
      const resolved = lookupResolved(op, resolvedLookup);
      if (resolved?.wrappers && resolved.wrappers.length > 0) {
        lines.push(...generateWrapperMethods(resolved, ctx));
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
): void {
  const plan = planOperation(op);
  const method = resolveMethodName(op, service, ctx);
  const params = buildMethodParams(op, plan, modelMap, ctx);
  const returnType = getReturnType(plan, ctx);

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
    lines.push('        $response = $this->client->request(');
    lines.push(`            method: '${httpMethod}',`);
    lines.push(`            path: ${path},`);
    if (queryLines.length > 0) {
      lines.push('            query: $query,');
    }
    lines.push('            options: $options,');
    lines.push('        );');

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
      lines.push(`        return PaginatedResponse::fromArray($response, ${itemClass}::class);`);
    } else {
      lines.push('        return PaginatedResponse::fromArray($response);');
    }
  } else if (plan.isDelete) {
    // Build body if the operation has a request body (e.g., DELETE with criteria)
    if (plan.hasBody) {
      const bodyModel = op.requestBody?.kind === 'model' ? modelMap.get(op.requestBody.name) : null;
      const bodyParamMap = buildBodyParamMap(op, bodyModel ?? null);
      const hasOptionalFields = bodyModel?.fields.some((f) => !f.required) ?? false;
      if (hasOptionalFields) {
        lines.push('        $body = array_filter([');
      } else {
        lines.push('        $body = [');
      }
      if (bodyModel) {
        for (const field of bodyModel.fields) {
          const phpName = bodyParamMap.get(field.name) ?? fieldName(field.name);
          lines.push(`            '${field.name}' => $${phpName},`);
        }
      }
      if (hasOptionalFields) {
        lines.push('        ], fn ($v) => $v !== null);');
      } else {
        lines.push('        ];');
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
    const hasOptionalFields = bodyModel?.fields.some((f) => !f.required) ?? false;
    if (hasOptionalFields) {
      lines.push('        $body = array_filter([');
    } else {
      lines.push('        $body = [');
    }
    if (bodyModel) {
      for (const field of bodyModel.fields) {
        const phpName = bodyParamMap.get(field.name) ?? fieldName(field.name);
        lines.push(`            '${field.name}' => $${phpName},`);
      }
    }
    if (hasOptionalFields) {
      lines.push('        ], fn ($v) => $v !== null);');
    } else {
      lines.push('        ];');
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
    const queryLines = buildQueryArray(op);
    if (queryLines.length > 0) {
      const hasOptionalQuery = op.queryParams.some((q) => !q.required);
      if (hasOptionalQuery) {
        lines.push('        $query = array_filter([');
      } else {
        lines.push('        $query = [');
      }
      for (const q of queryLines) {
        lines.push(`            ${q}`);
      }
      if (hasOptionalQuery) {
        lines.push('        ], fn ($v) => $v !== null);');
      } else {
        lines.push('        ];');
      }
    }
    lines.push('        $response = $this->client->request(');
    lines.push(`            method: '${httpMethod}',`);
    lines.push(`            path: ${path},`);
    if (queryLines.length > 0) {
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
): string[] {
  // Collect all params into required/optional buckets to avoid
  // PHP's "required after optional" deprecation.
  const required: string[] = [];
  const optional: string[] = [];
  const usedNames = new Set<string>();

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

function buildQueryArray(op: Operation): string[] {
  return op.queryParams.map((q) => {
    const phpName = fieldName(q.name);
    return `'${q.name}' => $${phpName},`;
  });
}

function collectImports(service: Service, ctx: EmitterContext): string[] {
  const imports = new Set<string>();
  const ns = ctx.namespacePascal;

  for (const op of service.operations) {
    const plan = planOperation(op);
    if (plan.responseModelName && !plan.isPaginated) {
      imports.add(`${ns}\\Resource\\${className(plan.responseModelName)}`);
    }
    if (plan.isPaginated) {
      imports.add(`${ns}\\PaginatedResponse`);
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
