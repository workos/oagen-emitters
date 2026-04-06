import type { Service, Operation, OperationPlan, EmitterContext, GeneratedFile } from '@workos/oagen';
import { planOperation, toSnakeCase } from '@workos/oagen';
import { isListWrapperModel } from './models.js';
import { mapTypeRef, mapTypeRefValue } from './type-map.js';
import { className, fieldName, methodName, resolveClassName } from './naming.js';
import { buildResolvedLookup, lookupMethodName, groupByMount } from '../shared/resolved-ops.js';

/**
 * Resolve the resource class name for a service.
 */
export function resolveResourceClassName(service: Service, ctx: EmitterContext): string {
  return resolveClassName(service, ctx);
}

/**
 * Generate Go resource/service files from IR Service definitions.
 * Each mount group becomes a single .go file with an unexported service struct
 * and exported methods.
 */
export function generateResources(services: Service[], ctx: EmitterContext): GeneratedFile[] {
  if (services.length === 0) return [];

  const files: GeneratedFile[] = [];
  const mountGroups = groupByMount(ctx);

  // If no resolved operations, fall back to raw services
  const entries: Array<{ name: string; operations: Operation[] }> =
    mountGroups.size > 0
      ? [...mountGroups].map(([name, group]) => ({ name, operations: group.operations }))
      : services.map((s) => ({ name: resolveResourceClassName(s, ctx), operations: s.operations }));

  for (const { name: mountName, operations } of entries) {
    if (operations.length === 0) continue;
    const file = generateServiceFile(mountName, operations, ctx);
    if (file) files.push(file);
  }

  return files;
}

function generateServiceFile(mountName: string, operations: Operation[], ctx: EmitterContext): GeneratedFile | null {
  const lines: string[] = [];
  const serviceType = `${lowerFirst(mountName)}Service`;
  const goFile = `${toSnakeCase(mountName)}.go`;

  // Determine which imports are needed
  const needsFmt = operations.some((op) => op.pathParams.length > 0);

  lines.push(`package ${ctx.namespace}`);
  lines.push('');
  lines.push('import (');
  lines.push('\t"context"');
  if (needsFmt) {
    lines.push('\t"fmt"');
  }
  lines.push(')');
  lines.push('');

  // Service struct
  lines.push(`// ${serviceType} handles ${mountName} operations.`);
  lines.push(`type ${serviceType} struct {`);
  lines.push('\tclient *Client');
  lines.push('}');
  lines.push('');

  // Generate params structs and methods for each operation.
  // Deduplicate by method name -- multiple IR operations can resolve to the same
  // Go method name when mounted from different IR services.
  const emittedMethods = new Set<string>();
  for (const op of operations) {
    const plan = planOperation(op);
    const method = resolveGoMethodName(op, ctx);

    if (emittedMethods.has(method)) continue;
    emittedMethods.add(method);

    // Generate params struct if needed
    const paramsStruct = generateParamsStruct(mountName, method, op, plan, ctx);
    if (paramsStruct) {
      lines.push(paramsStruct);
      lines.push('');
    }

    // Generate method
    const methodCode = generateMethod(serviceType, mountName, method, op, plan, ctx);
    lines.push(methodCode);
    lines.push('');
  }

  return {
    path: goFile,
    content: lines.join('\n'),
  };
}

function resolveGoMethodName(op: Operation, ctx: EmitterContext): string {
  const lookup = buildResolvedLookup(ctx);
  const resolved = lookupMethodName(op, lookup);
  if (resolved) return methodName(resolved);
  const httpKey = `${op.httpMethod.toUpperCase()} ${op.path}`;
  const existing = ctx.overlayLookup?.methodByOperation?.get(httpKey);
  if (existing) return methodName(existing.methodName);
  return methodName(op.name);
}

function paramsStructName(mountName: string, method: string): string {
  // Prefix with mount name to avoid cross-file collisions in flat package
  const prefix = className(mountName);
  // If method already starts with the mount name, don't double-prefix
  if (method.startsWith(prefix)) return `${method}Params`;
  return `${prefix}${method}Params`;
}

