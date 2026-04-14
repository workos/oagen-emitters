import type {
  Service,
  Operation,
  OperationPlan,
  EmitterContext,
  GeneratedFile,
  ResolvedOperation,
} from '@workos/oagen';
import { planOperation } from '@workos/oagen';
import { isListWrapperModel } from './models.js';
import { mapTypeRef, isValueTypeRef, isEnumRef, emitJsonPropertyAttributes } from './type-map.js';
import {
  className,
  fieldName,
  methodName,
  resolveClassName,
  resolveMethodName,
  serviceTypeName,
  localName,
  csLiteral,
  clientFieldExpression,
  httpMethodCs,
  httpMethodHelperName,
  escapeXml,
  emitXmlDoc,
  deprecationMessage,
  escapeCsAttributeString,
  humanize,
} from './naming.js';
import {
  buildResolvedLookup,
  lookupResolved,
  groupByMount,
  getOpDefaults,
  getOpInferFromClient,
  buildHiddenParams,
  hasHiddenParams,
} from '../shared/resolved-ops.js';
import { generateWrapperMethods } from './wrappers.js';

/**
 * Return path params sorted by their first occurrence in the URL template.
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
 * Generate C# service files from IR Service definitions.
 * Each mount group becomes a single Service.cs file.
 */
export function generateResources(services: Service[], ctx: EmitterContext): GeneratedFile[] {
  if (services.length === 0) return [];

  const files: GeneratedFile[] = [];
  const mountGroups = groupByMount(ctx);

  const entries: Array<{ name: string; operations: Operation[] }> =
    mountGroups.size > 0
      ? [...mountGroups].map(([name, group]) => ({ name, operations: group.operations }))
      : services.map((s) => ({ name: resolveResourceClassName(s, ctx), operations: s.operations }));

  for (const { name: mountName, operations } of entries) {
    if (operations.length === 0) continue;
    const serviceFile = generateServiceFile(mountName, operations, ctx);
    if (serviceFile) files.push(serviceFile);
    const optionsFile = generateOptionsFile(mountName, operations, ctx);
    if (optionsFile) files.push(optionsFile);
  }

  return files;
}

function generateServiceFile(mountName: string, operations: Operation[], ctx: EmitterContext): GeneratedFile | null {
  const lines: string[] = [];
  const svcTypeName = serviceTypeName(mountName);
  const csFile = `Services/${className(mountName)}/${svcTypeName}.cs`;

  const resolvedLookup = buildResolvedLookup(ctx);

  lines.push(`namespace ${ctx.namespacePascal}`);
  lines.push('{');
  lines.push('    using System.Collections.Generic;');
  lines.push('    using System.Net.Http;');
  lines.push('    using System.Threading;');
  lines.push('    using System.Threading.Tasks;');
  lines.push('');
  lines.push(
    `    /// <summary>Service that exposes the ${humanize(mountName)} API operations on <see cref="WorkOSClient"/>.</summary>`,
  );
  lines.push(`    public class ${svcTypeName} : Service`);
  lines.push('    {');
  lines.push(`        /// <summary>`);
  lines.push(
    `        /// Initializes a new instance of the <see cref="${svcTypeName}"/> class for mocking. The service uses the singleton`,
  );
  lines.push(`        /// client configured via <see cref="WorkOSConfiguration.WorkOSClient"/>.`);
  lines.push(`        /// </summary>`);
  lines.push(`        public ${svcTypeName}() { }`);
  lines.push('');
  lines.push(`        /// <summary>`);
  lines.push(`        /// Initializes a new instance of the <see cref="${svcTypeName}"/> class bound to the`);
  lines.push(`        /// supplied <paramref name="client"/>.`);
  lines.push(`        /// </summary>`);
  lines.push(`        /// <param name="client">The HTTP client used to make API requests.</param>`);
  lines.push(`        public ${svcTypeName}(WorkOSClient client) : base(client) { }`);

  const emittedMethods = new Set<string>();
  for (const op of operations) {
    const plan = planOperation(op);
    const method = resolveCsMethodName(op, mountName, ctx);

    if (emittedMethods.has(method)) continue;
    emittedMethods.add(method);

    const resolvedOp = lookupResolved(op, resolvedLookup);
    const isUnionSplit = (resolvedOp?.wrappers?.length ?? 0) > 0;

    // For union-split operations (e.g. POST /user_management/authenticate), do
    // NOT emit the raw method — its options class is empty and any caller will
    // get a 422 from the API. Only emit the typed AuthenticateWith* wrappers.
    if (!isUnionSplit) {
      lines.push('');
      const methodCode = generateMethod(svcTypeName, mountName, method, op, plan, ctx, resolvedOp);
      lines.push(methodCode);

      // Generate auto-pagination method for paginated list operations
      if (plan.isPaginated && op.pagination) {
        lines.push('');
        const autoPagingCode = generateAutoPagingMethod(mountName, method, op, plan, ctx, resolvedOp);
        lines.push(autoPagingCode);
      }
    }

    // Generate union split wrapper methods
    if (isUnionSplit) {
      const wrapperLines = generateWrapperMethods(svcTypeName, resolvedOp!, ctx);
      lines.push(...wrapperLines);
      for (const w of resolvedOp!.wrappers!) {
        emittedMethods.add(methodName(w.name));
      }
    }
  }

  lines.push('    }');
  lines.push('}');

  return {
    path: csFile,
    content: lines.join('\n'),
    overwriteExisting: true,
  };
}

