import type {
  Service,
  EmitterContext,
  GeneratedFile,
  Operation,
  Field,
  TypeRef,
  ResolvedOperation,
} from '@workos/oagen';
import { planOperation } from '@workos/oagen';
import { parsePathTemplate } from '../shared/path-template.js';
import { unwrapListModel } from '../shared/model-utils.js';
import { scopedMountGroups, buildHiddenParams, getOpDefaults, getOpInferFromClient } from '../shared/resolved-ops.js';
import {
  typeName,
  resourceTypeName,
  propertyName,
  resolveMethodName,
  withResolvedOps,
  mainSourcePath,
  subPackage,
  ktStringLiteral,
  ktLiteral,
  ktTemplatePart,
} from './naming.js';
import { fieldKotlinType, mapTypeRef, implicitImportsFor } from './type-map.js';
import { resolveTypeImports, renderImportBlock } from './imports.js';
import { generateWrapperMethods } from './wrappers.js';
import { renderMethodDoc } from './doc-comments.js';

/**
 * Generate one Kotlin resource class per mount group. Each operation becomes a
 * `suspend fun`; path/query/body params are flattened into the signature.
 */
export function generateResources(_services: Service[], ctx: EmitterContext): GeneratedFile[] {
  const rctx = withResolvedOps(ctx);
  const groups = [...scopedMountGroups(rctx).values()].sort((a, b) => a.name.localeCompare(b.name));
  return groups.map((group) => ({
    path: mainSourcePath(rctx, 'resources', resourceTypeName(group.name, rctx)),
    content: renderResource(group.name, group.resolvedOps, rctx),
  }));
}

// --- TypeRef helpers --------------------------------------------------------

function unwrapNullable(ref: TypeRef): TypeRef {
  return ref.kind === 'nullable' ? ref.inner : ref;
}
function isEnumRef(ref: TypeRef): boolean {
  return unwrapNullable(ref).kind === 'enum';
}
function isStringPrimitive(ref: TypeRef): boolean {
  const base = unwrapNullable(ref);
  return base.kind === 'primitive' && base.type === 'string' && base.format !== 'date-time' && base.format !== 'date';
}

// --- rendering --------------------------------------------------------------

/** A rendered method block plus the imports its body and signature require. */
export interface RenderedMethod {
  name: string;
  lines: string[];
  imports: string[];
}

function renderResource(mountName: string, resolvedOps: ResolvedOperation[], ctx: EmitterContext): string {
  const resourceName = resourceTypeName(mountName, ctx);
  const pkg = subPackage(ctx, 'resources');
  const methods: RenderedMethod[] = [];
  const seen = new Set<string>();

  for (const resolved of resolvedOps) {
    if (resolved.urlBuilder) {
      const method = resolveMethodName(resolved.operation, mountName, ctx);
      if (seen.has(method)) continue;
      seen.add(method);
      methods.push(renderUrlBuilderMethod(resolved, method, ctx));
      continue;
    }
    if (resolved.wrappers && resolved.wrappers.length > 0) {
      for (const block of generateWrapperMethods(resolved, ctx)) {
        if (seen.has(block.name)) continue;
        seen.add(block.name);
        methods.push(block);
      }
      continue;
    }
    const method = resolveMethodName(resolved.operation, mountName, ctx);
    if (seen.has(method)) continue;
    seen.add(method);
    methods.push(renderMethod(resolved, mountName, method, ctx));

    // Cursor-paginated operations get an auto-paginating companion that walks
    // every page through the same underlying method.
    const auto = renderAutoPagingMethod(resolved, method, ctx);
    if (auto && !seen.has(auto.name)) {
      seen.add(auto.name);
      methods.push(auto);
    }
  }

  const imports = new Set<string>([`${subPackage(ctx, 'internal')}.Transport`]);
  for (const m of methods) {
    for (const imp of m.imports) imports.add(imp);
  }

  const lines: string[] = [];
  lines.push(`package ${pkg}`);
  lines.push('');
  const importLines = renderImportBlock(imports, pkg);
  if (importLines.length > 0) {
    lines.push(...importLines);
    lines.push('');
  }
  lines.push(`/** Operations for the ${resourceName} API. */`);
  lines.push(`public class ${resourceName} internal constructor(`);
  lines.push('    private val transport: Transport,');
  lines.push(') {');
  let first = true;
  for (const m of methods) {
    if (!first) lines.push('');
    first = false;
    lines.push(...m.lines);
  }
  lines.push('}');
  return lines.join('\n');
}

