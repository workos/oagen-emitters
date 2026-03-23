// @oagen-ignore: Operation.async — all TypeScript SDK methods are async by nature

import type { Service, Operation, EmitterContext, GeneratedFile } from '@workos/oagen';
import { planOperation, toPascalCase } from '@workos/oagen';
import type { OperationPlan } from '@workos/oagen';
import { mapTypeRef } from './type-map.js';
import {
  fieldName,
  fileName,
  serviceDirName,
  resolveMethodName,
  resolveInterfaceName,
  resolveServiceName,
  buildServiceNameMap,
  wireInterfaceName,
} from './naming.js';
import { collectModelRefs, assignModelsToServices, docComment } from './utils.js';
import { assignEnumsToServices } from './enums.js';

/** Standard pagination query params handled by PaginationOptions — not imported individually. */
const PAGINATION_PARAM_NAMES = new Set(['limit', 'before', 'after', 'order']);

/** HTTP methods that require a body argument even when the spec has no request body. */
function httpMethodNeedsBody(method: string): boolean {
  return method === 'post' || method === 'put' || method === 'patch';
}

export function generateResources(services: Service[], ctx: EmitterContext): GeneratedFile[] {
  if (services.length === 0) return [];
  return services.map((service) => generateResourceClass(service, ctx));
}