function generateOptionsFile(mountName: string, operations: Operation[], ctx: EmitterContext): GeneratedFile | null {
  const resolvedLookup = buildResolvedLookup(ctx);
  const optionsLines: string[] = [];
  let hasOptions = false;

  optionsLines.push(`namespace ${ctx.namespacePascal}`);
  optionsLines.push('{');
  optionsLines.push('    using System;');
  optionsLines.push('    using System.Collections.Generic;');
  optionsLines.push('    using Newtonsoft.Json;');
  optionsLines.push('    using STJS = System.Text.Json.Serialization;');

  const emittedOptions = new Set<string>();
  for (const op of operations) {
    const plan = planOperation(op);
    const method = resolveCsMethodName(op, mountName, ctx);
    const resolvedOp = lookupResolved(op, resolvedLookup);
    const hidden = buildHiddenParams(resolvedOp);

    // Union-split operations expose typed wrapper option classes
    // (AuthenticateWith*Options) instead of a generic raw options class.
    // Skip emitting an empty *CreateAuthenticateOptions placeholder.
    if ((resolvedOp?.wrappers?.length ?? 0) > 0) continue;

    const optionsClass = optionsClassName(mountName, method);
    if (emittedOptions.has(optionsClass)) continue;

    const hasVisibleQueryParams = op.queryParams.filter((qp) => !hidden.has(qp.name)).length > 0;
    const hasBody = plan.hasBody && op.requestBody;
    let hasVisibleBodyFields = false;
    if (hasBody && op.requestBody?.kind === 'model') {
      const bodyModel = ctx.spec.models.find((m) => op.requestBody?.kind === 'model' && m.name === op.requestBody.name);
      if (bodyModel) hasVisibleBodyFields = bodyModel.fields.some((f) => !hidden.has(f.name));
    } else if (hasBody) {
      hasVisibleBodyFields = true;
    }

    if (!hasVisibleQueryParams && !hasVisibleBodyFields) continue;

    emittedOptions.add(optionsClass);
    hasOptions = true;

    // Determine base class: ListOptions for paginated list operations, BaseOptions otherwise
    const isPaginated = plan.isPaginated;
    const baseClass = isPaginated ? 'ListOptions' : 'BaseOptions';

    optionsLines.push('');
    const opSummary = op.description?.split('\n').find((l) => l.trim()) ?? `${method} on ${mountName}`;
    optionsLines.push(
      `    /// <summary>Request options for <see cref="${className(mountName)}Service.${method}"/>: ${escapeXml(opSummary.trim())}</summary>`,
    );
    optionsLines.push(`    public class ${optionsClass} : ${baseClass}`);
    optionsLines.push('    {');

    const emittedFields = new Set<string>();

    // Body fields
    if (hasBody && op.requestBody?.kind === 'model') {
      const bodyModel = ctx.spec.models.find((m) => op.requestBody?.kind === 'model' && m.name === op.requestBody.name);
      if (bodyModel) {
        for (const field of bodyModel.fields) {
          if (hidden.has(field.name)) continue;
          const csField = fieldName(field.name);
          if (emittedFields.has(csField)) continue;
          emittedFields.add(csField);

          const isOptional = !field.required;
          const baseType = mapTypeRef(field.type);
          const isAlreadyNullable = baseType.endsWith('?');
          let csType: string;
          let initializer = '';

          if (isOptional) {
            if (isAlreadyNullable) {
              csType = baseType;
            } else if (isValueTypeRef(field.type)) {
              csType = `${baseType}?`;
            } else {
              csType = `${baseType}?`;
            }
          } else {
            csType = baseType;
            if (!isAlreadyNullable && !isValueTypeRef(field.type)) {
              initializer = ' = default!;';
            }
          }

          const isRequiredEnum = field.required && isEnumRef(field.type);
          optionsLines.push(...emitXmlDoc(field.description, '        '));
          if (field.deprecated) {
            const msg = escapeCsAttributeString(deprecationMessage(field.description, 'field'));
            optionsLines.push(`        [System.Obsolete("${msg}")]`);
          }
          optionsLines.push(...emitJsonPropertyAttributes(field.name, { isRequiredEnum }));
          optionsLines.push(`        public ${csType} ${csField} { get; set; }${initializer}`);
          optionsLines.push('');
        }
      }
    }

    // Query params (skip pagination fields for list options — they're in ListOptions base)
    const PAGINATION_FIELDS = new Set(['before', 'after', 'limit', 'order']);
    for (const param of op.queryParams) {
      if (hidden.has(param.name)) continue;
      if (isPaginated && PAGINATION_FIELDS.has(param.name)) continue;
      const csField = fieldName(param.name);
      if (emittedFields.has(csField)) continue;
      emittedFields.add(csField);

      const isOptional = !param.required;
      const baseType = mapTypeRef(param.type);
      const isAlreadyNullable = baseType.endsWith('?');
      let csType: string;
      let initializer = '';

      if (isOptional) {
        if (isAlreadyNullable) {
          csType = baseType;
        } else if (isValueTypeRef(param.type)) {
          csType = `${baseType}?`;
        } else {
          csType = `${baseType}?`;
        }
      } else {
        csType = baseType;
        if (!isAlreadyNullable && !isValueTypeRef(param.type)) {
          initializer = ' = default!;';
        }
      }

      const isRequiredEnum = param.required && isEnumRef(param.type);
      optionsLines.push(...emitXmlDoc(param.description, '        '));
      if (param.deprecated) {
        const msg = escapeCsAttributeString(deprecationMessage(param.description, 'parameter'));
        optionsLines.push(`        [System.Obsolete("${msg}")]`);
      }
      optionsLines.push(...emitJsonPropertyAttributes(param.name, { isRequiredEnum }));
      optionsLines.push(`        public ${csType} ${csField} { get; set; }${initializer}`);
      optionsLines.push('');
    }

    // Hidden fields that need to be set programmatically (e.g., grant_type, client_id)
    const defaults = getOpDefaults(resolvedOp);
    const inferFromClient = getOpInferFromClient(resolvedOp);
    for (const key of Object.keys(defaults)) {
      const csField = fieldName(key);
      if (emittedFields.has(csField)) continue;
      emittedFields.add(csField);
      optionsLines.push(`        [JsonProperty("${key}")]`);
      optionsLines.push(`        [STJS.JsonPropertyName("${key}")]`);
      optionsLines.push(`        internal string ${csField} { get; set; } = default!;`);
      optionsLines.push('');
    }
    for (const key of inferFromClient) {
      const csField = fieldName(key);
      if (emittedFields.has(csField)) continue;
      emittedFields.add(csField);
      optionsLines.push(`        [JsonProperty("${key}")]`);
      optionsLines.push(`        [STJS.JsonPropertyName("${key}")]`);
      optionsLines.push(`        internal string ${csField} { get; set; } = default!;`);
      optionsLines.push('');
    }

    optionsLines.push('    }');
  }

  optionsLines.push('}');

  if (!hasOptions) return null;

  return {
    path: `Services/${className(mountName)}/_interfaces/${className(mountName)}Options.cs`,
    content: optionsLines.join('\n'),
    overwriteExisting: true,
  };
}