export interface RenderedParam {
  name: string;
  wire: string;
  type: string;
  optional: boolean;
  ref: TypeRef;
  kind: 'path' | 'query' | 'body' | 'bodyRaw';
  deprecated?: boolean;
  description?: string;
}

/**
 * Collect the flattened method parameters (path, body, query) for an operation
 * in collection order, applying the same hidden-param filtering and name
 * de-duplication the resource methods use. Exported so the smoke runner can
 * reconstruct the exact call signature.
 */
export function collectMethodParams(resolved: ResolvedOperation, ctx: EmitterContext): RenderedParam[] {
  const op = resolved.operation;
  const hidden = buildHiddenParams(resolved);
  const params: RenderedParam[] = [];
  const usedNames = new Set<string>();
  const dedupe = (name: string): string => {
    let candidate = name;
    let n = 2;
    while (usedNames.has(candidate)) candidate = `${name}${n++}`;
    usedNames.add(candidate);
    return candidate;
  };

  // Path params in template order.
  const pathParamOrder = parsePathTemplate(op.path)
    .filter((s) => s.kind === 'param')
    .map((s) => (s.kind === 'param' ? s.name : ''));
  const pathByWire = new Map(op.pathParams.map((p) => [p.name, p]));
  for (const wire of pathParamOrder) {
    const p = pathByWire.get(wire);
    if (!p || hidden.has(p.name)) continue;
    params.push({
      name: dedupe(propertyName(p.name)),
      wire: p.name,
      type: fieldKotlinType(p.type, true),
      optional: false,
      ref: p.type,
      kind: 'path',
      deprecated: p.deprecated,
      description: p.description,
    });
  }

  // Body params: expand a model body's fields, or a single raw body param.
  const bodyFields = resolveBodyFields(op, ctx);
  if (bodyFields === 'raw' && op.requestBody) {
    params.push({
      name: dedupe('body'),
      wire: '',
      // A raw body is serialized whole. A model ref keeps its generated type (the
      // emitter can name its compile-time serializer); any other shape is exposed
      // as raw JSON, since there is no named serializer to reference.
      type: rawBodyIsModel(op.requestBody) ? mapTypeRef(op.requestBody) : 'JsonElement',
      optional: false,
      ref: op.requestBody,
      kind: 'bodyRaw',
    });
  } else if (bodyFields !== 'raw' && bodyFields) {
    for (const f of bodyFields) {
      if (hidden.has(f.name)) continue;
      const type = fieldKotlinType(f.type, f.required);
      params.push({
        name: dedupe(propertyName(f.domainName ?? f.name)),
        wire: f.name,
        type,
        optional: type.endsWith('?'),
        ref: f.type,
        kind: 'body',
        deprecated: f.deprecated,
        description: f.description,
      });
    }
  }

  // Query params.
  for (const q of op.queryParams) {
    if (hidden.has(q.name)) continue;
    const type = fieldKotlinType(q.type, q.required);
    params.push({
      name: dedupe(propertyName(q.name)),
      wire: q.name,
      type,
      optional: type.endsWith('?'),
      ref: q.type,
      kind: 'query',
      deprecated: q.deprecated,
      description: q.description,
    });
  }

  return params;
}

/** Signature order: required params first, optionals after. */
export function orderMethodParams(params: RenderedParam[]): RenderedParam[] {
  return [...params].sort((a, b) => Number(a.optional) - Number(b.optional));
}