function generateResourceClass(service: Service, ctx: EmitterContext): GeneratedFile {
  const resolvedName = resolveServiceName(service, ctx);
  const serviceDir = serviceDirName(resolvedName);
  const serviceClass = resolvedName;
  const resourcePath = `src/${serviceDir}/${fileName(resolvedName)}.ts`;

  const plans = service.operations.map((op) => ({
    op,
    plan: planOperation(op),
    method: resolveMethodName(op, service, ctx),
  }));

  const hasPaginated = plans.some((p) => p.plan.isPaginated);

  // Collect models for imports
  const responseModels = new Set<string>();
  const requestModels = new Set<string>();
  const paramEnums = new Set<string>();
  const paramModels = new Set<string>();
  for (const { op, plan } of plans) {
    if (plan.responseModelName) responseModels.add(plan.responseModelName);
    if (op.requestBody) {
      for (const name of collectModelRefs(op.requestBody)) {
        requestModels.add(name);
      }
    }
    // Collect types referenced in query and path parameters.
    // For paginated operations, skip standard pagination params (limit, before, after, order)
    // since they're handled by PaginationOptions and don't need explicit imports.
    const queryParams = plan.isPaginated
      ? op.queryParams.filter((p) => !PAGINATION_PARAM_NAMES.has(p.name))
      : op.queryParams;
    for (const param of [...queryParams, ...op.pathParams]) {
      if (param.type.kind === 'enum') {
        paramEnums.add(param.type.name);
      } else if (param.type.kind === 'model') {
        paramModels.add(param.type.name);
      }
    }
  }
  const allModels = new Set([...responseModels, ...requestModels, ...paramModels]);

  const lines: string[] = [];

  // Imports
  lines.push("import type { WorkOS } from '../workos';");
  if (hasPaginated) {
    lines.push("import type { PaginationOptions } from '../common/interfaces/pagination-options.interface';");
    lines.push("import { AutoPaginatable } from '../common/utils/pagination';");
    lines.push("import { fetchAndDeserialize } from '../common/utils/fetch-and-deserialize';");
  }

  // Check if any operation needs PostOptions (idempotent POST or custom encoding)
  const hasIdempotentPost = plans.some((p) => p.plan.isIdempotentPost);
  const hasCustomEncoding = plans.some(
    (p) => p.op.requestBodyEncoding && p.op.requestBodyEncoding !== 'json' && p.plan.hasBody,
  );
  if (hasIdempotentPost || hasCustomEncoding) {
    lines.push("import type { PostOptions } from '../common/interfaces/post-options.interface';");
  }

  // Compute model-to-service mapping for correct cross-service import paths
  const modelToService = assignModelsToServices(ctx.spec.models, ctx.spec.services);
  const serviceNameMap = buildServiceNameMap(ctx.spec.services, ctx);
  const resolveDir = (irService: string | undefined) =>
    irService ? serviceDirName(serviceNameMap.get(irService) ?? irService) : 'common';

  // Track imported resolved names to prevent duplicate type name collisions
  const importedTypeNames = new Set<string>();
  for (const name of allModels) {
    const resolved = resolveInterfaceName(name, ctx);
    if (importedTypeNames.has(resolved)) continue; // Skip duplicate resolved names
    importedTypeNames.add(resolved);
    const modelDir = modelToService.get(name);
    const modelServiceDir = resolveDir(modelDir);
    const relPath =
      modelServiceDir === serviceDir
        ? `./interfaces/${fileName(name)}.interface`
        : `../${modelServiceDir}/interfaces/${fileName(name)}.interface`;
    lines.push(`import type { ${resolved}, ${wireInterfaceName(resolved)} } from '${relPath}';`);
  }

  const importedDeserializers = new Set<string>();
  for (const name of responseModels) {
    const resolved = resolveInterfaceName(name, ctx);
    if (importedDeserializers.has(resolved)) continue;
    importedDeserializers.add(resolved);
    const modelDir = modelToService.get(name);
    const modelServiceDir = resolveDir(modelDir);
    const relPath =
      modelServiceDir === serviceDir
        ? `./serializers/${fileName(name)}.serializer`
        : `../${modelServiceDir}/serializers/${fileName(name)}.serializer`;
    lines.push(`import { deserialize${resolved} } from '${relPath}';`);
  }

  const importedSerializers = new Set<string>();
  for (const name of requestModels) {
    const resolved = resolveInterfaceName(name, ctx);
    if (importedSerializers.has(resolved)) continue;
    importedSerializers.add(resolved);
    const modelDir = modelToService.get(name);
    const modelServiceDir = resolveDir(modelDir);
    const relPath =
      modelServiceDir === serviceDir
        ? `./serializers/${fileName(name)}.serializer`
        : `../${modelServiceDir}/serializers/${fileName(name)}.serializer`;
    lines.push(`import { serialize${resolved} } from '${relPath}';`);
  }

  // Import enum types referenced in query/path parameters.
  // Only import enums that actually exist in the spec's global enums list —
  // inline string unions may have kind 'enum' but no corresponding file.
  if (paramEnums.size > 0) {
    const specEnumNames = new Set(ctx.spec.enums.map((e) => e.name));
    const enumToService = assignEnumsToServices(ctx.spec.enums, ctx.spec.services);
    for (const name of paramEnums) {
      if (allModels.has(name)) continue; // Already imported as a model
      if (!specEnumNames.has(name)) continue; // No file generated for this enum
      const enumDir = enumToService.get(name);
      const enumServiceDir = resolveDir(enumDir);
      const relPath =
        enumServiceDir === serviceDir
          ? `./interfaces/${fileName(name)}.interface`
          : `../${enumServiceDir}/interfaces/${fileName(name)}.interface`;
      lines.push(`import type { ${name} } from '${relPath}';`);
    }
  }

  lines.push('');

  // List options interfaces for paginated operations with extra query params
  for (const { op, plan, method } of plans) {
    if (plan.isPaginated) {
      const extraParams = op.queryParams.filter((p) => !PAGINATION_PARAM_NAMES.has(p.name));
      if (extraParams.length > 0) {
        const optionsName = toPascalCase(method) + 'Options';
        lines.push(`export interface ${optionsName} extends PaginationOptions {`);
        for (const param of extraParams) {
          const opt = !param.required ? '?' : '';
          if (param.description || param.deprecated) {
            const parts: string[] = [];
            if (param.description) parts.push(param.description);
            if (param.deprecated) parts.push('@deprecated');
            lines.push(...docComment(parts.join('\n'), 2));
          }
          lines.push(`  ${fieldName(param.name)}${opt}: ${mapTypeRef(param.type)};`);
        }
        lines.push('}');
        lines.push('');
      }
    }
  }

  // Resource class
  if (service.description) {
    lines.push(...docComment(service.description));
  }
  lines.push(`export class ${serviceClass} {`);
  lines.push('  constructor(private readonly workos: WorkOS) {}');

  for (const { op, plan, method } of plans) {
    lines.push('');
    lines.push(...renderMethod(op, plan, method, service, ctx));
  }

  lines.push('}');

  return { path: resourcePath, content: lines.join('\n'), skipIfExists: true };
}

