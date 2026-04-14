import type {
  Service,
  Operation,
  Parameter,
  EmitterContext,
  GeneratedFile,
  ResolvedOperation,
  Model,
  TypeRef,
  Field,
} from '@workos/oagen';
import { planOperation } from '@workos/oagen';
import { mapTypeRef, mapTypeRefOptional, implicitImportsFor } from './type-map.js';
import { isListWrapperModel, isListMetadataModel } from '../shared/model-utils.js';
import { enumCanonicalMap } from './enums.js';
import {
  className,
  propertyName,
  apiClassName,
  packageSegment,
  resolveMethodName,
  ktLiteral,
  clientFieldExpression,
  escapeReserved,
} from './naming.js';
import {
  buildResolvedLookup,
  lookupResolved,
  groupByMount,
  buildHiddenParams,
  getOpDefaults,
  getOpInferFromClient,
} from '../shared/resolved-ops.js';
import { generateWrapperMethods } from './wrappers.js';
import { resolveWrapperParams } from '../shared/wrapper-utils.js';
import { isHandwrittenOverride } from './overrides.js';

const KOTLIN_SRC_PREFIX = 'src/main/kotlin/';

/**
 * Generate one API class per mount group. Methods map 1:1 to IR operations.
 * Path params, query params, and body fields are flattened into the method
 * signature so callers never need to construct an intermediate options object.
 */
export function generateResources(services: Service[], ctx: EmitterContext): GeneratedFile[] {
  if (services.length === 0) return [];

  const mountGroups = groupByMount(ctx);
  if (mountGroups.size === 0) return [];

  const files: GeneratedFile[] = [];
  const resolvedLookup = buildResolvedLookup(ctx);

  for (const [mountName, group] of mountGroups) {
    const classCode = generateApiClass(mountName, group.operations, ctx, resolvedLookup);
    if (!classCode) continue;
    const pkg = packageSegment(mountName);
    files.push({
      path: `${KOTLIN_SRC_PREFIX}com/workos/${pkg}/${apiClassName(mountName)}.kt`,
      content: classCode,
      overwriteExisting: true,
    });
  }

  return files;
}