/** Imports implied by a parameter list plus a return type. */
function collectMethodImports(ctx: EmitterContext, typeExprs: string[]): string[] {
  const imports = new Set<string>();
  for (const expr of typeExprs) {
    for (const imp of implicitImportsFor(expr)) imports.add(imp);
  }
  for (const imp of resolveTypeImports(ctx, typeExprs)) imports.add(imp);
  return [...imports];
}

function renderMethod(
  resolved: ResolvedOperation,
  mountName: string,
  method: string,
  ctx: EmitterContext,
): RenderedMethod {
  const op = resolved.operation;
  const plan = planOperation(op);
  const defaults = getOpDefaults(resolved);
  const infer = getOpInferFromClient(resolved);

  const params = collectMethodParams(resolved, ctx);
  const ordered = orderMethodParams(params);
  const ret = returnType(plan, ctx);

  const lines: string[] = [];
  lines.push(
    ...renderMethodDoc(
      op.description,
      [
        ...ordered.map((param) => ({
          name: param.name,
          description: param.description,
          deprecated: param.deprecated,
        })),
        {
          name: 'requestOptions',
          description: 'Per-request overrides: extra headers, timeout, retries, base URL, idempotency key.',
        },
      ],
      ret ? `The \`${ret}\` returned by the API.` : undefined,
      '    ',
    ),
  );
  if (op.deprecated) lines.push('    @Deprecated("This operation is deprecated.")');

  lines.push(`    public suspend fun ${method}(`);
  for (const p of ordered) {
    lines.push(`        ${p.name}: ${p.type}${p.optional ? ' = null' : ''},`);
  }
  lines.push('        requestOptions: RequestOptions? = null,');
  lines.push(`    )${ret ? `: ${ret}` : ''} {`);

  lines.push(`        val path = ${renderPathExpr(op, params)}`);

  const queryParams = params.filter((p) => p.kind === 'query');
  let queryArg = 'emptyList()';
  if (queryParams.length > 0) {
    lines.push('        val query = mutableListOf<QueryParam>()');
    for (const q of queryParams) lines.push(...renderQueryAppend(q));
    queryArg = 'query';
  }

  const bodyArg = renderBody(lines, params, defaults, infer);

  const httpMethod = op.httpMethod.toUpperCase();
  const call = ret ? `return transport.request<${ret}>(` : 'transport.requestVoid(';
  lines.push(`        ${call}`);
  lines.push(`            method = ${ktStringLiteral(httpMethod)},`);
  lines.push('            path = path,');
  lines.push(`            query = ${queryArg},`);
  lines.push(`            body = ${bodyArg},`);
  lines.push('            options = requestOptions,');
  lines.push('        )');
  lines.push('    }');

  const imports = collectMethodImports(ctx, [...ordered.map((p) => p.type), ...(ret ? [ret] : [])]);
  imports.push(`${subPackage(ctx, '')}.RequestOptions`);
  if (queryParams.length > 0) imports.push(`${subPackage(ctx, 'internal')}.QueryParam`);
  // Any body argument other than the literal `null` is a JsonBody local.
  if (bodyArg !== 'null') imports.push(`${subPackage(ctx, 'internal')}.JsonBody`);
  if (renderPathExpr(op, params).includes('PathEncoding')) {
    imports.push(`${subPackage(ctx, 'internal')}.PathEncoding`);
  }
  return { name: method, lines, imports };
}

/**
 * Render a URL-builder method for a browser-redirect operation (`urlBuilder`
 * hint, e.g. `GET /sso/authorize`). The method never performs an HTTP request:
 * it assembles and returns the URL the caller redirects the user to, so it is
 * NOT `suspend`. Hidden defaults (`response_type=code`) and client-inferred
 * values (`client_id`) are appended alongside the caller's parameters.
 */