function renderMethod(
  op: Operation,
  plan: OperationPlan,
  method: string,
  service: Service,
  ctx: EmitterContext,
): string[] {
  const lines: string[] = [];
  const responseModel = plan.responseModelName ? resolveInterfaceName(plan.responseModelName, ctx) : null;

  // Path interpolation: replace {param} with ${param}
  const interpolatedPath = op.path.replace(/\{(\w+)\}/g, (_, p) => `\${${fieldName(p)}}`);
  const usesTemplate = interpolatedPath.includes('${');
  const pathStr = usesTemplate ? `\`${interpolatedPath}\`` : `'${op.path}'`;

  // Build set of valid param names from the overlay (existing method signature)
  // to filter out @param tags that don't match the actual method params
  const httpKey = `${op.httpMethod.toUpperCase()} ${op.path}`;
  const overlayMethod = ctx.overlayLookup?.methodByOperation?.get(httpKey);
  const validParamNames = overlayMethod ? new Set(overlayMethod.params.map((p) => p.name)) : null;

  const docParts: string[] = [];
  if (op.description) docParts.push(op.description);
  for (const param of op.pathParams) {
    const paramName = fieldName(param.name);
    // Skip @param if the overlay method exists and doesn't have this param
    if (validParamNames && !validParamNames.has(paramName)) continue;
    const deprecatedPrefix = param.deprecated ? '(deprecated) ' : '';
    if (param.description) {
      docParts.push(`@param ${paramName} - ${deprecatedPrefix}${param.description}`);
    } else if (param.deprecated) {
      docParts.push(`@param ${paramName} - (deprecated)`);
    }
    if (param.default !== undefined) docParts.push(`@default ${JSON.stringify(param.default)}`);
    if (param.example !== undefined) docParts.push(`@example ${JSON.stringify(param.example)}`);
  }
  // Document query params for non-paginated operations
  if (!plan.isPaginated) {
    for (const param of op.queryParams) {
      const paramName = `options.${fieldName(param.name)}`;
      // Skip @param if the overlay method exists and doesn't have a matching param
      if (validParamNames && !validParamNames.has('options') && !validParamNames.has(fieldName(param.name))) continue;
      const deprecatedPrefix = param.deprecated ? '(deprecated) ' : '';
      if (param.description) {
        docParts.push(`@param ${paramName} - ${deprecatedPrefix}${param.description}`);
      } else if (param.deprecated) {
        docParts.push(`@param ${paramName} - (deprecated)`);
      }
      if (param.default !== undefined) docParts.push(`@default ${JSON.stringify(param.default)}`);
      if (param.example !== undefined) docParts.push(`@example ${JSON.stringify(param.example)}`);
    }
  }
  // Document header params
  for (const param of op.headerParams) {
    const deprecatedPrefix = param.deprecated ? '(deprecated) ' : '';
    if (param.description) {
      docParts.push(`@param ${fieldName(param.name)} - ${deprecatedPrefix}${param.description}`);
    } else if (param.deprecated) {
      docParts.push(`@param ${fieldName(param.name)} - (deprecated)`);
    }
    if (param.default !== undefined) docParts.push(`@default ${JSON.stringify(param.default)}`);
    if (param.example !== undefined) docParts.push(`@example ${JSON.stringify(param.example)}`);
  }
  // Document cookie params
  if (op.cookieParams) {
    for (const param of op.cookieParams) {
      const deprecatedPrefix = param.deprecated ? '(deprecated) ' : '';
      if (param.description) {
        docParts.push(`@param ${fieldName(param.name)} - ${deprecatedPrefix}${param.description}`);
      } else if (param.deprecated) {
        docParts.push(`@param ${fieldName(param.name)} - (deprecated)`);
      }
      if (param.default !== undefined) docParts.push(`@default ${JSON.stringify(param.default)}`);
      if (param.example !== undefined) docParts.push(`@example ${JSON.stringify(param.example)}`);
    }
  }
  // @returns for the primary response model
  if (responseModel) {
    docParts.push(`@returns {${responseModel}}`);
  }
  if (op.deprecated) docParts.push('@deprecated');

  if (docParts.length > 0) {
    // Flatten all parts, splitting multiline descriptions into individual lines
    const allLines: string[] = [];
    for (const part of docParts) {
      for (const line of part.split('\n')) {
        allLines.push(line);
      }
    }
    if (allLines.length === 1) {
      lines.push(`  /** ${allLines[0]} */`);
    } else {
      lines.push('  /**');
      for (const line of allLines) {
        lines.push(line === '' ? '   *' : `   * ${line}`);
      }
      lines.push('   */');
    }
  }

  const preDecisionCount = lines.length;

  if (plan.isPaginated && responseModel) {
    renderPaginatedMethod(lines, op, plan, method, responseModel);
  } else if (plan.isDelete && plan.hasBody) {
    renderDeleteWithBodyMethod(lines, op, plan, method, pathStr, ctx);
  } else if (plan.isDelete) {
    renderDeleteMethod(lines, op, plan, method, pathStr);
  } else if (plan.hasBody && responseModel) {
    renderBodyMethod(lines, op, plan, method, responseModel, pathStr, ctx);
  } else if (responseModel) {
    renderGetMethod(lines, op, plan, method, responseModel, pathStr);
  } else {
    renderVoidMethod(lines, op, plan, method, pathStr, ctx);
  }

  // Defensive: if no render function produced a method body, emit a stub
  if (lines.length === preDecisionCount) {
    const params = buildPathParams(op);
    lines.push(`  async ${method}(${params}): Promise<void> {`);
    lines.push(
      `    await this.workos.${op.httpMethod}(${pathStr}${httpMethodNeedsBody(op.httpMethod) ? ', {}' : ''});`,
    );
    lines.push('  }');
  }

  return lines;
}