function generateParamsStruct(
  mountName: string,
  method: string,
  op: Operation,
  plan: OperationPlan,
  ctx: EmitterContext,
): string | null {
  const hasQueryParams = op.queryParams.length > 0;
  const hasBody = plan.hasBody && op.requestBody;

  if (!hasQueryParams && !hasBody) return null;

  const lines: string[] = [];
  const structName = paramsStructName(mountName, method);

  lines.push(`// ${structName} contains the parameters for ${method}.`);
  lines.push(`type ${structName} struct {`);

  // Track emitted field names to avoid duplicates
  const emittedFields = new Set<string>();

  // Body fields (if body is a model)
  if (hasBody && op.requestBody?.kind === 'model') {
    const bodyModel = ctx.spec.models.find((m) => op.requestBody?.kind === 'model' && m.name === op.requestBody.name);
    if (bodyModel) {
      const pathParamNames = new Set(op.pathParams.map((p) => p.name));
      for (const field of bodyModel.fields) {
        if (pathParamNames.has(field.name)) continue;
        const goField = fieldName(field.name);
        if (emittedFields.has(goField)) continue;
        emittedFields.add(goField);
        const isOptional = !field.required;
        const goType = isOptional ? makeOptional(mapTypeRef(field.type)) : mapTypeRef(field.type);
        const jsonTag = field.required ? `json:"${field.name}"` : `json:"${field.name},omitempty"`;
        lines.push(`\t${goField} ${goType} \`${jsonTag}\``);
      }
    }
  } else if (hasBody) {
    // Non-model body (generic)
    lines.push('\tBody interface{} `json:"-"`');
  }

  // Query params (skip any already emitted from body fields)
  for (const param of op.queryParams) {
    const goField = fieldName(param.name);
    if (emittedFields.has(goField)) continue;
    emittedFields.add(goField);
    const isOptional = !param.required;
    const goType = isOptional ? makeOptional(mapTypeRef(param.type)) : mapTypeRef(param.type);
    const urlTag = param.required ? `url:"${param.name}"` : `url:"${param.name},omitempty"`;
    lines.push(`\t${goField} ${goType} \`${urlTag}\``);
  }

  lines.push('}');
  return lines.join('\n');
}

function generateMethod(
  serviceType: string,
  mountName: string,
  method: string,
  op: Operation,
  plan: OperationPlan,
  _ctx: EmitterContext,
): string {
  const lines: string[] = [];
  const isPaginated = plan.isPaginated;
  const isDelete = plan.isDelete;
  const hasBody = plan.hasBody && op.requestBody;
  const hasQueryParams = op.queryParams.length > 0;
  const hasParams = hasBody || hasQueryParams;
  const paramsType = hasParams ? `*${paramsStructName(mountName, method)}` : null;

  // Return type
  let returnType: string;
  if (isPaginated && op.pagination) {
    const itemType = resolveIteratorItemType(op.pagination.itemType, _ctx);
    returnType = `*Iterator[${itemType}]`;
  } else if (isDelete) {
    returnType = 'error';
  } else if (plan.responseModelName) {
    returnType = `(*${className(plan.responseModelName)}, error)`;
  } else {
    returnType = 'error';
  }

  // Build godoc -- wrap multi-line descriptions in // comments
  if (op.description) {
    const descLines = op.description.split('\n').filter((l) => l.trim());
    lines.push(`// ${method} ${lowerFirst(descLines[0])}`);
    for (let i = 1; i < descLines.length; i++) {
      lines.push(`// ${descLines[i].trim()}`);
    }
  }
  if (op.deprecated) {
    lines.push(`//`);
    lines.push(`// Deprecated: this operation is deprecated.`);
  }

  // Method signature
  const params: string[] = ['ctx context.Context'];
  // Path params as positional args
  for (const p of op.pathParams) {
    params.push(`${lowerFirst(fieldName(p.name))} ${mapTypeRefValue(p.type)}`);
  }
  if (paramsType) {
    params.push(`params ${paramsType}`);
  }
  params.push('opts ...RequestOption');

  if (isPaginated) {
    lines.push(`func (s *${serviceType}) ${method}(${params.join(', ')}) ${returnType} {`);
  } else if (isDelete || !plan.responseModelName) {
    lines.push(`func (s *${serviceType}) ${method}(${params.join(', ')}) ${returnType} {`);
  } else {
    lines.push(`func (s *${serviceType}) ${method}(${params.join(', ')}) ${returnType} {`);
  }

  // Build path
  const pathExpr = buildPathExpr(op);

  if (isPaginated && op.pagination) {
    const itemType = resolveIteratorItemType(op.pagination.itemType, _ctx);
    const dataPath = op.pagination.dataPath ? `"${op.pagination.dataPath}"` : `"data"`;
    lines.push(
      `\treturn newIterator[${itemType}](ctx, s.client, "${op.httpMethod.toUpperCase()}", ${pathExpr}, ${hasParams ? 'params' : 'nil'}, ${dataPath}, opts)`,
    );
  } else if (isDelete) {
    lines.push(
      `\t_, err := s.client.request(ctx, "${op.httpMethod.toUpperCase()}", ${pathExpr}, ${hasParams ? 'params' : 'nil'}, nil, opts)`,
    );
    lines.push('\treturn err');
  } else if (plan.responseModelName) {
    const respType = className(plan.responseModelName);
    lines.push(`\tvar result ${respType}`);
    lines.push(
      `\t_, err := s.client.request(ctx, "${op.httpMethod.toUpperCase()}", ${pathExpr}, ${hasBody ? 'params' : 'nil'}, &result, opts)`,
    );
    lines.push('\tif err != nil {');
    lines.push('\t\treturn nil, err');
    lines.push('\t}');
    lines.push('\treturn &result, nil');
  } else {
    lines.push(
      `\t_, err := s.client.request(ctx, "${op.httpMethod.toUpperCase()}", ${pathExpr}, ${hasParams ? 'params' : 'nil'}, nil, opts)`,
    );
    lines.push('\treturn err');
  }

  lines.push('}');
  return lines.join('\n');
}

