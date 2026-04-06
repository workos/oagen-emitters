import type { Service, Operation, OperationPlan, EmitterContext, GeneratedFile } from '@workos/oagen';
import { planOperation, toSnakeCase } from '@workos/oagen';
import { isListWrapperModel } from './models.js';
import { mapTypeRef, mapTypeRefValue } from './type-map.js';
import { className, fieldName, methodName, resolveClassName, resolveMethodName, unexportedName } from './naming.js';
import { buildResolvedLookup, lookupResolved, groupByMount } from '../shared/resolved-ops.js';
import { generateWrapperMethods } from './wrappers.js';

/**
 * Return path params sorted by their first occurrence in the URL template.
 * This ensures fmt.Sprintf args and function signatures match template order.
 */
export function sortPathParamsByTemplateOrder(op: Operation): typeof op.pathParams {
  return [...op.pathParams].sort((a, b) => {
    const posA = op.path.indexOf(`{${a.name}}`);
    const posB = op.path.indexOf(`{${b.name}}`);
    return posA - posB;
  });
}

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
  const serviceType = serviceTypeName(mountName);
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
    const method = resolveGoMethodName(op, mountName, ctx);

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

    // Generate union split wrapper methods (e.g., AuthenticateWithPassword)
    const resolvedLookup = buildResolvedLookup(ctx);
    const resolved = lookupResolved(op, resolvedLookup);
    if (resolved?.wrappers && resolved.wrappers.length > 0) {
      const wrapperLines = generateWrapperMethods(serviceType, resolved, ctx);
      lines.push(...wrapperLines);
      for (const w of resolved.wrappers) {
        emittedMethods.add(methodName(w.name));
      }
    }
  }

  return {
    path: goFile,
    content: lines.join('\n'),
    overwriteExisting: true,
  };
}

function resolveGoMethodName(op: Operation, mountName: string, ctx: EmitterContext): string {
  return resolveMethodName(op, { name: mountName, operations: [op] }, ctx);
}