function renderPaginatedMethod(
  lines: string[],
  op: Operation,
  plan: OperationPlan,
  method: string,
  itemType: string,
): void {
  const extraParams = op.queryParams.filter((p) => !PAGINATION_PARAM_NAMES.has(p.name));
  const optionsType = extraParams.length > 0 ? toPascalCase(method) + 'Options' : 'PaginationOptions';

  const pathStr = buildPathStr(op);
  const pathParams = buildPathParams(op);
  const allParams = pathParams ? `${pathParams}, options?: ${optionsType}` : `options?: ${optionsType}`;

  lines.push(`  async ${method}(${allParams}): Promise<AutoPaginatable<${itemType}, ${optionsType}>> {`);
  lines.push('    return new AutoPaginatable(');
  lines.push(`      await fetchAndDeserialize<${wireInterfaceName(itemType)}, ${itemType}>(`);
  lines.push('        this.workos,');
  lines.push(`        ${pathStr},`);
  lines.push(`        deserialize${itemType},`);
  lines.push('        options,');
  lines.push('      ),');
  lines.push('      (params) =>');
  lines.push(`        fetchAndDeserialize<${wireInterfaceName(itemType)}, ${itemType}>(`);
  lines.push('          this.workos,');
  lines.push(`          ${pathStr},`);
  lines.push(`          deserialize${itemType},`);
  lines.push('          params,');
  lines.push('        ),');
  lines.push('      options,');
  lines.push('    );');
  lines.push('  }');
}

function renderDeleteMethod(
  lines: string[],
  op: Operation,
  plan: OperationPlan,
  method: string,
  pathStr: string,
): void {
  const params = buildPathParams(op);
  lines.push(`  async ${method}(${params}): Promise<void> {`);
  lines.push(`    await this.workos.delete(${pathStr});`);
  lines.push('  }');
}

function renderDeleteWithBodyMethod(
  lines: string[],
  op: Operation,
  plan: OperationPlan,
  method: string,
  pathStr: string,
  ctx: EmitterContext,
): void {
  const requestBodyModel = extractRequestBodyModelName(op);
  const requestType = requestBodyModel ? resolveInterfaceName(requestBodyModel, ctx) : 'Record<string, unknown>';

  const paramParts: string[] = [];
  for (const param of op.pathParams) {
    paramParts.push(`${fieldName(param.name)}: ${mapTypeRef(param.type)}`);
  }
  paramParts.push(`payload: ${requestType}`);

  const bodyExpr = requestBodyModel ? `serialize${requestType}(payload)` : 'payload';

  lines.push(`  async ${method}(${paramParts.join(', ')}): Promise<void> {`);
  lines.push(`    await this.workos.deleteWithBody(${pathStr}, ${bodyExpr});`);
  lines.push('  }');
}

