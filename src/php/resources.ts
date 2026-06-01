import type {
  Service,
  Operation,
  Model,
  EmitterContext,
  GeneratedFile,
  ResolvedOperation,
  Parameter,
} from '@workos/oagen';
import { planOperation, toCamelCase, toPascalCase } from '@workos/oagen';
import { mapTypeRef, mapTypeRefForPHPDoc } from './type-map.js';
import { className, fieldName, resolveMethodName, buildExportedClassNameSet, resolveServiceTarget } from './naming.js';
import { isListWrapperModel } from './models.js';
import {
  groupByMount,
  buildResolvedLookup,
  lookupResolved,
  getOpDefaults,
  getOpInferFromClient,
  collectGroupedParamNames,
  collectBodyFieldTypes,
} from '../shared/resolved-ops.js';
import { generateWrapperMethods } from './wrappers.js';
import { phpDocComment } from './utils.js';
import { buildPhpPathExpression } from './path-expression.js';

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

  const exportedClasses = buildExportedClassNameSet(ctx);
  for (const { name: mountName, operations } of entries) {
    if (operations.length === 0) continue;
    const resourceName = className(resolveServiceTarget(mountName, exportedClasses));
    const mergedService: Service = { name: mountName, operations };
    const lines: string[] = [];

    // No <?php here — the file header from fileHeader() provides it
    lines.push(`namespace ${ctx.namespacePascal}\\Service;`);
    lines.push('');

    // Build resolved lookup early — used by both imports and method generation
    const resolvedLookup = buildResolvedLookup(ctx);

    // Collect imports
    const imports = collectImports(mergedService, ctx, resolvedLookup);
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

    // Generate variant class files for operations with parameter groups
    for (const op of operations) {
      if ((op.parameterGroups?.length ?? 0) > 0) {
        files.push(...generateParameterGroupFiles(op, ctx, modelMap));
      }
    }
  }

  return files;
}

/**
 * Check if an operation is a redirect endpoint that should construct a URL
 * instead of making an HTTP request.
 *
 * Detection: GET endpoints with no response body (primitive unknown) and query
 * params are redirect endpoints (e.g., SSO/OAuth authorize and logout flows).
 * Also respects an explicit urlBuilder flag on the resolved operation and
 * catches endpoints with 302 success responses.
 */
export function isRedirectEndpoint(op: Operation, resolvedOp?: ResolvedOperation): boolean {
  if ((resolvedOp as any)?.urlBuilder) return true;
  if ((op as any).successResponses?.some((r: any) => r.statusCode >= 300 && r.statusCode < 400)) return true;
  if (
    op.httpMethod === 'get' &&
    op.response.kind === 'primitive' &&
    (op.response as any).type === 'unknown' &&
    op.queryParams.length > 0
  ) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Mutually-exclusive parameter group support
// ---------------------------------------------------------------------------

/** PHP class name for a parameter group variant (e.g. ParentResourceById). */
function groupVariantClassName(groupName: string, variantName: string): string {
  return `${className(groupName)}${className(variantName)}`;
}

/**
 * Derive a short PHP property name for a parameter within a variant class.
 * Strips the group name prefix when present to avoid stuttering
 * (e.g. parent_resource_id in group parent_resource -> id -> camelCase).
 */
export function deriveVariantFieldName(paramName: string, groupName: string): string {
  const prefix = groupName + '_';
  const stripped = paramName.startsWith(prefix) ? paramName.slice(prefix.length) : paramName;
  return fieldName(stripped);
}

/**
 * Generate PHP variant class files for all parameter groups on an operation.
 * Each variant becomes a simple PHP class with readonly constructor properties.
 */
function generateParameterGroupFiles(
  op: Operation,
  ctx: EmitterContext,
  modelMap: Map<string, Model>,
): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const bodyFieldTypes = collectBodyFieldTypes(op, [...modelMap.values()]);

  for (const group of op.parameterGroups ?? []) {
    for (const variant of group.variants) {
      const variantClass = groupVariantClassName(group.name, variant.name);
      const lines: string[] = [];

      lines.push(`namespace ${ctx.namespacePascal}\\Service;`);
      lines.push('');
      lines.push(`class ${variantClass}`);
      lines.push('{');
      lines.push('    public function __construct(');
      for (let i = 0; i < variant.parameters.length; i++) {
        const param = variant.parameters[i];
        const effectiveType = bodyFieldTypes.get(param.name) ?? param.type;
        const phpType = mapTypeRef(effectiveType, { qualified: true });
        const phpName = deriveVariantFieldName(param.name, group.name);
        const comma = ',';
        lines.push(`        public readonly ${phpType} $${phpName}${comma}`);
      }
      lines.push('    ) {');
      lines.push('    }');
      lines.push('}');

      files.push({
        path: `lib/Service/${variantClass}.php`,
        content: lines.join('\n'),
        overwriteExisting: true,
      });
    }
  }

  return files;
}