export function paramsStructName(mountName: string, method: string): string {
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
      for (const field of bodyModel.fields) {
        const goField = fieldName(field.name);
        if (emittedFields.has(goField)) continue;
        emittedFields.add(goField);
        const isOptional = !field.required;
        const goType = isOptional ? makeOptional(mapTypeRef(field.type)) : mapTypeRef(field.type);
        const jsonTag = field.required ? `json:"${field.name}"` : `json:"${field.name},omitempty"`;
        // If this field also appears in query params, emit a url tag too
        const isAlsoQueryParam = op.queryParams.some((qp) => fieldName(qp.name) === goField);
        const urlTag = isAlsoQueryParam ? ` url:"${field.name}${field.required ? '' : ',omitempty'}"` : '';
        if (field.description) {
          const fdLines = field.description.split('\n').filter((l) => l.trim());
          lines.push(`\t// ${goField} is ${lowerFirstDesc(fdLines[0])}`);
          for (let i = 1; i < fdLines.length; i++) {
            lines.push(`\t// ${fdLines[i].trim()}`);
          }
        }
        if (field.deprecated) {
          if (field.description) lines.push(`\t//`);
          lines.push(`\t// Deprecated: this field is deprecated.`);
        }
        lines.push(`\t${goField} ${goType} \`${jsonTag}${urlTag}\``);
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
    const paramType = mapQueryParamType(param.name, param.type);
    const goType = isOptional ? makeOptional(paramType) : paramType;
    const urlTag = param.required ? `url:"${param.name}"` : `url:"${param.name},omitempty"`;
    const jsonTag = 'json:"-"';
    if (param.description) {
      const pdLines = param.description.split('\n').filter((l) => l.trim());
      lines.push(`\t// ${goField} is ${lowerFirstDesc(pdLines[0])}`);
      for (let i = 1; i < pdLines.length; i++) {
        lines.push(`\t// ${pdLines[i].trim()}`);
      }
    }
    if (param.deprecated) {
      if (param.description) lines.push(`\t//`);
      lines.push(`\t// Deprecated: this parameter is deprecated.`);
    }
    lines.push(`\t${goField} ${goType} \`${urlTag} ${jsonTag}\``);
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
  const bodyArg = hasBody ? bodyArgument(op) : 'nil';

  // Detect if response is a raw array (not paginated)
  const isArrayResponse = !isPaginated && op.response?.kind === 'array';

  // Return type
  let returnType: string;
  if (isPaginated && op.pagination) {
    const itemType = resolveIteratorItemType(op.pagination.itemType, _ctx);
    returnType = `*Iterator[${itemType}]`;
  } else if (isDelete) {
    returnType = 'error';
  } else if (plan.responseModelName) {
    const respType = className(plan.responseModelName);
    if (isArrayResponse) {
      returnType = `([]${respType}, error)`;
    } else {
      returnType = `(*${respType}, error)`;
    }
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
  for (const p of op.pathParams) {
    if (p.deprecated) {
      lines.push(`//`);
      lines.push(`// Deprecated parameter ${fieldName(p.name)}${p.description ? ': ' + p.description : '.'}`);
    }
  }
  if (op.deprecated) {
    lines.push(`//`);
    lines.push(`// Deprecated: this operation is deprecated.`);
  }

  // Method signature
  const params: string[] = ['ctx context.Context'];
  // Path params as positional args (sorted by template order)
  for (const p of sortPathParamsByTemplateOrder(op)) {
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
    const cursorParam = '"after"';
    lines.push(
      `\treturn newIterator[${itemType}](ctx, s.client, "${op.httpMethod.toUpperCase()}", ${pathExpr}, ${hasQueryParams ? 'params' : 'nil'}, ${cursorParam}, ${dataPath}, opts)`,
    );
  } else if (isDelete) {
    lines.push(
      `\t_, err := s.client.request(ctx, "${op.httpMethod.toUpperCase()}", ${pathExpr}, ${hasQueryParams ? 'params' : 'nil'}, ${bodyArg}, nil, opts)`,
    );
    lines.push('\treturn err');
  } else if (plan.responseModelName) {
    const respType = className(plan.responseModelName);
    if (isArrayResponse) {
      lines.push(`\tvar result []${respType}`);
      lines.push(
        `\t_, err := s.client.request(ctx, "${op.httpMethod.toUpperCase()}", ${pathExpr}, ${hasQueryParams ? 'params' : 'nil'}, ${bodyArg}, &result, opts)`,
      );
      lines.push('\tif err != nil {');
      lines.push('\t\treturn nil, err');
      lines.push('\t}');
      lines.push('\treturn result, nil');
    } else {
      lines.push(`\tvar result ${respType}`);
      lines.push(
        `\t_, err := s.client.request(ctx, "${op.httpMethod.toUpperCase()}", ${pathExpr}, ${hasQueryParams ? 'params' : 'nil'}, ${bodyArg}, &result, opts)`,
      );
      lines.push('\tif err != nil {');
      lines.push('\t\treturn nil, err');
      lines.push('\t}');
      lines.push('\treturn &result, nil');
    }
  } else {
    lines.push(
      `\t_, err := s.client.request(ctx, "${op.httpMethod.toUpperCase()}", ${pathExpr}, ${hasQueryParams ? 'params' : 'nil'}, ${bodyArg}, nil, opts)`,
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
  // Build fmt.Sprintf expression (sorted by template order)
  let fmtStr = op.path;
  const args: string[] = [];
  for (const p of sortPathParamsByTemplateOrder(op)) {
    fmtStr = fmtStr.replace(`{${p.name}}`, '%s');
    args.push(lowerFirst(fieldName(p.name)));
  }
  return `fmt.Sprintf("${fmtStr}", ${args.join(', ')})`;
}

function bodyArgument(op: Operation): string {
  if (op.requestBody?.kind === 'model') {
    return 'params';
  }
  return 'params.Body';
}

function mapQueryParamType(name: string, type: import('@workos/oagen').TypeRef): string {
  if (name === 'limit' && type.kind === 'primitive' && (type.type === 'integer' || type.type === 'number')) {
    return 'int';
  }
  return mapTypeRef(type);
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
  const result = unexportedName(s);
  // Escape Go reserved words by appending an underscore
  if (GO_RESERVED.has(result)) return `${result}Param`;
  return result;
}

/** Simple lowercase-first for human-readable descriptions (not identifiers). */
function lowerFirstDesc(s: string): string {
  if (!s) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function singularizePascal(name: string): string {
  if (name.endsWith('ies')) {
    return `${name.slice(0, -3)}y`;
  }
  if (name.endsWith('s') && !name.endsWith('ss')) {
    return name.slice(0, -1);
  }
  return name;
}

function serviceTypeName(name: string): string {
  return `${unexportedName(singularizePascal(name))}Service`;
}