function renderUrlBuilderMethod(resolved: ResolvedOperation, method: string, ctx: EmitterContext): RenderedMethod {
  const op = resolved.operation;
  const defaults = getOpDefaults(resolved);
  const infer = getOpInferFromClient(resolved);
  const params = collectMethodParams(resolved, ctx);
  const ordered = orderMethodParams(params);

  const lines: string[] = [];
  lines.push(
    ...renderMethodDoc(
      op.description,
      ordered.map((param) => ({
        name: param.name,
        description: param.description,
        deprecated: param.deprecated,
      })),
      'The assembled URL to redirect the user to.',
      '    ',
    ),
  );
  if (op.deprecated) lines.push('    @Deprecated("This operation is deprecated.")');

  if (ordered.length === 0) {
    lines.push(`    public fun ${method}(): String {`);
  } else {
    lines.push(`    public fun ${method}(`);
    for (const p of ordered) {
      lines.push(`        ${p.name}: ${p.type}${p.optional ? ' = null' : ''},`);
    }
    lines.push('    ): String {');
  }

  lines.push(`        val path = ${renderPathExpr(op, params)}`);
  lines.push('        val query = mutableListOf<QueryParam>()');
  for (const key of Object.keys(defaults)) {
    lines.push(`        query.add(QueryParam(${ktStringLiteral(key)}, ${ktLiteral(defaults[key])}))`);
  }
  for (const key of infer) {
    // `clientId` is nullable on Configuration; only append when set.
    if (key === 'client_id') {
      lines.push(`        ${clientFieldExpr(key)}?.let { query.add(QueryParam(${ktStringLiteral(key)}, it)) }`);
    } else {
      lines.push(`        query.add(QueryParam(${ktStringLiteral(key)}, ${clientFieldExpr(key)}))`);
    }
  }
  for (const q of params.filter((p) => p.kind === 'query')) {
    lines.push(...renderQueryAppend(q));
  }
  lines.push('        return transport.buildUrl(path, query)');
  lines.push('    }');

  const imports = collectMethodImports(
    ctx,
    ordered.map((p) => p.type),
  );
  imports.push(`${subPackage(ctx, 'internal')}.QueryParam`);
  if (renderPathExpr(op, params).includes('PathEncoding')) {
    imports.push(`${subPackage(ctx, 'internal')}.PathEncoding`);
  }
  return { name: method, lines, imports };
}

/** The auto-paging companion method name for a paginated operation. */
export function autoPagingMethodName(method: string): string {
  return `${method}AutoPaging`;
}

/**
 * Details of an operation's auto-paging companion, or null when the operation is
 * not cursor-paginated (or its cursor param is not a plain nullable string query
 * param the wrapper can drive).
 */
export function planAutoPaging(
  resolved: ResolvedOperation,
  ctx: EmitterContext,
): { itemType: string; cursorWire: string; params: RenderedParam[]; cursorParam: RenderedParam } | null {
  const op = resolved.operation;
  const plan = planOperation(op);
  if (!plan.isPaginated || !plan.paginatedItemModelName) return null;
  if (op.pagination?.strategy !== 'cursor') return null;
  const params = collectMethodParams(resolved, ctx);
  // The flow drives the cursor with a String? (null on the first page), so the
  // underlying method's cursor param must be an optional string.
  const cursorParam = params.find((p) => p.kind === 'query' && p.wire === op.pagination?.param);
  if (!cursorParam || cursorParam.type !== 'String?') return null;
  const itemType = typeName(resolvePaginatedItemName(plan.paginatedItemModelName, ctx));
  return { itemType, cursorWire: cursorParam.wire, params, cursorParam };
}