function buildPathExpr(op: Operation): string {
  if (op.pathParams.length === 0) {
    return `"${op.path}"`;
  }
  // Build fmt.Sprintf expression
  let fmtStr = op.path;
  const args: string[] = [];
  for (const p of op.pathParams) {
    fmtStr = fmtStr.replace(`{${p.name}}`, '%s');
    args.push(lowerFirst(fieldName(p.name)));
  }
  return `fmt.Sprintf("${fmtStr}", ${args.join(', ')})`;
}

function makeOptional(goType: string): string {
  if (goType.startsWith('*') || goType.startsWith('[]') || goType.startsWith('map[')) {
    return goType;
  }
  return `*${goType}`;
}

/**
 * Resolve the iterator item type for pagination. If the item type is a list
 * wrapper model (which we skip in models.ts), unwrap it to the actual data item.
 */
function resolveIteratorItemType(itemType: import('@workos/oagen').TypeRef, ctx: EmitterContext): string {
  if (itemType.kind === 'model') {
    // Check if this is a list wrapper model -- if so, unwrap to its data array's item type
    const model = ctx.spec.models.find((m) => m.name === itemType.name);
    if (model && isListWrapperModel(model)) {
      const dataField = model.fields.find((f) => f.name === 'data');
      if (dataField && dataField.type.kind === 'array' && dataField.type.items.kind === 'model') {
        return className(dataField.type.items.name);
      }
    }
    return className(itemType.name);
  }
  return mapTypeRefValue(itemType);
}

/** Go reserved words that cannot be used as identifiers. */
const GO_RESERVED = new Set([
  'break',
  'case',
  'chan',
  'const',
  'continue',
  'default',
  'defer',
  'else',
  'fallthrough',
  'for',
  'func',
  'go',
  'goto',
  'if',
  'import',
  'interface',
  'map',
  'package',
  'range',
  'return',
  'select',
  'struct',
  'switch',
  'type',
  'var',
]);

function lowerFirst(s: string): string {
  if (!s) return s;
  const result = s.charAt(0).toLowerCase() + s.slice(1);
  // Escape Go reserved words by appending an underscore
  if (GO_RESERVED.has(result)) return `${result}Param`;
  return result;
}