function generateMethod(
  _serviceType: string,
  mountName: string,
  method: string,
  op: Operation,
  plan: OperationPlan,
  ctx: EmitterContext,
  resolvedOp?: ResolvedOperation,
): string {
  const lines: string[] = [];
  const isPaginated = plan.isPaginated;
  const isDelete = plan.isDelete;
  const hasBody = plan.hasBody && op.requestBody;
  const hidden = buildHiddenParams(resolvedOp);
  const hasVisibleQueryParams = op.queryParams.filter((qp) => !hidden.has(qp.name)).length > 0;

  let hasVisibleBodyFields = false;
  if (hasBody && op.requestBody?.kind === 'model') {
    const bodyModel = ctx.spec.models.find((m) => op.requestBody?.kind === 'model' && m.name === op.requestBody.name);
    if (bodyModel) hasVisibleBodyFields = bodyModel.fields.some((f) => !hidden.has(f.name));
  } else if (hasBody) {
    hasVisibleBodyFields = true;
  }

  const hasParams = hasVisibleBodyFields || hasVisibleQueryParams;
  const optionsClass = hasParams ? optionsClassName(mountName, method) : null;
  const hasHidden = hasHiddenParams(resolvedOp);

  // Per-operation Bearer token auth (e.g., SSO GetProfile uses access_token instead of API key)
  const hasBearerOverride = op.security?.some((s: any) => s.schemeName !== 'bearerAuth') ?? false;
  const bearerParamName = hasBearerOverride
    ? op.security!.find((s: any) => s.schemeName !== 'bearerAuth')!.schemeName
    : null;

  // URL-builder operations (e.g., /sso/authorize redirect endpoints) build a URL
  // string for the caller to redirect to instead of issuing an HTTP request.
  const isUrlBuilder = resolvedOp?.urlBuilder ?? false;

  // Return type
  let returnType: string;
  if (isUrlBuilder) {
    returnType = 'string';
  } else if (isPaginated && op.pagination) {
    const itemType = resolveListItemType(op.pagination.itemType, ctx);
    returnType = `Task<WorkOSList<${itemType}>>`;
  } else if (isDelete) {
    returnType = 'Task';
  } else if (plan.responseModelName) {
    const respType = className(plan.responseModelName);
    if (!isPaginated && op.response?.kind === 'array') {
      returnType = `Task<List<${respType}>>`;
    } else {
      returnType = `Task<${respType}>`;
    }
  } else {
    returnType = 'Task';
  }

  // XML doc comment (full multi-line description from the spec)
  lines.push(...emitXmlDoc(op.description, '        '));
  for (const p of sortPathParamsByTemplateOrder(op)) {
    const paramDesc = p.description ? escapeXml(p.description) : `The ${humanize(p.name)}.`;
    lines.push(`        /// <param name="${localName(p.name)}">${paramDesc}</param>`);
  }
  if (hasBearerOverride && bearerParamName) {
    lines.push(`        /// <param name="${localName(bearerParamName)}">The bearer token for authentication.</param>`);
  }
  if (optionsClass) {
    lines.push(`        /// <param name="options">Request options.</param>`);
  }
  if (!isUrlBuilder) {
    lines.push(`        /// <param name="requestOptions">Per-request configuration overrides.</param>`);
    lines.push(`        /// <param name="cancellationToken">Cancellation token.</param>`);
  }
  if (isUrlBuilder) {
    lines.push(`        /// <returns>The fully-qualified URL for the caller to redirect to.</returns>`);
  } else if (isPaginated && op.pagination) {
    const itemType = resolveListItemType(op.pagination.itemType, ctx);
    lines.push(`        /// <returns>A page of <see cref="${itemType}"/> results.</returns>`);
  } else if (plan.responseModelName) {
    const respType = className(plan.responseModelName);
    lines.push(`        /// <returns>The <see cref="${respType}"/> result.</returns>`);
  }
  if (op.deprecated) {
    const msg = escapeCsAttributeString(deprecationMessage(op.description, 'operation'));
    lines.push(`        [System.Obsolete("${msg}")]`);
  }

  // Method signature
  const params: string[] = [];
  for (const p of sortPathParamsByTemplateOrder(op)) {
    params.push(`string ${localName(p.name)}`);
  }
  if (hasBearerOverride && bearerParamName) {
    params.push(`string ${localName(bearerParamName)}`);
  }
  if (optionsClass) {
    const isRequired = hasVisibleBodyFields && !isPaginated;
    params.push(isRequired ? `${optionsClass} options` : `${optionsClass}? options = null`);
  }
  if (!isUrlBuilder) {
    params.push('RequestOptions? requestOptions = null');
    params.push('CancellationToken cancellationToken = default');
  }

  const asyncKeyword = isUrlBuilder ? '' : 'async ';
  lines.push(`        public virtual ${asyncKeyword}${returnType} ${method}(${params.join(', ')})`);
  lines.push('        {');

  // Inject hidden params
  if (hasHidden && optionsClass) {
    const isOptionalParam = !hasVisibleBodyFields || isPaginated;
    if (isOptionalParam) {
      lines.push(`            options ??= new ${optionsClass}();`);
    }
    const defaults = getOpDefaults(resolvedOp);
    const inferFromClient = getOpInferFromClient(resolvedOp);
    for (const [key, value] of Object.entries(defaults)) {
      lines.push(`            options.${fieldName(key)} = ${csLiteral(value as string | number | boolean)};`);
    }
    for (const field of inferFromClient) {
      if (field === 'client_id') {
        lines.push(`            options.${fieldName(field)} = this.Client.RequireClientId();`);
      } else {
        lines.push(
          `            options.${fieldName(field)} = this.Client.${clientFieldExpression(field)} ?? string.Empty;`,
        );
      }
    }
  }

  // Build path
  const pathExpr = buildPathExpr(op);

  // URL-builders and bearer-override operations keep the inlined WorkOSRequest
  // form because the Service helpers don't expose BuildRequestUri or
  // AccessToken configuration. Everything else uses the helper one-liners.
  const needsInlineRequest = isUrlBuilder || (hasBearerOverride && !!bearerParamName);
  const optionsArg = optionsClass ? 'options' : 'null';

  if (needsInlineRequest) {
    lines.push('            var request = new WorkOSRequest');
    lines.push('            {');
    lines.push(`                Method = HttpMethod.${httpMethodCs(op.httpMethod)},`);
    lines.push(`                Path = ${pathExpr},`);
    if (optionsClass) {
      lines.push('                Options = options,');
    }
    if (hasBearerOverride && bearerParamName) {
      lines.push(`                AccessToken = ${localName(bearerParamName)},`);
    }
    if (!isUrlBuilder) {
      lines.push(`                RequestOptions = requestOptions,`);
    }
    lines.push('            };');

    if (isUrlBuilder) {
      lines.push('            return this.Client.BuildRequestUri(request).ToString();');
    } else if (returnType.startsWith('Task<')) {
      const innerType = returnType.slice(5, -1);
      lines.push(`            return await this.Client.MakeAPIRequest<${innerType}>(request, cancellationToken);`);
    } else {
      lines.push('            await this.Client.MakeRawAPIRequest(request, cancellationToken);');
    }
  } else if (isDelete) {
    lines.push(`            await this.DeleteAsync(${pathExpr}, ${optionsArg}, requestOptions, cancellationToken);`);
  } else if (returnType.startsWith('Task<')) {
    const innerType = returnType.slice(5, -1);
    const helper = httpMethodHelperName(op.httpMethod);
    lines.push(
      `            return await this.${helper}<${innerType}>(${pathExpr}, ${optionsArg}, requestOptions, cancellationToken);`,
    );
  } else {
    const helper = httpMethodHelperName(op.httpMethod);
    lines.push(
      `            await this.${helper}<object>(${pathExpr}, ${optionsArg}, requestOptions, cancellationToken);`,
    );
  }

  lines.push('        }');
  return lines.join('\n');
}