function renderBodyMethod(
  lines: string[],
  op: Operation,
  plan: OperationPlan,
  method: string,
  responseModel: string,
  pathStr: string,
  ctx: EmitterContext,
): void {
  const requestBodyModel = extractRequestBodyModelName(op);
  const requestType = requestBodyModel ? resolveInterfaceName(requestBodyModel, ctx) : 'Record<string, unknown>';

  const paramParts: string[] = [];

  // Always pass path params as individual parameters (matches existing SDK pattern)
  for (const param of op.pathParams) {
    paramParts.push(`${fieldName(param.name)}: ${mapTypeRef(param.type)}`);
  }

  paramParts.push(`payload: ${requestType}`);

  if (plan.isIdempotentPost) {
    paramParts.push('requestOptions: PostOptions = {}');
  }

  const paramsStr = paramParts.join(', ');
  const bodyExpr = requestBodyModel ? `serialize${requestType}(payload)` : 'payload';

  // Fix 2: Pass encoding option when requestBodyEncoding is non-json
  const encoding = op.requestBodyEncoding;
  const encodingOption = encoding && encoding !== 'json' ? `, encoding: '${encoding}' as const` : '';
  const hasCustomEncoding = encodingOption !== '';

  lines.push(`  async ${method}(${paramsStr}): Promise<${responseModel}> {`);
  if (plan.isIdempotentPost) {
    if (hasCustomEncoding) {
      lines.push(`    const { data } = await this.workos.${op.httpMethod}<${wireInterfaceName(responseModel)}>(`);
      lines.push(`      ${pathStr},`);
      lines.push(`      ${bodyExpr},`);
      lines.push(`      { ...requestOptions${encodingOption} },`);
      lines.push('    );');
    } else {
      lines.push(`    const { data } = await this.workos.${op.httpMethod}<${wireInterfaceName(responseModel)}>(`);
      lines.push(`      ${pathStr},`);
      lines.push(`      ${bodyExpr},`);
      lines.push('      requestOptions,');
      lines.push('    );');
    }
  } else {
    if (hasCustomEncoding) {
      lines.push(`    const { data } = await this.workos.${op.httpMethod}<${wireInterfaceName(responseModel)}>(`);
      lines.push(`      ${pathStr},`);
      lines.push(`      ${bodyExpr},`);
      lines.push(`      { ${encodingOption.slice(2)} },`);
      lines.push('    );');
    } else {
      lines.push(`    const { data } = await this.workos.${op.httpMethod}<${wireInterfaceName(responseModel)}>(`);
      lines.push(`      ${pathStr},`);
      lines.push(`      ${bodyExpr},`);
      lines.push('    );');
    }
  }
  lines.push(`    return deserialize${responseModel}(data);`);
  lines.push('  }');
}

function renderGetMethod(
  lines: string[],
  op: Operation,
  plan: OperationPlan,
  method: string,
  responseModel: string,
  pathStr: string,
): void {
  const params = buildPathParams(op);
  const hasQuery = op.queryParams.length > 0 && !plan.isPaginated;

  const allParams = hasQuery
    ? params
      ? `${params}, options?: Record<string, unknown>`
      : 'options?: Record<string, unknown>'
    : params;

  lines.push(`  async ${method}(${allParams}): Promise<${responseModel}> {`);
  if (hasQuery) {
    lines.push(
      `    const { data } = await this.workos.${op.httpMethod}<${wireInterfaceName(responseModel)}>(${pathStr}, {`,
    );
    lines.push('      query: options,');
    lines.push('    });');
  } else {
    lines.push(
      `    const { data } = await this.workos.${op.httpMethod}<${wireInterfaceName(responseModel)}>(${pathStr});`,
    );
  }
  lines.push(`    return deserialize${responseModel}(data);`);
  lines.push('  }');
}

function renderVoidMethod(
  lines: string[],
  op: Operation,
  plan: OperationPlan,
  method: string,
  pathStr: string,
  ctx: EmitterContext,
): void {
  const params = buildPathParams(op);

  let bodyParam = '';
  let bodyExpr = 'payload';
  if (plan.hasBody) {
    const requestBodyModel = extractRequestBodyModelName(op);
    if (requestBodyModel) {
      const requestType = resolveInterfaceName(requestBodyModel, ctx);
      bodyParam = `payload: ${requestType}`;
      bodyExpr = `serialize${requestType}(payload)`;
    } else {
      bodyParam = 'payload: Record<string, unknown>';
      bodyExpr = 'payload';
    }
  }

  const allParams = bodyParam ? (params ? `${params}, ${bodyParam}` : bodyParam) : params;

  lines.push(`  async ${method}(${allParams}): Promise<void> {`);
  if (plan.hasBody) {
    lines.push(`    await this.workos.${op.httpMethod}(${pathStr}, ${bodyExpr});`);
  } else if (httpMethodNeedsBody(op.httpMethod)) {
    lines.push(`    await this.workos.${op.httpMethod}(${pathStr}, {});`);
  } else {
    lines.push(`    await this.workos.${op.httpMethod}(${pathStr});`);
  }
  lines.push('  }');
}

function buildPathStr(op: Operation): string {
  const interpolated = op.path.replace(/\{(\w+)\}/g, (_, p) => `\${${fieldName(p)}}`);
  return interpolated.includes('${') ? `\`${interpolated}\`` : `'${op.path}'`;
}

function buildPathParams(op: Operation): string {
  return op.pathParams.map((p) => `${fieldName(p.name)}: ${mapTypeRef(p.type)}`).join(', ');
}

function extractRequestBodyModelName(op: Operation): string | null {
  if (!op.requestBody) return null;
  if (op.requestBody.kind === 'model') return op.requestBody.name;
  return null;
}