function renderAutoPagingMethod(
  resolved: ResolvedOperation,
  method: string,
  ctx: EmitterContext,
): RenderedMethod | null {
  const auto = planAutoPaging(resolved, ctx);
  if (!auto) return null;
  const name = autoPagingMethodName(method);

  const passthrough = orderMethodParams(auto.params.filter((p) => p !== auto.cursorParam));
  const callArgs = orderMethodParams(auto.params).map((p) =>
    p === auto.cursorParam ? `${p.name} = cursor` : `${p.name} = ${p.name}`,
  );
  callArgs.push('requestOptions = requestOptions');

  const lines: string[] = [];
  lines.push(
    ...renderMethodDoc(
      `Auto-paginating variant of [${method}]: emits every item across successive pages as the flow is collected.`,
      [
        ...passthrough.map((param) => ({
          name: param.name,
          description: param.description,
          deprecated: param.deprecated,
        })),
        {
          name: 'requestOptions',
          description: 'Per-request overrides: extra headers, timeout, retries, base URL, idempotency key.',
        },
      ],
      `A cold flow of \`${auto.itemType}\` values.`,
      '    ',
    ),
  );
  if (resolved.operation.deprecated) lines.push('    @Deprecated("This operation is deprecated.")');
  lines.push(`    public fun ${name}(`);
  for (const p of passthrough) {
    lines.push(`        ${p.name}: ${p.type}${p.optional ? ' = null' : ''},`);
  }
  lines.push('        requestOptions: RequestOptions? = null,');
  lines.push(`    ): Flow<${auto.itemType}> =`);
  lines.push('        autoPagingFlow { cursor ->');
  lines.push(`            ${method}(`);
  for (const arg of callArgs) lines.push(`                ${arg},`);
  lines.push('            )');
  lines.push('        }');

  const imports = collectMethodImports(ctx, [...passthrough.map((p) => p.type), auto.itemType]);
  imports.push('kotlinx.coroutines.flow.Flow');
  imports.push(`${subPackage(ctx, 'internal')}.autoPagingFlow`);
  imports.push(`${subPackage(ctx, '')}.RequestOptions`);
  return { name, lines, imports };
}

/** Determine whether the body is a model (return its fields), raw, or absent. */
function resolveBodyFields(op: Operation, ctx: EmitterContext): Field[] | 'raw' | null {
  const rb = op.requestBody;
  if (!rb) return null;
  if (rb.kind === 'model') {
    const model = ctx.spec.models.find((m) => m.name === rb.name);
    if (model && model.fields.length > 0) return model.fields;
  }
  return 'raw';
}

function returnType(plan: ReturnType<typeof planOperation>, ctx: EmitterContext): string | null {
  if (plan.isPaginated && plan.paginatedItemModelName) {
    const item = resolvePaginatedItemName(plan.paginatedItemModelName, ctx);
    return `Page<${typeName(item)}>`;
  }
  if (plan.isArrayResponse && plan.responseModelName) {
    return `List<${typeName(plan.responseModelName)}>`;
  }
  if (plan.responseModelName) {
    return typeName(plan.responseModelName);
  }
  return null;
}

/**
 * Unwrap a list-wrapper model to its element type. Pagination itemType often
 * resolves to the wrapper (e.g. `OrganizationList { data: [Organization],
 * list_metadata }`); the runtime `Page<T>` already models that envelope, so the
 * element must be the inner item (`Organization`), not the wrapper.
 */
export function resolvePaginatedItemName(name: string, ctx: EmitterContext): string {
  const model = ctx.spec.models.find((m) => m.name === name);
  if (!model) return name;
  const modelMap = new Map(ctx.spec.models.map((m) => [m.name, m]));
  return unwrapListModel(model, modelMap)?.name ?? name;
}

function renderPathExpr(op: Operation, params: RenderedParam[]): string {
  const segments = parsePathTemplate(op.path, { stripLeadingSlash: true });
  if (segments.length === 0) return '""';
  const byWire = new Map(params.filter((p) => p.kind === 'path').map((p) => [p.wire, p]));
  let expr = '"';
  for (const seg of segments) {
    if (seg.kind === 'literal') {
      expr += ktTemplatePart(seg.value);
    } else {
      const p = byWire.get(seg.name);
      const name = p ? p.name : propertyName(seg.name);
      const accessor = p && isEnumRef(p.ref) ? `${name}.rawValue` : name;
      expr += `\${PathEncoding.segment(${accessor})}`;
    }
  }
  expr += '"';
  return expr;
}