function generateApiClass(
  mountName: string,
  operations: Operation[],
  ctx: EmitterContext,
  resolvedLookup: Map<string, ResolvedOperation>,
): string | null {
  if (operations.length === 0) return null;
  const apiClass = apiClassName(mountName);
  const pkg = `com.workos.${packageSegment(mountName)}`;

  const imports = new Set<string>();
  imports.add('com.workos.WorkOS');
  imports.add('com.workos.common.http.Page');
  imports.add('com.workos.common.http.RequestConfig');
  imports.add('com.workos.common.http.RequestOptions');

  const body: string[] = [];
  const seenMethods = new Set<string>();

  for (const op of operations) {
    if (isHandwrittenOverride(op)) continue;
    const resolvedOp = lookupResolved(op, resolvedLookup);
    if ((resolvedOp?.wrappers?.length ?? 0) > 0) {
      // Emit one method per wrapper instead of the raw union-split operation.
      for (const wrapper of resolvedOp!.wrappers!) {
        if (wrapper.responseModelName) {
          imports.add(`com.workos.models.${className(wrapper.responseModelName)}`);
        }
        // Register imports for wrapper param field types
        const resolvedParams = resolveWrapperParams(wrapper, ctx);
        for (const rp of resolvedParams) {
          if (rp.field) registerTypeImports(rp.field.type, imports, ctx);
        }
      }
      // Wrapper methods use bodyOf() for request body construction.
      imports.add('com.workos.common.http.bodyOf');
      const wrapperLines = generateWrapperMethods(resolvedOp!, ctx);
      if (body.length > 0) body.push('');
      for (const line of wrapperLines) body.push(line);
      continue;
    }

    const method = resolveMethodName(op, findService(ctx, op) ?? ({} as Service), ctx);
    if (seenMethods.has(method)) continue;
    seenMethods.add(method);

    const rendered = renderMethod(mountName, method, op, ctx, resolvedOp, imports);
    if (body.length > 0) body.push('');
    body.push(rendered);
  }

  if (body.length === 0) return null;

  // Drop unused imports by peeking at the body text.
  const bodyText = body.join('\n');
  const filteredImports = [...imports].filter((imp) => {
    const simple = imp.slice(imp.lastIndexOf('.') + 1);
    // Skip the import if the class body never references the simple name.
    if (simple === 'WorkOS' || simple === 'RequestConfig' || simple === 'RequestOptions') return true;
    return new RegExp(`\\b${simple}\\b`).test(bodyText);
  });

  const lines: string[] = [];
  lines.push(`package ${pkg}`);
  lines.push('');
  for (const imp of filteredImports.sort()) lines.push(`import ${imp}`);
  lines.push('');
  const serviceDescription = resolveServiceDescription(ctx, mountName, operations);
  if (serviceDescription) {
    const docLines = serviceDescription.trim().split('\n');
    if (docLines.length === 1) {
      lines.push(`/** ${escapeKdoc(docLines[0].trim())} */`);
    } else {
      lines.push('/**');
      for (const l of docLines) lines.push(l ? ` * ${escapeKdoc(l)}` : ' *');
      lines.push(' */');
    }
  } else {
    lines.push(`/** API accessor for ${mountName}. */`);
  }
  // ktlint requires constructor-property parameters on their own line.
  // The property is `internal` so hand-maintained extension files in the
  // same module can reach the underlying [WorkOS] client (e.g. to build
  // URLs that are not HTTP calls).
  lines.push(`class ${apiClass}(`);
  lines.push('  internal val workos: WorkOS');
  lines.push(`) {`);
  for (const line of body) lines.push(line);
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

function findService(ctx: EmitterContext, op: Operation): Service | undefined {
  for (const service of ctx.spec.services) {
    if (service.operations.includes(op)) return service;
  }
  return undefined;
}

/**
 * Resolve a human-friendly description for a generated API class. Walks the
 * operations in the mount group, picks the first service whose description
 * is populated, and falls back to `null` when nothing meaningful is
 * available (the caller uses a generic fallback).
 */
function resolveServiceDescription(ctx: EmitterContext, _mountName: string, operations: Operation[]): string | null {
  for (const op of operations) {
    const svc = findService(ctx, op);
    if (svc?.description?.trim()) return svc.description;
  }
  return null;
}

/**
 * Render a single SDK method for an operation.
 */
function renderMethod(
  _mountName: string,
  method: string,
  op: Operation,
  ctx: EmitterContext,
  resolvedOp: ResolvedOperation | undefined,
  imports: Set<string>,
): string {
  const plan = planOperation(op);
  const hidden = buildHiddenParams(resolvedOp);
  const defaults = getOpDefaults(resolvedOp);
  const inferFromClient = getOpInferFromClient(resolvedOp);

  const httpMethod = op.httpMethod.toUpperCase();
  const pathParams = sortPathParamsByTemplateOrder(op);
  const queryParams = op.queryParams.filter((p) => !hidden.has(p.name));
  const bodyModel = resolveBodyModel(op, ctx);
  const bodyFields = bodyModel ? bodyModel.fields.filter((f) => !hidden.has(f.name)) : [];

  // Track imports we need
  for (const p of [...pathParams, ...queryParams]) registerTypeImports(p.type, imports, ctx);
  for (const f of bodyFields) registerTypeImports(f.type, imports, ctx);
  const paginatedItemName = resolvePaginatedItemName(plan.paginatedItemModelName, ctx);
  if (plan.responseModelName && !plan.isPaginated) {
    imports.add(`com.workos.models.${className(plan.responseModelName)}`);
  }
  if (paginatedItemName) {
    imports.add(`com.workos.models.${className(paginatedItemName)}`);
    imports.add('com.fasterxml.jackson.core.type.TypeReference');
  }

  // Deduplicate: path params take precedence; query params second; body last.
  // If a body field collides with a path/query param, rename the body field's
  // Kotlin parameter (e.g. `slug` → `bodySlug`) so callers can pass both
  // values. The wire name on the body map still uses the original field name.
  const paramNames = new Set<string>();
  for (const pp of pathParams) paramNames.add(propertyName(pp.name));
  const uniqueQuery = queryParams.filter((qp) => !paramNames.has(propertyName(qp.name)));
  for (const qp of uniqueQuery) paramNames.add(propertyName(qp.name));

  // Map body field wire name → Kotlin parameter name. When the natural name
  // collides with a path/query, prefix with `body` (e.g. slug → bodySlug).
  const bodyParamNames = new Map<string, string>();
  for (const bf of bodyFields) {
    const natural = propertyName(bf.name);
    if (paramNames.has(natural)) {
      const renamed = `body${natural.charAt(0).toUpperCase()}${natural.slice(1)}`;
      bodyParamNames.set(bf.name, renamed);
      paramNames.add(renamed);
    } else {
      bodyParamNames.set(bf.name, natural);
      paramNames.add(natural);
    }
  }

  const params: string[] = [];
  for (const pp of pathParams) params.push(`    ${propertyName(pp.name)}: String`);

  const sortedQuery = [...uniqueQuery].sort((a, b) => (a.required === b.required ? 0 : a.required ? -1 : 1));
  for (const qp of sortedQuery) {
    params.push(renderParam(qp.name, qp.type, qp.required));
  }

  // PATCH operations use PatchField<T> for optional body fields so callers
  // can distinguish "omit" (Absent) from "clear" (Present(null)).
  const isPatch = httpMethod === 'PATCH';

  const sortedBodyFields = [...bodyFields].sort((a, b) => (a.required === b.required ? 0 : a.required ? -1 : 1));
  for (const bf of sortedBodyFields) {
    if (isPatch && !bf.required) {
      const baseType = mapTypeRef(bf.type);
      imports.add('com.workos.common.http.PatchField');
      params.push(`    ${bodyParamNames.get(bf.name)!}: PatchField<${baseType}> = PatchField.Absent`);
    } else {
      params.push(renderParamNamed(bodyParamNames.get(bf.name)!, bf.type, bf.required));
    }
  }

  // Per-request options trailer (always optional)
  params.push('    requestOptions: RequestOptions? = null');

  const returnType = resolveReturnType(plan, imports, ctx);
  const isPaginated = plan.isPaginated && paginatedItemName !== null;

  const lines: string[] = [];
  const kdocLines = buildMethodKdoc(op, pathParams, sortedQuery, sortedBodyFields, bodyParamNames, plan);
  for (const ln of kdocLines) lines.push(ln);
  if (op.deprecated) lines.push('  @Deprecated("Deprecated operation")');
  lines.push('  @JvmOverloads');
  // Omit explicit `: Unit` to keep ktlint happy.
  const returnClause = returnType === 'Unit' ? '' : `: ${returnType}`;
  if (params.length === 1) {
    // Single param fits on one line; ktlint enforces inline form.
    const singleParam = params[0].replace(/^\s+/, '');
    lines.push(`  fun ${escapeReserved(method)}(${singleParam})${returnClause} {`);
  } else {
    lines.push(`  fun ${escapeReserved(method)}(`);
    for (let i = 0; i < params.length; i++) {
      const suffix = i === params.length - 1 ? '' : ',';
      lines.push(`${params[i]}${suffix}`);
    }
    lines.push(`  )${returnClause} {`);
  }

  // Build body / query config
  //
  // POST/PUT/PATCH always need a request body — OkHttp rejects them otherwise.
  // DELETE and GET only emit a body when the spec explicitly declares one
  // (OpenAPI allows DELETE-with-body; GET-with-body is uncommon but legal).
  // GET never carries defaults/inferFromClient in the body — those fall back
  // to the query string for GET.
  const methodAlwaysHasBody = ['POST', 'PUT', 'PATCH'].includes(httpMethod);
  const specDeclaresBody = op.requestBody !== undefined;
  const hasBody =
    methodAlwaysHasBody ||
    (specDeclaresBody && httpMethod !== 'GET') ||
    ((httpMethod === 'PUT' || httpMethod === 'PATCH' || httpMethod === 'POST' || httpMethod === 'DELETE') &&
      (Object.keys(defaults).length > 0 || inferFromClient.length > 0) &&
      specDeclaresBody);
  const appendDefaultsAsQuery = !hasBody && (Object.keys(defaults).length > 0 || inferFromClient.length > 0);
  const pathExpr = buildPathExpression(op.path, pathParams);

  if (isPaginated) {
    // Nested helper function + requestPage call; 'after' is owned by the
    // cursor logic so we skip it in the generic query loop.
    const queryForConfig = sortedQuery.filter((p) => p.name !== 'after');
    lines.push(`    fun configFor(afterCursor: String? = null): RequestConfig {`);
    lines.push(`      val params = mutableListOf<Pair<String, String>>()`);
    for (const qp of queryForConfig) for (const ln of emitQueryParam(qp, '      ')) lines.push(ln);
    lines.push(`      val effectiveAfter = afterCursor ?: ${pickNamedQueryParam(sortedQuery, 'after')}`);
    lines.push(`      if (effectiveAfter != null) params += "after" to effectiveAfter`);
    lines.push(`      return RequestConfig(`);
    lines.push(`        method = ${ktLiteral(httpMethod)},`);
    lines.push(`        path = ${pathExpr},`);
    lines.push(`        queryParams = params,`);
    lines.push(`        requestOptions = requestOptions`);
    lines.push(`      )`);
    lines.push(`    }`);
    const itemClass = className(paginatedItemName!);
    lines.push(`    val itemType = object : TypeReference<${itemClass}>() {}`);
    lines.push(
      `    return workos.baseClient.requestPage(configFor(), itemType) { afterCursor -> configFor(afterCursor) }`,
    );
  } else {
    // Only emit the `params` local when the method actually contributes
    // query parameters (spec-declared query, or defaults/inferFromClient
    // for GET/DELETE without a body). `RequestConfig.queryParams` defaults
    // to `emptyList()` when omitted, so we avoid dead local declarations.
    const emitsQueryParams = sortedQuery.length > 0 || appendDefaultsAsQuery;
    if (emitsQueryParams) {
      lines.push(`    val params = mutableListOf<Pair<String, String>>()`);
      for (const qp of sortedQuery) for (const ln of emitQueryParam(qp, '    ')) lines.push(ln);
      if (appendDefaultsAsQuery) {
        for (const [k, v] of Object.entries(defaults)) lines.push(`    params += ${ktLiteral(k)} to ${ktLiteral(v)}`);
        // Client-inferred fields may be nullable (e.g. clientId). Skip when
        // null rather than serializing "null" into the URL.
        for (const k of inferFromClient) {
          lines.push(`    workos.${clientFieldExpression(k)}?.let { params += ${ktLiteral(k)} to it }`);
        }
      }
    }

    if (hasBody) {
      // Use bodyOf() / patchBodyOf() helpers to build the request body in a
      // single expression. This drops null optional values automatically
      // instead of repeating `if (x != null) body["x"] = x` per field.
      const helperFn = isPatch ? 'patchBodyOf' : 'bodyOf';
      imports.add(`com.workos.common.http.${helperFn}`);
      const bodyEntries: string[] = [];
      for (const bf of sortedBodyFields) {
        const prop = bodyParamNames.get(bf.name)!;
        bodyEntries.push(`      ${ktLiteral(bf.name)} to ${prop}`);
      }
      for (const [k, v] of Object.entries(defaults)) {
        bodyEntries.push(`      ${ktLiteral(k)} to ${ktLiteral(v)}`);
      }
      for (const k of inferFromClient) {
        bodyEntries.push(`      ${ktLiteral(k)} to workos.${clientFieldExpression(k)}`);
      }
      if (bodyEntries.length > 0) {
        // ktlint: "A multiline expression should start on a new line"
        lines.push(`    val body =`);
        lines.push(`      ${helperFn}(`);
        for (let i = 0; i < bodyEntries.length; i++) {
          const sep = i === bodyEntries.length - 1 ? '' : ',';
          lines.push(`  ${bodyEntries[i]}${sep}`);
        }
        lines.push(`      )`);
      } else {
        // Empty body (POST/PUT/PATCH still require one for OkHttp).
        lines.push(`    val body = linkedMapOf<String, Any?>()`);
      }
      lines.push(`    val config =`);
      lines.push(`      RequestConfig(`);
      lines.push(`        method = ${ktLiteral(httpMethod)},`);
      lines.push(`        path = ${pathExpr},`);
      if (emitsQueryParams) lines.push(`        queryParams = params,`);
      lines.push(`        body = body,`);
      lines.push(`        requestOptions = requestOptions`);
      lines.push(`      )`);
    } else {
      lines.push(`    val config =`);
      lines.push(`      RequestConfig(`);
      lines.push(`        method = ${ktLiteral(httpMethod)},`);
      lines.push(`        path = ${pathExpr},`);
      if (emitsQueryParams) lines.push(`        queryParams = params,`);
      lines.push(`        requestOptions = requestOptions`);
      lines.push(`      )`);
    }

    if (plan.responseModelName && plan.isArrayResponse) {
      // `type: array` response — deserialize as List<T> via TypeReference.
      const itemClass = className(plan.responseModelName);
      imports.add('com.fasterxml.jackson.core.type.TypeReference');
      lines.push(`    val responseType = object : TypeReference<List<${itemClass}>>() {}`);
      lines.push(`    return workos.baseClient.request(config, responseType)`);
    } else if (plan.responseModelName) {
      const responseClass = className(plan.responseModelName);
      lines.push(`    return workos.baseClient.request(config, ${responseClass}::class.java)`);
    } else if (plan.isDelete || !plan.isModelResponse) {
      lines.push(`    workos.baseClient.requestVoid(config)`);
    } else {
      lines.push(`    workos.baseClient.requestVoid(config)`);
    }
  }

  lines.push('  }');
  return lines.join('\n');
}

function resolveReturnType(plan: ReturnType<typeof planOperation>, imports: Set<string>, ctx?: EmitterContext): string {
  const itemName = plan.isPaginated
    ? (resolvePaginatedItemName(plan.paginatedItemModelName, ctx) ?? plan.paginatedItemModelName)
    : null;
  if (plan.isPaginated && itemName) {
    const item = className(itemName);
    imports.add(`com.workos.models.${item}`);
    return `Page<${item}>`;
  }
  if (plan.responseModelName && plan.isArrayResponse) {
    const cls = className(plan.responseModelName);
    imports.add(`com.workos.models.${cls}`);
    return `List<${cls}>`;
  }
  if (plan.responseModelName) {
    const cls = className(plan.responseModelName);
    imports.add(`com.workos.models.${cls}`);
    return cls;
  }
  return 'Unit';
}

/**
 * If [paginatedItemModelName] points to a list wrapper (`{ data, list_metadata }`),
 * unwrap it and return the actual item model name. Otherwise return as-is.
 */
function resolvePaginatedItemName(name: string | null, ctx?: EmitterContext): string | null {
  if (!name || !ctx) return name;
  const model = ctx.spec.models.find((m) => m.name === name);
  if (!model) return name;
  const dataField = model.fields.find((f) => f.name === 'data');
  if (!dataField || dataField.type.kind !== 'array') return name;
  const items = dataField.type.items;
  if (items.kind === 'model') return items.name;
  return name;
}

function renderParam(name: string, type: TypeRef, required: boolean): string {
  return renderParamNamed(propertyName(name), type, required);
}

function renderParamNamed(kotlinName: string, type: TypeRef, required: boolean): string {
  const mapped = required ? mapTypeRef(type) : mapTypeRefOptional(type);
  return required ? `    ${kotlinName}: ${mapped}` : `    ${kotlinName}: ${mapped} = null`;
}

/**
 * Build the KDoc block preceding an SDK method.  Combines the operation's
 * summary/description with `@param` docs for every parameter that has a
 * description in the spec, `@return` when a response model is known, and
 * `@throws` for the standard error types.
 */
function buildMethodKdoc(
  op: Operation,
  pathParams: Parameter[],
  queryParams: Parameter[],
  bodyFields: Field[],
  bodyParamNames: Map<string, string>,
  plan: ReturnType<typeof planOperation>,
): string[] {
  // Use the operation's description as the KDoc body, split by newline.
  // Escape `*/` sequences to keep KDoc valid.
  const descriptionRaw = (op.description ?? '').trim();
  const textLines: string[] = [];
  if (descriptionRaw) {
    for (const l of descriptionRaw.split('\n')) textLines.push(escapeKdoc(l));
  }

  // @param lines. Use the Kotlin-visible parameter name (body collisions get
  // renamed, e.g. slug → bodySlug).  Deprecated parameters always get a
  // @param entry even without a description so the deprecation note is
  // surfaced in the docs.
  const paramDocs: string[] = [];
  for (const pp of pathParams) {
    if (pp.description?.trim() || pp.deprecated) {
      paramDocs.push(formatParamDoc(propertyName(pp.name), pp.description, pp.deprecated));
    }
  }
  for (const qp of queryParams) {
    if (qp.description?.trim() || qp.deprecated) {
      paramDocs.push(formatParamDoc(propertyName(qp.name), qp.description, qp.deprecated));
    }
  }
  for (const bf of bodyFields) {
    if (bf.description?.trim() || bf.deprecated) {
      paramDocs.push(formatParamDoc(bodyParamNames.get(bf.name)!, bf.description, bf.deprecated));
    }
  }

  const returnDoc = plan.isPaginated
    ? '@return a [com.workos.common.http.Page] of results'
    : plan.responseModelName
      ? `@return the ${plan.isArrayResponse ? `list of ${className(plan.responseModelName)}` : className(plan.responseModelName)}`
      : null;

  const hasAnyContent = textLines.length > 0 || paramDocs.length > 0 || returnDoc !== null;
  if (!hasAnyContent) return [];

  const out: string[] = ['  /**'];
  for (const l of textLines) out.push(l ? `   * ${l}` : '   *');
  const hasBodyText = textLines.length > 0;
  const needsSpacer = hasBodyText && (paramDocs.length > 0 || returnDoc !== null);
  if (needsSpacer) out.push('   *');
  for (const p of paramDocs) out.push(`   * ${p}`);
  if (returnDoc) {
    if (paramDocs.length > 0) out.push('   *');
    out.push(`   * ${returnDoc}`);
  }
  out.push('   */');
  return out;
}

function formatParamDoc(kotlinName: string, description: string | undefined, deprecated?: boolean): string {
  const firstLine = description?.split('\n').find((l) => l.trim()) ?? '';
  const text = firstLine.trim();
  const deprecationNote = deprecated ? '**Deprecated.**' : '';
  const parts = [deprecationNote, text].filter(Boolean).join(' ');
  return `@param ${kotlinName}${parts ? ` ${escapeKdoc(parts)}` : ''}`;
}

/**
 * Unwrap a possibly-nullable type to check if the inner type is an array,
 * and return the array's item type for downstream serialization decisions.
 */
function unwrapArray(t: TypeRef): TypeRef | null {
  if (t.kind === 'array') return t.items;
  if (t.kind === 'nullable' && t.inner.kind === 'array') return t.inner.items;
  return null;
}

/**
 * Serialize a single value expression for a query parameter.  For enums we
 * use `.value` so the wire name is used; for everything else `.toString()`.
 */
function valueExprForQuery(type: TypeRef): string {
  const inner = type.kind === 'nullable' ? type.inner : type;
  if (inner.kind === 'enum') return 'it.value';
  return 'it.toString()';
}

function emitQueryParam(p: Parameter, indent: string): string[] {
  const prop = propertyName(p.name);
  const rendered = queryParamToString(p.type, prop);
  const arrayItem = unwrapArray(p.type);
  if (arrayItem) {
    // Honor `style: form, explode: false` → comma-joined. Default (explode:true
    // or unspecified for form) → repeated keys.  `p.explode ?? true` matches
    // the OpenAPI default for query parameters when `style` is form.
    const explode = p.explode ?? true;
    const itemExpr = valueExprForQuery(arrayItem);
    if (!explode) {
      if (p.required) {
        return [`${indent}params += ${ktLiteral(p.name)} to ${prop}.joinToString(",") { ${itemExpr} }`];
      }
      return [
        `${indent}if (${prop} != null) params += ${ktLiteral(p.name)} to ${prop}.joinToString(",") { ${itemExpr} }`,
      ];
    }
    if (p.required) {
      return [`${indent}${prop}.forEach { params += ${ktLiteral(p.name)} to ${itemExpr} }`];
    }
    return [`${indent}if (${prop} != null) ${prop}.forEach { params += ${ktLiteral(p.name)} to ${itemExpr} }`];
  }
  if (p.required) return [`${indent}params += ${ktLiteral(p.name)} to ${rendered}`];
  return [`${indent}if (${prop} != null) params += ${ktLiteral(p.name)} to ${rendered}`];
}

function queryParamToString(type: TypeRef, varName: string): string {
  if (type.kind === 'enum') return `${varName}.value`;
  if (type.kind === 'nullable') return queryParamToString(type.inner, varName);
  return `${varName}.toString()`;
}

function _emitBodyField(field: Field, kotlinParamName: string, isPatch: boolean): string[] {
  const prop = kotlinParamName;
  if (field.required) return [`    body[${ktLiteral(field.name)}] = ${prop}`];
  // PATCH: PatchField<T> — serialize Present(value) including explicit null;
  // skip Absent entirely so the server preserves the field's current value.
  if (isPatch) {
    return [`    if (${prop} is PatchField.Present) body[${ktLiteral(field.name)}] = ${prop}.value`];
  }
  return [`    if (${prop} != null) body[${ktLiteral(field.name)}] = ${prop}`];
}

function buildPathExpression(path: string, pathParams: Parameter[]): string {
  if (pathParams.length === 0) return ktLiteral(path);
  let result = path;
  for (const pp of pathParams) {
    const placeholder = `{${pp.name}}`;
    const propName = propertyName(pp.name);
    // Use $propName for simple identifiers and ${propName} only when followed by
    // an ident-continuing char (to avoid false continuations). ktlint prefers the
    // unbraced form for bare identifiers.
    const replacement = isBareIdentifier(propName) ? `\$${propName}` : `\${${propName}}`;
    result = result.replaceAll(placeholder, replacement);
  }
  return `"${result.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function isBareIdentifier(name: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

function pickNamedQueryParam(sorted: Parameter[], name: string): string {
  const match = sorted.find((p) => p.name === name);
  return match ? propertyName(match.name) : 'null';
}

function resolveBodyModel(op: Operation, ctx: EmitterContext): Model | null {
  const body = op.requestBody;
  if (!body) return null;
  if (body.kind !== 'model') return null;
  return ctx.spec.models.find((m) => m.name === body.name) ?? null;
}

function registerTypeImports(ref: TypeRef, imports: Set<string>, ctx: EmitterContext): void {
  const mapped = mapTypeRef(ref);
  for (const imp of implicitImportsFor(mapped)) imports.add(imp);

  walk(ref, (r) => {
    if (r.kind === 'enum') {
      // When an enum is aliased, import the canonical class instead of the alias.
      const canonicalName = enumCanonicalMap.get(r.name) ?? r.name;
      imports.add(`com.workos.types.${className(canonicalName)}`);
    }
    if (r.kind === 'model') {
      const referenced = ctx.spec.models.find((m) => m.name === r.name);
      if (referenced && (isListWrapperModel(referenced) || isListMetadataModel(referenced))) return;
      imports.add(`com.workos.models.${className(r.name)}`);
    }
  });
}

function walk(ref: TypeRef, fn: (r: TypeRef) => void): void {
  fn(ref);
  if (ref.kind === 'array') walk(ref.items, fn);
  else if (ref.kind === 'map') walk(ref.valueType, fn);
  else if (ref.kind === 'nullable') walk(ref.inner, fn);
  else if (ref.kind === 'union') for (const v of ref.variants) walk(v, fn);
}

/** Sort operation path parameters by their first appearance in the URL template. */
export function sortPathParamsByTemplateOrder(op: Operation): Parameter[] {
  return [...op.pathParams].sort((a, b) => {
    const posA = op.path.indexOf(`{${a.name}}`);
    const posB = op.path.indexOf(`{${b.name}}`);
    return posA - posB;
  });
}

function escapeKdoc(s: string): string {
  return s.replace(/\*\//g, '*\u200b/');
}
