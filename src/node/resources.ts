// @oagen-ignore: Operation.async — all TypeScript SDK methods are async by nature

import type { Service, Operation, EmitterContext, GeneratedFile, TypeRef } from '@workos/oagen';
import { planOperation, toPascalCase } from '@workos/oagen';
import type { OperationPlan } from '@workos/oagen';
import { mapTypeRef } from './type-map.js';
import {
  fieldName,
  wireFieldName,
  fileName,
  serviceDirName,
  resolveMethodName,
  resolveInterfaceName,
  resolveServiceName,
  wireInterfaceName,
} from './naming.js';
import { docComment, createServiceDirResolver, isServiceCoveredByExisting } from './utils.js';
import { assignEnumsToServices } from './enums.js';

/**
 * Check whether the baseline (hand-written) class has a constructor compatible
 * with the generated pattern `constructor(private readonly workos: WorkOS)`.
 * Returns true when no baseline exists (fresh generation) or when compatible.
 */
export function hasCompatibleConstructor(className: string, ctx: EmitterContext): boolean {
  const baselineClass = ctx.apiSurface?.classes?.[className];
  if (!baselineClass) return true; // No baseline — fresh generation
  const params = baselineClass.constructorParams;
  if (!params || params.length === 0) return true; // No-arg constructor is compatible
  // Compatible if there is a single `workos` param whose type contains "WorkOS"
  return params.some((p) => p.name === 'workos' && p.type.includes('WorkOS'));
}

/**
 * Resolve the resource class name for a service, accounting for constructor
 * compatibility with the baseline class.
 *
 * When the overlay-resolved class has an incompatible constructor (e.g., a
 * hand-written `Webhooks` class that takes `CryptoProvider` instead of `WorkOS`),
 * falls back to the IR name (`toPascalCase(service.name)`). If the IR name
 * collides with the overlay name, appends an `Endpoints` suffix.
 */
export function resolveResourceClassName(service: Service, ctx: EmitterContext): string {
  const overlayName = resolveServiceName(service, ctx);
  if (hasCompatibleConstructor(overlayName, ctx)) {
    return overlayName;
  }
  // Incompatible constructor — fall back to IR name
  const irName = toPascalCase(service.name);
  if (irName === overlayName) {
    return irName + 'Endpoints';
  }
  return irName;
}

/** Standard pagination query params handled by PaginationOptions — not imported individually. */
const PAGINATION_PARAM_NAMES = new Set(['limit', 'before', 'after', 'order']);

/** Map HTTP status codes to their corresponding exception class names for @throws docs. */
const STATUS_TO_EXCEPTION_NAME: Record<number, string> = {
  400: 'BadRequestException',
  401: 'UnauthorizedException',
  404: 'NotFoundException',
  409: 'ConflictException',
  422: 'UnprocessableEntityException',
  429: 'RateLimitExceededException',
};

/**
 * Compute the options interface name for a paginated method.
 * When the method name is simply "list", prefix with the service name to avoid
 * naming collisions at barrel-export level (e.g. "ConnectionsListOptions"
 * instead of the generic "ListOptions").
 */
function paginatedOptionsName(method: string, resolvedServiceName: string): string {
  if (method === 'list') {
    return `${toPascalCase(resolvedServiceName)}ListOptions`;
  }
  return toPascalCase(method) + 'Options';
}

/** HTTP methods that require a body argument even when the spec has no request body. */
function httpMethodNeedsBody(method: string): boolean {
  return method === 'post' || method === 'put' || method === 'patch';
}

export function generateResources(services: Service[], ctx: EmitterContext): GeneratedFile[] {
  if (services.length === 0) return [];
  // Skip services whose endpoints are fully covered by existing hand-written
  // service classes to avoid generating duplicate resource classes.
  return services
    .filter((service) => !isServiceCoveredByExisting(service, ctx))
    .map((service) => generateResourceClass(service, ctx));
}