function queryValueExpr(name: string, ref: TypeRef): string {
  if (isEnumRef(ref)) return `${name}.rawValue`;
  if (isStringPrimitive(ref)) return name;
  return `${name}.toString()`;
}

function renderQueryAppend(q: RenderedParam): string[] {
  const base = unwrapNullable(q.ref);
  const out: string[] = [];
  if (base.kind === 'array') {
    const elem = base.items;
    const elemExpr = isEnumRef(elem) ? 'value.rawValue' : isStringPrimitive(elem) ? 'value' : 'value.toString()';
    const loop = (indent: string): void => {
      out.push(`${indent}for (value in ${q.optional ? 'it' : q.name}) {`);
      out.push(`${indent}    query.add(QueryParam(${ktStringLiteral(q.wire)}, ${elemExpr}))`);
      out.push(`${indent}}`);
    };
    if (q.optional) {
      out.push(`        ${q.name}?.let {`);
      loop('            ');
      out.push('        }');
    } else {
      loop('        ');
    }
    return out;
  }
  if (q.optional) {
    out.push(
      `        ${q.name}?.let { query.add(QueryParam(${ktStringLiteral(q.wire)}, ${queryValueExpr('it', base)})) }`,
    );
  } else {
    out.push(`        query.add(QueryParam(${ktStringLiteral(q.wire)}, ${queryValueExpr(q.name, base)}))`);
  }
  return out;
}

/** True when a raw request body is a model ref, whose serializer the emitter can name. */
function rawBodyIsModel(ref: TypeRef): boolean {
  return unwrapNullable(ref).kind === 'model';
}

/**
 * Pick a local variable name that cannot shadow a method parameter. A raw body is
 * exposed as a parameter literally named `body`, and a model body field may also be
 * named `body`, either of which would make `val body = JsonBody()` shadow the
 * parameter the very next line reads.
 */
function uniqueLocalName(base: string, params: RenderedParam[]): string {
  const taken = new Set(params.map((p) => p.name.replace(/`/g, '')));
  taken.add('path');
  taken.add('query');
  taken.add('requestOptions');
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}

/** Emit body-building statements and return the argument expression for `body =`. */
function renderBody(
  lines: string[],
  params: RenderedParam[],
  defaults: Record<string, string | number | boolean>,
  infer: string[],
): string {
  const raw = params.find((p) => p.kind === 'bodyRaw');
  if (raw) {
    // The transport takes a `JsonBody`, so a whole-object body goes through the raw
    // setters rather than being passed straight through (which would not typecheck).
    const local = uniqueLocalName('payload', params);
    lines.push(`        val ${local} = JsonBody()`);
    if (rawBodyIsModel(raw.ref)) {
      const modelType = mapTypeRef(unwrapNullable(raw.ref));
      lines.push(`        ${local}.setRaw(${modelType}.serializer(), ${raw.name})`);
    } else {
      lines.push(`        ${local}.setRawJson(${raw.name})`);
    }
    return local;
  }

  const bodyParams = params.filter((p) => p.kind === 'body');
  const defaultKeys = Object.keys(defaults);
  if (bodyParams.length === 0 && defaultKeys.length === 0 && infer.length === 0) {
    return 'null';
  }

  const local = uniqueLocalName('payload', params);
  lines.push(`        val ${local} = JsonBody()`);
  for (const p of bodyParams) {
    lines.push(`        ${local}.set(${ktStringLiteral(p.wire)}, ${p.name})`);
  }
  for (const key of defaultKeys) {
    lines.push(`        ${local}.set(${ktStringLiteral(key)}, ${ktLiteral(defaults[key])})`);
  }
  for (const key of infer) {
    lines.push(`        ${local}.set(${ktStringLiteral(key)}, ${clientFieldExpr(key)})`);
  }
  return local;
}

/** Map an `inferFromClient` wire key to the client configuration property. */
export function clientFieldExpr(key: string): string {
  if (key === 'client_id') return 'transport.configuration.clientId';
  if (key === 'client_secret') return 'transport.configuration.apiKey';
  return `transport.configuration.${propertyName(key)}`;
}