function generateAutoPagingMethod(
  mountName: string,
  method: string,
  op: Operation,
  plan: OperationPlan,
  ctx: EmitterContext,
  resolvedOp?: ResolvedOperation,
): string {
  const lines: string[] = [];
  const hidden = buildHiddenParams(resolvedOp);
  const hasVisibleQueryParams = op.queryParams.filter((qp) => !hidden.has(qp.name)).length > 0;

  let hasVisibleBodyFields = false;
  if (plan.hasBody && op.requestBody?.kind === 'model') {
    const bodyModel = ctx.spec.models.find((m) => op.requestBody?.kind === 'model' && m.name === op.requestBody.name);
    if (bodyModel) hasVisibleBodyFields = bodyModel.fields.some((f) => !hidden.has(f.name));
  }

  const hasParams = hasVisibleBodyFields || hasVisibleQueryParams;
  const optionsClass = hasParams ? optionsClassName(mountName, method) : null;

  const itemType = resolveListItemType(op.pagination!.itemType, ctx);

  // XML doc
  lines.push(
    `        /// <summary>Auto-paging variant of <see cref="${method}"/>. Yields individual items across all pages.</summary>`,
  );
  for (const p of sortPathParamsByTemplateOrder(op)) {
    const paramDesc = p.description ? escapeXml(p.description) : `The ${humanize(p.name)}.`;
    lines.push(`        /// <param name="${localName(p.name)}">${paramDesc}</param>`);
  }
  if (optionsClass) {
    lines.push(`        /// <param name="options">Request options.</param>`);
  }
  lines.push(`        /// <param name="requestOptions">Per-request configuration overrides.</param>`);
  lines.push(`        /// <param name="cancellationToken">Cancellation token.</param>`);
  lines.push(`        /// <returns>An async sequence of <see cref="${itemType}"/> items.</returns>`);

  // Signature
  const params: string[] = [];
  for (const p of sortPathParamsByTemplateOrder(op)) {
    params.push(`string ${localName(p.name)}`);
  }
  if (optionsClass) {
    params.push(`${optionsClass}? options = null`);
  }
  params.push('RequestOptions? requestOptions = null');
  params.push('CancellationToken cancellationToken = default');

  lines.push(`        public virtual IAsyncEnumerable<${itemType}> ${method}AutoPagingAsync(${params.join(', ')})`);
  lines.push('        {');

  const pathExpr = buildPathExpr(op);
  const optionsArg = optionsClass ? 'options' : 'null';
  lines.push(
    `            return this.ListAutoPagingAsync<${itemType}>(${pathExpr}, ${optionsArg}, requestOptions, cancellationToken);`,
  );
  lines.push('        }');

  return lines.join('\n');
}