/**
 * Generate instanceof dispatch lines to serialize a grouped parameter
 * into a target array ($query or $body) using each variant's wire names.
 */
function generateGroupDispatch(op: Operation, indent: string, target: '$query' | '$body' = '$query'): string[] {
  const lines: string[] = [];

  for (const group of op.parameterGroups ?? []) {
    const phpParamName = fieldName(group.name);

    for (let vi = 0; vi < group.variants.length; vi++) {
      const variant = group.variants[vi];
      const variantClass = groupVariantClassName(group.name, variant.name);
      const keyword = vi === 0 ? 'if' : 'elseif';

      lines.push(`${indent}${keyword} ($${phpParamName} instanceof ${variantClass}) {`);

      for (const param of variant.parameters) {
        const phpField = deriveVariantFieldName(param.name, group.name);
        lines.push(`${indent}    ${target}['${param.name}'] = $${phpParamName}->${phpField};`);
      }

      lines.push(`${indent}}`);
    }
  }

  return lines;
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

  const isRedirect = isRedirectEndpoint(op, resolvedOp);
  const materializeQueryDefaults = !isRedirect;
  const params = buildMethodParams(op, plan, modelMap, ctx, hiddenParams, { materializeQueryDefaults });
  const returnType = isRedirect ? 'string' : getReturnType(plan, ctx);

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
  const groupedParamNames = collectGroupedParamNames(op);
  if (plan.hasBody && op.requestBody?.kind === 'model') {
    const bodyModel = modelMap.get(op.requestBody.name);
    if (bodyModel) {
      const bodyParamMap = buildBodyParamMap(op, bodyModel);
      for (const field of bodyModel.fields) {
        if (hiddenParams.has(field.name)) continue;
        if (groupedParamNames.has(field.name)) continue;
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

  // @param for parameter groups (union-typed)
  for (const group of op.parameterGroups ?? []) {
    const phpName = fieldName(group.name);
    if (seenDocParams.has(phpName)) continue;
    seenDocParams.add(phpName);
    const variantTypes = group.variants.map((v) => groupVariantClassName(group.name, v.name));
    const unionDocType = variantTypes.join('|');
    const nullPrefix = group.optional ? 'null|' : '';
    docParts.push(`@param ${nullPrefix}${unionDocType} $${phpName}`);
  }

  // @param for query params (skip grouped params — they appear as group union params)
  for (const q of op.queryParams) {
    if (hiddenParams.has(q.name)) continue;
    if (groupedParamNames.has(q.name)) continue;
    const docType = mapTypeRefForPHPDoc(q.type);
    const phpName = fieldName(q.name);
    if (seenDocParams.has(phpName)) continue;
    seenDocParams.add(phpName);
    // Spec-defaulted enum params on HTTP calls are non-nullable because the
    // signature default is the enum case. URL builders keep them nullable so
    // omitted optional query params stay omitted from the generated URL.
    const hasEnumDefault = shouldMaterializeQueryDefault(q, materializeQueryDefaults);
    const nullSuffix = !q.required && !hasEnumDefault && !docType.endsWith('|null') ? '|null' : '';
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

  // @throws — scope to what the method actually calls
  if (!isRedirect) {
    // HTTP methods can throw any WorkOSException (config, transport, API response)
    docParts.push(`@throws \\${ctx.namespacePascal}\\Exception\\WorkOSException`);
  } else if (getOpInferFromClient(resolvedOp).length > 0) {
    // Redirect endpoints that inject client fields can throw ConfigurationException
    docParts.push(`@throws \\${ctx.namespacePascal}\\Exception\\ConfigurationException`);
  }
  // Redirect endpoints with no inferFromClient: buildUrl() is pure, no @throws

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

  if (isRedirect) {
    // Redirect endpoint: construct URL client-side instead of making HTTP request
    const queryLines = buildQueryArray(op, hiddenParams, { materializeQueryDefaults });
    const hasDefaults = Object.keys(getOpDefaults(resolvedOp)).length > 0;
    const hasInferred = getOpInferFromClient(resolvedOp).length > 0;
    const hasGroups = (op.parameterGroups?.length ?? 0) > 0;
    const needsQuery = queryLines.length > 0 || hasDefaults || hasInferred || hasGroups;

    if (needsQuery) {
      const groupedParams = collectGroupedParamNames(op);
      const hasOptionalQuery = op.queryParams.some(
        (q) => !q.required && !hiddenParams.has(q.name) && !groupedParams.has(q.name),
      );
      if (hasOptionalQuery) {
        lines.push('        $query = array_filter([');
      } else if (queryLines.length > 0) {
        lines.push('        $query = [');
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
      // Inject parameter group dispatch (instanceof checks)
      lines.push(...generateGroupDispatch(op, '        '));
      lines.push(`        return $this->client->buildUrl(path: ${path}, query: $query, options: $options);`);
    } else {
      lines.push(`        return $this->client->buildUrl(path: ${path}, query: [], options: $options);`);
    }
  } else if (plan.isPaginated) {
    const queryLines = buildQueryArray(op);
    const hasGroups = (op.parameterGroups?.length ?? 0) > 0;
    const needsQuery = queryLines.length > 0 || hasGroups;
    if (needsQuery) {
      if (queryLines.length > 0) {
        lines.push('        $query = array_filter([');
        for (const q of queryLines) {
          lines.push(`            ${q}`);
        }
        lines.push('        ], fn ($v) => $v !== null);');
      } else {
        lines.push('        $query = [];');
      }
      // Inject parameter group dispatch (instanceof checks)
      lines.push(...generateGroupDispatch(op, '        '));
    }
    lines.push('        return $this->client->requestPage(');
    lines.push(`            method: '${httpMethod}',`);
    lines.push(`            path: ${path},`);
    if (needsQuery) {
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
      const deleteGroupedParams = collectGroupedParamNames(op);
      const visibleFields =
        bodyModel?.fields.filter((f) => !hiddenParams.has(f.name) && !deleteGroupedParams.has(f.name)) ?? [];
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
      // Inject parameter group dispatch into body
      if ((op.parameterGroups?.length ?? 0) > 0) {
        lines.push(...generateGroupDispatch(op, '        ', '$body'));
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
    const bodyGroupedParams = collectGroupedParamNames(op);
    const visibleFields =
      bodyModel?.fields.filter((f) => !hiddenParams.has(f.name) && !bodyGroupedParams.has(f.name)) ?? [];
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
    // Inject parameter group dispatch into body so sensitive fields
    // (passwords, role slugs) never leak into the URL query string.
    if ((op.parameterGroups?.length ?? 0) > 0) {
      lines.push(...generateGroupDispatch(op, '        ', '$body'));
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
    const hasGroups = (op.parameterGroups?.length ?? 0) > 0;
    const needsQuery = queryLines.length > 0 || hasDefaults || hasInferred || hasGroups;

    if (needsQuery) {
      const groupedParams = collectGroupedParamNames(op);
      const hasOptionalQuery = op.queryParams.some(
        (q) => !q.required && !hiddenParams.has(q.name) && !groupedParams.has(q.name),
      );
      if (hasOptionalQuery) {
        lines.push('        $query = array_filter([');
      } else if (queryLines.length > 0) {
        lines.push('        $query = [');
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
      // Inject parameter group dispatch (instanceof checks)
      lines.push(...generateGroupDispatch(op, '        '));
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
  opts?: { materializeQueryDefaults?: boolean },
): string[] {
  // Collect all params into required/optional buckets to avoid
  // PHP's "required after optional" deprecation.
  const required: string[] = [];
  const optional: string[] = [];
  const usedNames = new Set<string>();
  const hidden = hiddenParams ?? new Set();
  const groupedParams = collectGroupedParamNames(op);
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
        if (groupedParams.has(field.name)) continue;
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

  // Parameter group union-typed params (before individual query params)
  for (const group of op.parameterGroups ?? []) {
    const phpName = fieldName(group.name);
    if (usedNames.has(phpName)) continue;
    usedNames.add(phpName);
    // PHP 8.0+ union syntax: VariantA|VariantB $paramName
    const variantTypes = group.variants.map((v) => groupVariantClassName(group.name, v.name));
    const unionType = variantTypes.join('|');
    if (group.optional) {
      optional.push(`null|${unionType} $${phpName} = null`);
    } else {
      required.push(`${unionType} $${phpName}`);
    }
  }

  // Query params (skip grouped params — they are serialized via group dispatch)
  for (const q of op.queryParams) {
    if (hidden.has(q.name)) continue;
    if (groupedParams.has(q.name)) continue;
    const phpType = mapTypeRef(q.type, { qualified: true });
    let phpName = fieldName(q.name);
    if (usedNames.has(phpName)) continue;
    usedNames.add(phpName);
    if (q.required) {
      required.push(`${phpType} $${phpName}`);
    } else if (shouldMaterializeQueryDefault(q, opts?.materializeQueryDefaults ?? true)) {
      // Spec-provided default for an enum-typed param: emit a non-nullable
      // typed default (e.g. PaginationOrder $order = PaginationOrder::Desc).
      // Only enums are safe to default this way — primitives stay nullable so
      // callers can distinguish "unset" from "explicit value".
      const enumType = mapTypeRef(q.type, { qualified: true });
      const caseName = toPascalCase(String(q.default));
      optional.push(`${enumType} $${phpName} = ${enumType}::${caseName}`);
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
  const valueAccessor = new Set<string>();
  for (const p of op.pathParams) {
    if (p.type.kind === 'enum' || p.type.kind === 'model') valueAccessor.add(p.name);
  }
  return buildPhpPathExpression(op.path, { valueAccessorParams: valueAccessor });
}

function isEnumType(ref: import('@workos/oagen').TypeRef): boolean {
  if (ref.kind === 'enum') return true;
  if (ref.kind === 'nullable') return isEnumType(ref.inner);
  return false;
}

function isDateTimeType(ref: import('@workos/oagen').TypeRef): boolean {
  if (ref.kind === 'primitive' && ref.format === 'date-time') return true;
  if (ref.kind === 'nullable') return isDateTimeType(ref.inner);
  return false;
}

function buildQueryArray(
  op: Operation,
  hiddenParams?: Set<string>,
  opts?: { materializeQueryDefaults?: boolean },
): string[] {
  const hidden = hiddenParams ?? new Set();
  const groupedParams = collectGroupedParamNames(op);
  return op.queryParams
    .filter((q) => !hidden.has(q.name) && !groupedParams.has(q.name))
    .map((q) => {
      const phpName = fieldName(q.name);
      if (isEnumType(q.type)) {
        // Mirrors the signature: only materialized enum defaults are
        // non-nullable, so other optional enum params use the nullsafe op.
        const hasEnumDefault = shouldMaterializeQueryDefault(q, opts?.materializeQueryDefaults ?? true);
        const nullsafe = q.required || hasEnumDefault ? '' : '?';
        return `'${q.name}' => $${phpName}${nullsafe}->value,`;
      }
      if (isDateTimeType(q.type)) {
        const nullsafe = q.required ? '' : '?';
        return `'${q.name}' => $${phpName}${nullsafe}->format(\\DateTimeInterface::RFC3339_EXTENDED),`;
      }
      return `'${q.name}' => $${phpName},`;
    });
}

function shouldMaterializeQueryDefault(param: Parameter, enabled: boolean): boolean {
  return enabled && param.default != null && param.type.kind === 'enum';
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

function collectImports(
  service: Service,
  ctx: EmitterContext,
  resolvedLookup?: Map<string, ResolvedOperation>,
): string[] {
  const imports = new Set<string>();
  const ns = ctx.namespacePascal;

  for (const op of service.operations) {
    const plan = planOperation(op);
    const resolved = resolvedLookup ? lookupResolved(op, resolvedLookup) : undefined;
    if (plan.responseModelName && !plan.isPaginated && !isRedirectEndpoint(op, resolved)) {
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
