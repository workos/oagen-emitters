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
  for (const { op, plan } of plans) {
    if (plan.responseModelName) responseModels.add(plan.responseModelName);
    if (op.requestBody) {
      for (const name of collectModelRefs(op.requestBody)) {
        requestModels.add(name);
      }
    }
  }
  const allModels = new Set([...responseModels, ...requestModels]);

  const lines: string[] = [];

  // Imports
  lines.push("import type { WorkOS } from '../workos';");
  if (hasPaginated) {
    lines.push("import type { PaginationOptions } from '../common/interfaces/pagination-options.interface';");
    lines.push("import { AutoPaginatable } from '../common/utils/pagination';");
    lines.push("import { fetchAndDeserialize } from '../common/utils/fetch-and-deserialize';");
  }

  // Check if any operation is an idempotent POST
  const hasIdempotentPost = plans.some((p) => p.plan.isIdempotentPost);
  if (hasIdempotentPost) {
    lines.push("import type { PostOptions } from '../common/interfaces/post-options.interface';");
  }

  // Compute model-to-service mapping for correct cross-service import paths
  const modelToService = assignModelsToServices(ctx.spec.models, ctx.spec.services);
  const serviceNameMap = buildServiceNameMap(ctx.spec.services, ctx);
  const resolveDir = (irService: string | undefined) =>
    irService ? serviceDirName(serviceNameMap.get(irService) ?? irService) : 'common';

  for (const name of allModels) {
    const resolved = resolveInterfaceName(name, ctx);
    const modelDir = modelToService.get(name);
    const modelServiceDir = resolveDir(modelDir);
    const relPath =
      modelServiceDir === serviceDir
        ? `./interfaces/${fileName(name)}.interface`
        : `../${modelServiceDir}/interfaces/${fileName(name)}.interface`;
    lines.push(`import type { ${resolved}, ${wireInterfaceName(resolved)} } from '${relPath}';`);
  }

  for (const name of responseModels) {
    const resolved = resolveInterfaceName(name, ctx);
    const modelDir = modelToService.get(name);
    const modelServiceDir = resolveDir(modelDir);
    const relPath =
      modelServiceDir === serviceDir
        ? `./serializers/${fileName(name)}.serializer`
        : `../${modelServiceDir}/serializers/${fileName(name)}.serializer`;
    lines.push(`import { deserialize${resolved} } from '${relPath}';`);
  }

  for (const name of requestModels) {
    const resolved = resolveInterfaceName(name, ctx);
    const modelDir = modelToService.get(name);
    const modelServiceDir = resolveDir(modelDir);
    const relPath =
      modelServiceDir === serviceDir
        ? `./serializers/${fileName(name)}.serializer`
        : `../${modelServiceDir}/serializers/${fileName(name)}.serializer`;
    lines.push(`import { serialize${resolved} } from '${relPath}';`);
  }

  lines.push('');

  // List options interfaces for paginated operations with extra query params
  for (const { op, plan, method } of plans) {
    if (plan.isPaginated) {
      const extraParams = op.queryParams.filter((p) => !['limit', 'before', 'after', 'order'].includes(p.name));
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

  const docParts: string[] = [];
  if (op.description) docParts.push(op.description);
  for (const param of op.pathParams) {
    if (param.description) {
      docParts.push(`@param ${fieldName(param.name)} - ${param.description}`);
    }
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

  if (plan.isPaginated) {
    if (!responseModel) {
      console.warn(
        `[oagen] Warning: Skipping paginated method "${method}" (${op.httpMethod.toUpperCase()} ${op.path}) — response has no named model. Ensure the spec uses a $ref for paginated item types.`,
      );
      return lines;
    }
    renderPaginatedMethod(lines, op, plan, method, responseModel);
  } else if (plan.isDelete) {
    renderDeleteMethod(lines, op, plan, method, pathStr);
  } else if (plan.hasBody && responseModel) {
    renderBodyMethod(lines, op, plan, method, responseModel, pathStr, ctx);
  } else if (responseModel) {
    renderGetMethod(lines, op, plan, method, responseModel, pathStr);
  } else {
    renderVoidMethod(lines, op, plan, method, pathStr);
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
  const extraParams = op.queryParams.filter((p) => !['limit', 'before', 'after', 'order'].includes(p.name));
  const optionsType = extraParams.length > 0 ? toPascalCase(method) + 'Options' : 'PaginationOptions';

  const pathStr = buildPathStr(op);

  lines.push(`  async ${method}(options?: ${optionsType}): Promise<AutoPaginatable<${itemType}, ${optionsType}>> {`);
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
  const requestType = requestBodyModel ? resolveInterfaceName(requestBodyModel, ctx) : 'any';

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
  const bodyExpr = requestBodyModel && requestType !== 'any' ? `serialize${requestType}(payload)` : 'payload';

  lines.push(`  async ${method}(${paramsStr}): Promise<${responseModel}> {`);
  if (plan.isIdempotentPost) {
    lines.push(`    const { data } = await this.workos.${op.httpMethod}<${wireInterfaceName(responseModel)}>(`);
    lines.push(`      ${pathStr},`);
    lines.push(`      ${bodyExpr},`);
    lines.push('      requestOptions,');
    lines.push('    );');
  } else {
    lines.push(`    const { data } = await this.workos.${op.httpMethod}<${wireInterfaceName(responseModel)}>(`);
    lines.push(`      ${pathStr},`);
    lines.push(`      ${bodyExpr},`);
    lines.push('    );');
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
      ? `${params}, options?: Record<string, any>`
      : 'options?: Record<string, any>'
    : params;

  lines.push(`  async ${method}(${allParams}): Promise<${responseModel}> {`);
  if (hasQuery) {
    lines.push(`    const { data } = await this.workos.${op.httpMethod}<${wireInterfaceName(responseModel)}>(${pathStr}, {`);
    lines.push('      query: options,');
    lines.push('    });');
  } else {
    lines.push(`    const { data } = await this.workos.${op.httpMethod}<${wireInterfaceName(responseModel)}>(${pathStr});`);
  }
  lines.push(`    return deserialize${responseModel}(data);`);
  lines.push('  }');
}

function renderVoidMethod(lines: string[], op: Operation, plan: OperationPlan, method: string, pathStr: string): void {
  const params = buildPathParams(op);
  const allParams = plan.hasBody ? (params ? `${params}, payload: any` : 'payload: any') : params;

  lines.push(`  async ${method}(${allParams}): Promise<void> {`);
  if (plan.hasBody) {
    lines.push(`    await this.workos.${op.httpMethod}(${pathStr}, payload);`);
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