function resolveCsMethodName(op: Operation, mountName: string, ctx: EmitterContext): string {
  return resolveMethodName(op, { name: mountName, operations: [op] }, ctx);
}

export function optionsClassName(mountName: string, method: string): string {
  const prefix = className(mountName);
  if (method.startsWith(prefix)) return `${method}Options`;
  return `${prefix}${method}Options`;
}

function buildPathExpr(op: Operation): string {
  if (op.pathParams.length === 0) {
    return `"${op.path}"`;
  }
  // Build C# string interpolation
  let interpolated = op.path;
  for (const p of sortPathParamsByTemplateOrder(op)) {
    interpolated = interpolated.replace(`{${p.name}}`, `{${localName(p.name)}}`);
  }
  return `$"${interpolated}"`;
}

function resolveListItemType(itemType: import('@workos/oagen').TypeRef, ctx: EmitterContext): string {
  if (itemType.kind === 'model') {
    const model = ctx.spec.models.find((m) => m.name === itemType.name);
    if (model && isListWrapperModel(model)) {
      const dataField = model.fields.find((f) => f.name === 'data');
      if (dataField && dataField.type.kind === 'array' && dataField.type.items.kind === 'model') {
        return className(dataField.type.items.name);
      }
    }
    return className(itemType.name);
  }
  return mapTypeRef(itemType);
}