function generateResourceClass(service: Service, ctx: EmitterContext): GeneratedFile {
  const resolvedName = resolveResourceClassName(service, ctx);
  const serviceDir = serviceDirName(resolvedName);
  const serviceClass = resolvedName;
  const resourcePath = `src/${serviceDir}/${fileName(resolvedName)}.ts`;

  const plans = service.operations.map((op) => ({
    op,
    plan: planOperation(op),
    method: resolveMethodName(op, service, ctx),
  }));

  const hasPaginated = plans.some((p) => p.plan.isPaginated);

  // Collect models for imports — only include models that are actually used
  // in method signatures (not all union variants from the spec)
  const responseModels = new Set<string>();
  const requestModels = new Set<string>();
  const paramEnums = new Set<string>();
  const paramModels = new Set<string>();
  for (const { op, plan } of plans) {
    if (plan.isPaginated && op.pagination?.itemType.kind === 'model') {
      // For paginated operations, import the item type (e.g., Connection)
      // rather than the list wrapper type (e.g., ConnectionList).
      // fetchAndDeserialize handles the list envelope internally.
      responseModels.add(op.pagination.itemType.name);
    } else if (plan.responseModelName) {
      responseModels.add(plan.responseModelName);
    }
    // Import request body model(s) — handles both single models and union variants.
    const bodyInfo = extractRequestBodyType(op, ctx);
    if (bodyInfo?.kind === 'model') {
      requestModels.add(bodyInfo.name);
    } else if (bodyInfo?.kind === 'union') {
      if (bodyInfo.discriminator) {
        // Discriminated union: import variant models with serializers so we can
        // dispatch to the correct serializer at runtime based on the discriminator.
        for (const name of bodyInfo.modelNames) {
          requestModels.add(name);
        }
      } else {
        // Non-discriminated union: import variant models as domain types only.
        // Without a discriminator we can't statically dispatch serialization,
        // so the payload is passed through as-is.
        for (const name of bodyInfo.modelNames) {
          paramModels.add(name);
        }
      }
    }
    // Collect types referenced in query and path parameters.
    // For paginated operations, skip standard pagination params (limit, before, after, order)
    // since they're handled by PaginationOptions and don't need explicit imports.
    const queryParams = plan.isPaginated
      ? op.queryParams.filter((p) => !PAGINATION_PARAM_NAMES.has(p.name))
      : op.queryParams;
    for (const param of [...queryParams, ...op.pathParams]) {
      collectParamTypeRefs(param.type, paramEnums, paramModels);
    }
  }
  const allModels = new Set([...responseModels, ...requestModels, ...paramModels]);

  const lines: string[] = [];

  // Imports
  lines.push("import type { WorkOS } from '../workos';");
  if (hasPaginated) {
    lines.push("import type { PaginationOptions } from '../common/interfaces/pagination-options.interface';");
    lines.push("import type { AutoPaginatable } from '../common/utils/pagination';");
    lines.push("import { createPaginatedList } from '../common/utils/fetch-and-deserialize';");
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
  const { modelToService, resolveDir } = createServiceDirResolver(ctx.spec.models, ctx.spec.services, ctx);

  // Wire (Response) types are only needed for models used as response types in method signatures.
  // Request models and param models only need the domain type.
  const usedWireTypes = new Set<string>();
  for (const name of responseModels) {
    usedWireTypes.add(resolveInterfaceName(name, ctx));
  }

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
    if (usedWireTypes.has(resolved)) {
      lines.push(`import type { ${resolved}, ${wireInterfaceName(resolved)} } from '${relPath}';`);
    } else {
      lines.push(`import type { ${resolved} } from '${relPath}';`);
    }
  }

  // Collect serializer imports by module path so we can merge deserialize and
  // serialize imports from the same module into a single import statement.
  const serializerImportsByPath = new Map<string, string[]>();

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
    const existing = serializerImportsByPath.get(relPath) ?? [];
    existing.push(`deserialize${resolved}`);
    serializerImportsByPath.set(relPath, existing);
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
    const existing = serializerImportsByPath.get(relPath) ?? [];
    existing.push(`serialize${resolved}`);
    serializerImportsByPath.set(relPath, existing);
  }

  // Emit merged serializer imports
  for (const [relPath, specifiers] of serializerImportsByPath) {
    lines.push(`import { ${specifiers.join(', ')} } from '${relPath}';`);
  }

  // Build a set of global enum names — used to distinguish named enums (with files)
  // from inline enums (no file, must be rendered as string literal unions).
  const specEnumNames = new Set(ctx.spec.enums.map((e) => e.name));

  // Import enum types referenced in query/path parameters.
  // Only import enums that actually exist in the spec's global enums list —
  // inline string unions may have kind 'enum' but no corresponding file.
  if (paramEnums.size > 0) {
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

  // Options interfaces for operations with query params.
  // Paginated operations extend PaginationOptions; non-paginated operations get standalone interfaces.
  for (const { op, plan, method } of plans) {
    if (plan.isPaginated) {
      const extraParams = op.queryParams.filter((p) => !PAGINATION_PARAM_NAMES.has(p.name));
      if (extraParams.length > 0) {
        const optionsName = paginatedOptionsName(method, resolvedName);
        // Always generate the options interface locally in the resource file.
        // Previously we skipped generation when a baseline interface with a matching
        // name existed, but the baseline interface may live in a different module
        // (e.g., `user-management/` vs `user-management-users/`) and would not be
        // available without an import.  Generating locally is safe and avoids
        // cross-module import resolution issues.
        lines.push(`export interface ${optionsName} extends PaginationOptions {`);
        for (const param of extraParams) {
          const opt = !param.required ? '?' : '';
          if (param.description || param.deprecated) {
            const parts: string[] = [];
            if (param.description) parts.push(param.description);
            if (param.deprecated) parts.push('@deprecated');
            lines.push(...docComment(parts.join('\n'), 2));
          }
          lines.push(`  ${fieldName(param.name)}${opt}: ${mapParamType(param.type, specEnumNames)};`);
        }
        lines.push('}');
        lines.push('');
      }
    } else if (!plan.isPaginated && !plan.hasBody && !plan.isDelete && op.queryParams.length > 0) {
      // Non-paginated GET or void methods with query params get a typed options interface
      // instead of falling back to Record<string, unknown>.
      const optionsName = toPascalCase(method) + 'Options';
      lines.push(`export interface ${optionsName} {`);
      for (const param of op.queryParams) {
        const opt = !param.required ? '?' : '';
        if (param.description || param.deprecated) {
          const parts: string[] = [];
          if (param.description) parts.push(param.description);
          if (param.deprecated) parts.push('@deprecated');
          lines.push(...docComment(parts.join('\n'), 2));
        }
        lines.push(`  ${fieldName(param.name)}${opt}: ${mapParamType(param.type, specEnumNames)};`);
      }
      lines.push('}');
      lines.push('');
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
    lines.push(...renderMethod(op, plan, method, service, ctx, specEnumNames));
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
  specEnumNames?: Set<string>,
): string[] {
  const lines: string[] = [];
  const responseModel = plan.responseModelName ? resolveInterfaceName(plan.responseModelName, ctx) : null;

  const pathStr = buildPathStr(op);

  // Build set of valid param names to filter @param tags.
  // Prefer the overlay (existing method signature) if available;
  // otherwise compute from what the render path will actually include.
  const httpKey = `${op.httpMethod.toUpperCase()} ${op.path}`;
  const overlayMethod = ctx.overlayLookup?.methodByOperation?.get(httpKey);
  let validParamNames: Set<string> | null = null;
  if (overlayMethod) {
    validParamNames = new Set(overlayMethod.params.map((p) => p.name));
  } else {
    // Compute actual params based on render path to avoid documenting params
    // that won't appear in the method signature
    const actualParams = new Set<string>();
    for (const p of op.pathParams) actualParams.add(fieldName(p.name));
    if (plan.hasBody) actualParams.add('payload');
    if (plan.isPaginated) actualParams.add('options');
    // renderGetMethod adds options when there are non-paginated query params
    if (!plan.isPaginated && op.queryParams.length > 0 && !plan.isDelete && responseModel) {
      actualParams.add('options');
    }
    validParamNames = actualParams;
  }

  const docParts: string[] = [];
  if (op.description) docParts.push(op.description);
  for (const param of op.pathParams) {
    const paramName = fieldName(param.name);
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
    // Only document query params if the method will have an options parameter
    if (validParamNames && (validParamNames.has('options') || overlayMethod)) {
      for (const param of op.queryParams) {
        const paramName = `options.${fieldName(param.name)}`;
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
  }
  // Skip header and cookie params in JSDoc — they are not exposed in the method signature.
  // The SDK handles headers and cookies internally, so documenting them would be misleading.
  // Document payload parameter when there is a request body
  if (plan.hasBody) {
    const bodyInfo = extractRequestBodyType(op, ctx);
    if (bodyInfo?.kind === 'model') {
      const bodyModel = ctx.spec.models.find((m) => m.name === bodyInfo.name);
      const payloadDesc = bodyModel?.description
        ? `@param payload - ${bodyModel.description}`
        : `@param payload - The request body.`;
      docParts.push(payloadDesc);
    } else {
      docParts.push('@param payload - The request body.');
    }
  }
  // Document options parameter for paginated operations
  if (plan.isPaginated) {
    docParts.push('@param options - Pagination and filter options.');
  } else if (op.queryParams.length > 0) {
    docParts.push('@param options - Additional query options.');
  }
  // @returns for the primary response model (use item type for paginated operations)
  if (plan.isPaginated && op.pagination?.itemType.kind === 'model') {
    const itemTypeName = resolveInterfaceName(op.pagination.itemType.name, ctx);
    docParts.push(`@returns {${itemTypeName}}`);
  } else if (responseModel) {
    docParts.push(`@returns {${responseModel}}`);
  } else {
    docParts.push('@returns {void}');
  }
  // @throws for error responses
  for (const err of op.errors) {
    const exceptionName = STATUS_TO_EXCEPTION_NAME[err.statusCode];
    if (exceptionName) {
      docParts.push(`@throws {${exceptionName}} ${err.statusCode}`);
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

  const preDecisionCount = lines.length;

  if (plan.isPaginated && op.pagination && op.httpMethod === 'get') {
    // For paginated operations, use the item type from pagination metadata
    // (e.g., Connection) rather than the list wrapper type (e.g., ConnectionList).
    const paginatedItemType =
      op.pagination.itemType.kind === 'model' ? resolveInterfaceName(op.pagination.itemType.name, ctx) : responseModel;
    if (paginatedItemType) {
      const resolvedServiceNameForPaginated = resolveServiceName(service, ctx);
      renderPaginatedMethod(
        lines,
        op,
        plan,
        method,
        paginatedItemType,
        pathStr,
        resolvedServiceNameForPaginated,
        specEnumNames,
      );
    }
  } else if (plan.isPaginated && plan.hasBody && responseModel) {
    // Non-GET paginated operation (e.g., PUT with list response) — treat as body method
    renderBodyMethod(lines, op, plan, method, responseModel, pathStr, ctx, specEnumNames);
  } else if (plan.isDelete && plan.hasBody) {
    renderDeleteWithBodyMethod(lines, op, plan, method, pathStr, ctx, specEnumNames);
  } else if (plan.isDelete) {
    renderDeleteMethod(lines, op, plan, method, pathStr, specEnumNames);
  } else if (plan.hasBody && responseModel) {
    renderBodyMethod(lines, op, plan, method, responseModel, pathStr, ctx, specEnumNames);
  } else if (responseModel) {
    renderGetMethod(lines, op, plan, method, responseModel, pathStr, specEnumNames);
  } else {
    renderVoidMethod(lines, op, plan, method, pathStr, ctx, specEnumNames);
  }

  // Defensive: if no render function produced a method body, emit a stub
  if (lines.length === preDecisionCount) {
    const params = buildPathParams(op, specEnumNames);
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
  pathStr: string,
  resolvedServiceName: string,
  specEnumNames?: Set<string>,
): void {
  const extraParams = op.queryParams.filter((p) => !PAGINATION_PARAM_NAMES.has(p.name));
  const optionsType = extraParams.length > 0 ? paginatedOptionsName(method, resolvedServiceName) : 'PaginationOptions';

  const pathParams = buildPathParams(op, specEnumNames);
  const allParams = pathParams ? `${pathParams}, options?: ${optionsType}` : `options?: ${optionsType}`;

  lines.push(`  async ${method}(${allParams}): Promise<AutoPaginatable<${itemType}, ${optionsType}>> {`);
  lines.push(`    return createPaginatedList<${wireInterfaceName(itemType)}, ${itemType}, ${optionsType}>(`);
  lines.push(`      this.workos, ${pathStr}, deserialize${itemType}, options,`);
  lines.push('    );');
  lines.push('  }');
}

function renderDeleteMethod(
  lines: string[],
  op: Operation,
  plan: OperationPlan,
  method: string,
  pathStr: string,
  specEnumNames?: Set<string>,
): void {
  const params = buildPathParams(op, specEnumNames);
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
  specEnumNames?: Set<string>,
): void {
  const bodyInfo = extractRequestBodyType(op, ctx);
  let requestType: string;
  let bodyExpr: string;
  if (bodyInfo?.kind === 'model') {
    requestType = resolveInterfaceName(bodyInfo.name, ctx);
    bodyExpr = `serialize${requestType}(payload)`;
  } else if (bodyInfo?.kind === 'union') {
    requestType = bodyInfo.typeStr;
    if (bodyInfo.discriminator) {
      bodyExpr = renderUnionBodySerializer(bodyInfo.discriminator, ctx);
    } else {
      bodyExpr = 'payload';
    }
  } else {
    requestType = 'Record<string, unknown>';
    bodyExpr = 'payload';
  }

  const paramParts: string[] = [];
  for (const param of op.pathParams) {
    paramParts.push(
      `${fieldName(param.name)}: ${specEnumNames ? mapParamType(param.type, specEnumNames) : mapTypeRef(param.type)}`,
    );
  }
  paramParts.push(`payload: ${requestType}`);

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
  specEnumNames?: Set<string>,
): void {
  const bodyInfo = extractRequestBodyType(op, ctx);
  let requestType: string;
  let bodyExpr: string;
  if (bodyInfo?.kind === 'model') {
    requestType = resolveInterfaceName(bodyInfo.name, ctx);
    bodyExpr = `serialize${requestType}(payload)`;
  } else if (bodyInfo?.kind === 'union') {
    requestType = bodyInfo.typeStr;
    if (bodyInfo.discriminator) {
      // Discriminated union: dispatch to the correct serializer at runtime.
      bodyExpr = renderUnionBodySerializer(bodyInfo.discriminator, ctx);
    } else {
      // Non-discriminated union: cannot statically dispatch —
      // pass the payload directly (caller provides the correct shape).
      bodyExpr = 'payload';
    }
  } else {
    requestType = 'Record<string, unknown>';
    bodyExpr = 'payload';
  }

  const paramParts: string[] = [];

  // Always pass path params as individual parameters (matches existing SDK pattern)
  for (const param of op.pathParams) {
    paramParts.push(
      `${fieldName(param.name)}: ${specEnumNames ? mapParamType(param.type, specEnumNames) : mapTypeRef(param.type)}`,
    );
  }

  paramParts.push(`payload: ${requestType}`);

  if (plan.isIdempotentPost) {
    paramParts.push('requestOptions: PostOptions = {}');
  }

  const paramsStr = paramParts.join(', ');

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
  specEnumNames?: Set<string>,
): void {
  const params = buildPathParams(op, specEnumNames);
  const hasQuery = op.queryParams.length > 0 && !plan.isPaginated;
  const optionsType = hasQuery ? toPascalCase(method) + 'Options' : null;

  const allParams = hasQuery ? (params ? `${params}, options?: ${optionsType}` : `options?: ${optionsType}`) : params;

  lines.push(`  async ${method}(${allParams}): Promise<${responseModel}> {`);
  if (hasQuery) {
    const queryExpr = renderQueryExpr(op.queryParams);
    lines.push(
      `    const { data } = await this.workos.${op.httpMethod}<${wireInterfaceName(responseModel)}>(${pathStr}, {`,
    );
    lines.push(`      query: ${queryExpr},`);
    lines.push('    });');
  } else if (httpMethodNeedsBody(op.httpMethod)) {
    // PUT/PATCH/POST require a body argument even when the spec has no request body
    lines.push(
      `    const { data } = await this.workos.${op.httpMethod}<${wireInterfaceName(responseModel)}>(${pathStr}, {});`,
    );
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
  specEnumNames?: Set<string>,
): void {
  const params = buildPathParams(op, specEnumNames);
  const hasQuery = op.queryParams.length > 0 && !plan.hasBody;
  const optionsType = hasQuery ? toPascalCase(method) + 'Options' : null;

  let bodyParam = '';
  let bodyExpr = 'payload';
  if (plan.hasBody) {
    const bodyInfo = extractRequestBodyType(op, ctx);
    if (bodyInfo?.kind === 'model') {
      const requestType = resolveInterfaceName(bodyInfo.name, ctx);
      bodyParam = `payload: ${requestType}`;
      bodyExpr = `serialize${requestType}(payload)`;
    } else if (bodyInfo?.kind === 'union') {
      bodyParam = `payload: ${bodyInfo.typeStr}`;
      if (bodyInfo.discriminator) {
        bodyExpr = renderUnionBodySerializer(bodyInfo.discriminator, ctx);
      } else {
        bodyExpr = 'payload';
      }
    } else {
      bodyParam = 'payload: Record<string, unknown>';
      bodyExpr = 'payload';
    }
  }

  const paramParts: string[] = [];
  if (params) paramParts.push(params);
  if (bodyParam) paramParts.push(bodyParam);
  if (optionsType) paramParts.push(`options?: ${optionsType}`);
  const allParams = paramParts.join(', ');

  lines.push(`  async ${method}(${allParams}): Promise<void> {`);
  if (plan.hasBody) {
    lines.push(`    await this.workos.${op.httpMethod}(${pathStr}, ${bodyExpr});`);
  } else if (hasQuery) {
    const queryExpr = renderQueryExpr(op.queryParams);
    lines.push(`    await this.workos.${op.httpMethod}(${pathStr}, {`);
    lines.push(`      query: ${queryExpr},`);
    lines.push('    });');
  } else if (httpMethodNeedsBody(op.httpMethod)) {
    lines.push(`    await this.workos.${op.httpMethod}(${pathStr}, {});`);
  } else {
    lines.push(`    await this.workos.${op.httpMethod}(${pathStr});`);
  }
  lines.push('  }');
}

/**
 * Generate an inline query serialization expression that maps camelCase option
 * keys to their snake_case wire equivalents.  When all keys already match
 * (camel === snake), returns 'options' as-is for brevity.
 */
function renderQueryExpr(queryParams: { name: string; required: boolean }[]): string {
  // Check if any key actually needs conversion
  const needsConversion = queryParams.some((p) => fieldName(p.name) !== wireFieldName(p.name));
  if (!needsConversion) return 'options';

  const parts: string[] = [];
  for (const param of queryParams) {
    const camel = fieldName(param.name);
    const snake = wireFieldName(param.name);
    if (param.required) {
      parts.push(`${snake}: options.${camel}`);
    } else {
      parts.push(`...(options.${camel} !== undefined && { ${snake}: options.${camel} })`);
    }
  }
  return `options ? { ${parts.join(', ')} } : undefined`;
}

function buildPathStr(op: Operation): string {
  const interpolated = op.path.replace(/\{(\w+)\}/g, (_, p) => `\${${fieldName(p)}}`);
  return interpolated.includes('${') ? `\`${interpolated}\`` : `'${op.path}'`;
}

function buildPathParams(op: Operation, specEnumNames?: Set<string>): string {
  // Start with declared path params
  const declaredNames = new Set(op.pathParams.map((p) => fieldName(p.name)));
  const params = op.pathParams.map((p) => {
    const type = specEnumNames ? mapParamType(p.type, specEnumNames) : mapTypeRef(p.type);
    return `${fieldName(p.name)}: ${type}`;
  });

  // Detect path template variables not in declared pathParams and add them as string params.
  // This handles cases where the spec path has {param} but pathParams is incomplete.
  const templateVars = [...op.path.matchAll(/\{(\w+)\}/g)].map(([, name]) => fieldName(name));
  for (const varName of templateVars) {
    if (!declaredNames.has(varName)) {
      params.push(`${varName}: string`);
    }
  }

  return params.join(', ');
}

/**
 * Walk a parameter's type tree and collect enum/model names for imports.
 * Handles arrays and nullable wrappers that may contain nested enums/models.
 */
function collectParamTypeRefs(type: TypeRef, enums: Set<string>, models: Set<string>): void {
  switch (type.kind) {
    case 'enum':
      enums.add(type.name);
      break;
    case 'model':
      models.add(type.name);
      break;
    case 'array':
      collectParamTypeRefs(type.items, enums, models);
      break;
    case 'nullable':
      collectParamTypeRefs(type.inner, enums, models);
      break;
  }
}

/**
 * Extract request body type info, supporting both single models and union types.
 * Returns structured info so callers can handle imports and serialization appropriately.
 */
/**
 * Generate an IIFE expression that dispatches to the correct serializer for a
 * discriminated union request body.  Switches on the camelCase discriminator
 * property of the domain object and calls the appropriate serialize function
 * for each mapped model variant.
 */
function renderUnionBodySerializer(
  disc: { property: string; mapping: Record<string, string> },
  ctx: EmitterContext,
): string {
  const prop = fieldName(disc.property);
  const cases: string[] = [];
  for (const [value, modelName] of Object.entries(disc.mapping)) {
    const resolved = resolveInterfaceName(modelName, ctx);
    cases.push(`case '${value}': return serialize${resolved}(payload as any)`);
  }
  return `(() => { switch ((payload as any).${prop}) { ${cases.join('; ')}; default: return payload } })()`;
}

/** Return type for extractRequestBodyType when the body is a union. */
interface UnionBodyInfo {
  kind: 'union';
  typeStr: string;
  modelNames: string[];
  discriminator?: { property: string; mapping: Record<string, string> };
}

function extractRequestBodyType(
  op: Operation,
  ctx: EmitterContext,
): { kind: 'model'; name: string } | UnionBodyInfo | null {
  if (!op.requestBody) return null;
  if (op.requestBody.kind === 'model') return { kind: 'model', name: op.requestBody.name };
  if (op.requestBody.kind === 'union') {
    const modelNames: string[] = [];
    for (const variant of op.requestBody.variants) {
      if (variant.kind === 'model') modelNames.push(variant.name);
    }
    if (modelNames.length > 0) {
      const typeStr = modelNames.map((n) => resolveInterfaceName(n, ctx)).join(' | ');
      return { kind: 'union', typeStr, modelNames, discriminator: op.requestBody.discriminator };
    }
  }
  return null;
}

/**
 * Map a parameter type to a TypeScript type string, handling inline enums
 * that don't have corresponding global enum definitions.  These would
 * otherwise emit bare names like `Type` or `Action` that are never imported.
 *
 * Recursively handles container types (arrays, nullable) so that inline
 * enums nested inside e.g. `array<enum>` are also inlined as string literal unions.
 */
function mapParamType(type: TypeRef, specEnumNames: Set<string>): string {
  if (type.kind === 'enum' && !specEnumNames.has(type.name)) {
    // Inline enum with no generated file — render values as string literal union
    if (type.values && type.values.length > 0) {
      return type.values.map((v: string | number) => (typeof v === 'string' ? `'${v}'` : String(v))).join(' | ');
    }
    return 'string';
  }
  if (type.kind === 'array') {
    const inner = mapParamType(type.items, specEnumNames);
    // Parenthesize union types when used as array element type
    return inner.includes(' | ') ? `(${inner})[]` : `${inner}[]`;
  }
  if (type.kind === 'nullable') {
    return `${mapParamType(type.inner, specEnumNames)} | null`;
  }
  return mapTypeRef(type);
}
