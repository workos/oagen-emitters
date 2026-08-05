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
import { isEnumTypeRef, resolvePaginatedItemModelName, unwrapNullableRef } from '../shared/model-utils.js';
import { scopedMountGroups, buildHiddenParams, getOpDefaults, getOpInferFromClient } from '../shared/resolved-ops.js';
import {
  moduleName,
  typeName,
  resourceTypeName,
  propertyName,
  resolveMethodName,
  withResolvedOps,
  swiftStringLiteral,
} from './naming.js';
import { fieldSwiftType, mapTypeRef } from './type-map.js';
import { generateWrapperMethods } from './wrappers.js';
import { renderDocComment, renderParameterDocs } from './doc-comments.js';

/**
 * Generate one Swift resource struct per mount group. Each operation becomes an
 * `async throws` method; path/query/body params are flattened into the signature.
 */
export function generateResources(_services: Service[], ctx: EmitterContext): GeneratedFile[] {
  const rctx = withResolvedOps(ctx);
  const module = moduleName(ctx);
  const groups = [...scopedMountGroups(rctx).values()].sort((a, b) => a.name.localeCompare(b.name));
  return groups.map((group) => ({
    path: `Sources/${module}/Resources/${resourceTypeName(group.name, rctx)}.swift`,
    content: renderResource(group.name, group.resolvedOps, rctx),
  }));
}

// --- TypeRef helpers --------------------------------------------------------

function isStringPrimitive(ref: TypeRef): boolean {
  const base = unwrapNullableRef(ref);
  return base.kind === 'primitive' && base.type === 'string' && base.format !== 'date-time' && base.format !== 'date';
}

// --- rendering --------------------------------------------------------------

function docComment(description: string | undefined, indent: string): string {
  return renderDocComment(description, indent);
}

function renderResource(mountName: string, resolvedOps: ResolvedOperation[], ctx: EmitterContext): string {
  const resourceName = resourceTypeName(mountName, ctx);
  const methods: string[] = [];
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
      methods.push(auto.block);
    }
  }

  const lines: string[] = [];
  lines.push('import Foundation');
  lines.push('');
  lines.push(`/// Operations for the ${resourceName} API.`);
  // No explicit init: the synthesized internal memberwise initializer is
  // identical (swift-format's UseSynthesizedInitializer rule).
  lines.push(`public struct ${resourceName}: Sendable {`);
  lines.push('    let transport: Transport');
  for (const m of methods) {
    lines.push('');
    lines.push(m);
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
 * reconstruct the exact call signature (Swift named args are order-sensitive).
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
    .map((s) => (s as { name: string }).name);
  const pathByWire = new Map(op.pathParams.map((p) => [p.name, p]));
  for (const wire of pathParamOrder) {
    const p = pathByWire.get(wire);
    if (!p || hidden.has(p.name)) continue;
    params.push({
      name: dedupe(propertyName(p.name)),
      wire: p.name,
      type: fieldSwiftType(p.type, true),
      optional: false,
      ref: p.type,
      kind: 'path',
      deprecated: p.deprecated,
      description: p.description,
    });
  }

  // Body params: expand a model body's fields, or a single raw body param.
  const bodyFields = resolveBodyFields(op, ctx);
  if (bodyFields === 'raw') {
    params.push({
      name: dedupe('body'),
      wire: '',
      type: mapTypeRef(op.requestBody!),
      optional: false,
      ref: op.requestBody!,
      kind: 'bodyRaw',
    });
  } else if (bodyFields) {
    for (const f of bodyFields) {
      if (hidden.has(f.name)) continue;
      const type = fieldSwiftType(f.type, f.required);
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
    const type = fieldSwiftType(q.type, q.required);
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

function renderMethod(resolved: ResolvedOperation, mountName: string, method: string, ctx: EmitterContext): string {
  const op = resolved.operation;
  const plan = planOperation(op);
  const defaults = getOpDefaults(resolved);
  const infer = getOpInferFromClient(resolved);

  const params = collectMethodParams(resolved, ctx);

  // Signature params: required first, optionals after, requestOptions last.
  const ordered = orderMethodParams(params);

  // Return type.
  const ret = returnType(plan, ctx);

  // --- assemble body -------------------------------------------------------
  const lines: string[] = [];
  const doc = docComment(op.description, '    ');
  if (doc) lines.push(doc);
  const paramNotes = renderParameterDocs(
    [
      ...ordered.map((param) => ({
        name: param.name,
        description: param.description,
        deprecated: param.deprecated,
      })),
      {
        name: 'requestOptions',
        description: 'Per-request overrides (idempotency key, API key, headers, timeout).',
      },
    ],
    '    ',
  );
  if (paramNotes.length > 0) {
    if (doc) lines.push('    ///');
    lines.push(...paramNotes);
  }
  if (op.deprecated) lines.push('    @available(*, deprecated)');

  const sigParams = ordered.map((p) => `        ${p.name}: ${p.type}${p.optional ? ' = nil' : ''}`);
  sigParams.push('        requestOptions: RequestOptions? = nil');
  lines.push(`    public func ${method}(`);
  lines.push(sigParams.join(',\n'));
  lines.push(`    ) async throws${ret ? ` -> ${ret}` : ''} {`);

  // path
  lines.push(`        let path = ${renderPathExpr(op, params)}`);

  // query
  const queryParams = params.filter((p) => p.kind === 'query');
  let queryArg = '[]';
  if (queryParams.length > 0) {
    lines.push('        var query: [URLQueryItem] = []');
    for (const q of queryParams) lines.push(...renderQueryAppend(q));
    queryArg = 'query';
  }

  // body
  const bodyArg = renderBody(lines, params, defaults, infer);

  // call
  const method_ = op.httpMethod.toUpperCase();
  if (ret) {
    lines.push('        return try await transport.request(');
    lines.push(`            method: "${method_}",`);
    lines.push('            path: path,');
    lines.push(`            query: ${queryArg},`);
    lines.push(`            body: ${bodyArg},`);
    lines.push('            options: requestOptions,');
    lines.push(`            as: ${ret}.self`);
    lines.push('        )');
  } else {
    lines.push('        try await transport.requestVoid(');
    lines.push(`            method: "${method_}",`);
    lines.push('            path: path,');
    lines.push(`            query: ${queryArg},`);
    lines.push(`            body: ${bodyArg},`);
    lines.push('            options: requestOptions');
    lines.push('        )');
  }
  lines.push('    }');
  return lines.join('\n');
}

/**
 * Render a URL-builder method for a browser-redirect operation (`urlBuilder`
 * hint, e.g. `GET /sso/authorize`). The method never performs an HTTP request:
 * it assembles and returns the URL the caller redirects the user to. Hidden
 * defaults (`response_type=code`) and client-inferred values (`client_id`) are
 * appended to the query alongside the caller's parameters, mirroring the Go
 * emitter's URL builders.
 */
function renderUrlBuilderMethod(resolved: ResolvedOperation, method: string, ctx: EmitterContext): string {
  const op = resolved.operation;
  const defaults = getOpDefaults(resolved);
  const infer = getOpInferFromClient(resolved);
  const params = collectMethodParams(resolved, ctx);
  const ordered = orderMethodParams(params);

  const lines: string[] = [];
  const doc = docComment(op.description, '    ');
  if (doc) lines.push(doc);
  const paramNotes = renderParameterDocs(
    ordered.map((param) => ({
      name: param.name,
      description: param.description,
      deprecated: param.deprecated,
    })),
    '    ',
  );
  if (paramNotes.length > 0) {
    if (doc) lines.push('    ///');
    lines.push(...paramNotes);
  }
  if (op.deprecated) lines.push('    @available(*, deprecated)');

  const sigParams = ordered.map((p) => `        ${p.name}: ${p.type}${p.optional ? ' = nil' : ''}`);
  if (sigParams.length === 0) {
    lines.push(`    public func ${method}() -> URL {`);
  } else {
    lines.push(`    public func ${method}(`);
    lines.push(sigParams.join(',\n'));
    lines.push('    ) -> URL {');
  }

  lines.push(`        let path = ${renderPathExpr(op, params)}`);
  lines.push('        var query: [URLQueryItem] = []');
  for (const key of Object.keys(defaults)) {
    lines.push(
      `        query.append(URLQueryItem(name: ${swiftStringLiteral(key)}, value: ${literalExpr(defaults[key])}))`,
    );
  }
  for (const key of infer) {
    // `clientID` is optional on Configuration; only append when set.
    if (key === 'client_id') {
      lines.push(`        if let value = ${clientFieldExpr(key)} {`);
      lines.push(`            query.append(URLQueryItem(name: ${swiftStringLiteral(key)}, value: value))`);
      lines.push('        }');
    } else {
      lines.push(
        `        query.append(URLQueryItem(name: ${swiftStringLiteral(key)}, value: ${clientFieldExpr(key)}))`,
      );
    }
  }
  for (const q of params.filter((p) => p.kind === 'query')) {
    lines.push(...renderQueryAppend(q));
  }
  lines.push('        return transport.buildURL(path: path, query: query)');
  lines.push('    }');
  return lines.join('\n');
}

/** The auto-paging companion method name for a paginated operation. */
export function autoPagingMethodName(method: string): string {
  return `${method}AutoPaging`;
}

/**
 * Details of an operation's auto-paging companion, or null when the operation
 * is not cursor-paginated (or its cursor param is not a plain string query
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
  // The sequence drives the cursor with a String? (nil on the first page), so
  // the underlying method's cursor param must be an optional string.
  const cursorParam = params.find((p) => p.kind === 'query' && p.wire === op.pagination!.param);
  if (!cursorParam || cursorParam.type !== 'String?') return null;
  const itemType = typeName(resolvePaginatedItemName(plan.paginatedItemModelName, ctx));
  return { itemType, cursorWire: cursorParam.wire, params, cursorParam };
}

function renderAutoPagingMethod(
  resolved: ResolvedOperation,
  method: string,
  ctx: EmitterContext,
): { name: string; block: string } | null {
  const auto = planAutoPaging(resolved, ctx);
  if (!auto) return null;
  const name = autoPagingMethodName(method);

  const passthrough = orderMethodParams(auto.params.filter((p) => p !== auto.cursorParam));
  const sigParams = passthrough.map((p) => `        ${p.name}: ${p.type}${p.optional ? ' = nil' : ''}`);
  sigParams.push('        requestOptions: RequestOptions? = nil');

  const callArgs = orderMethodParams(auto.params).map((p) =>
    p === auto.cursorParam ? `${p.name}: cursor` : `${p.name}: ${p.name}`,
  );
  callArgs.push('requestOptions: requestOptions');

  const lines: string[] = [];
  lines.push(`    /// Auto-paginating variant of \`${method}\`: fetches successive`);
  lines.push('    /// pages as the sequence is iterated.');
  const paramNotes = renderParameterDocs(
    [
      ...passthrough.map((param) => ({
        name: param.name,
        description: param.description,
        deprecated: param.deprecated,
      })),
      {
        name: 'requestOptions',
        description: 'Per-request overrides (idempotency key, API key, headers, timeout).',
      },
    ],
    '    ',
  );
  if (paramNotes.length > 0) {
    lines.push('    ///');
    lines.push(...paramNotes);
  }
  if (resolved.operation.deprecated) lines.push('    @available(*, deprecated)');
  lines.push(`    public func ${name}(`);
  lines.push(sigParams.join(',\n'));
  lines.push(`    ) -> AutoPagingSequence<${auto.itemType}> {`);
  lines.push('        AutoPagingSequence { cursor in');
  lines.push(`            try await self.${method}(`);
  lines.push(callArgs.map((a) => `                ${a}`).join(',\n'));
  lines.push('            )');
  lines.push('        }');
  lines.push('    }');
  return { name, block: lines.join('\n') };
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
    return `[${typeName(plan.responseModelName)}]`;
  }
  if (plan.responseModelName) {
    return typeName(plan.responseModelName);
  }
  return null;
}

/**
 * Unwrap a list-wrapper model to its element type. Pagination itemType often
 * resolves to the wrapper (e.g. `OrganizationList { data: [Organization],
 * list_metadata }`); the generated `Page<T>` already models that envelope, so
 * the element must be the inner item (`Organization`), not the wrapper.
 * Delegates to the shared `unwrapListModel` so a model with a `data` array but
 * no `list_metadata` is not mistaken for a pagination envelope.
 */
export function resolvePaginatedItemName(name: string, ctx: EmitterContext): string {
  return resolvePaginatedItemModelName(name, ctx.spec.models);
}

function renderPathExpr(op: Operation, params: RenderedParam[]): string {
  const segments = parsePathTemplate(op.path, { stripLeadingSlash: true });
  if (segments.length === 0) return '""';
  const byWire = new Map(params.filter((p) => p.kind === 'path').map((p) => [p.wire, p]));
  let expr = '"';
  for (const seg of segments) {
    if (seg.kind === 'literal') {
      expr += seg.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    } else {
      const p = byWire.get(seg.name);
      const name = p ? p.name : propertyName(seg.name);
      const accessor = p && isEnumTypeRef(p.ref) ? `${name}.rawValue` : name;
      expr += `\\(PathEncoding.segment(${accessor}))`;
    }
  }
  expr += '"';
  return expr;
}

function queryValueExpr(name: string, ref: TypeRef): string {
  if (isEnumTypeRef(ref)) return `${name}.rawValue`;
  if (isStringPrimitive(ref)) return name;
  return `"\\(${name})"`;
}

function renderQueryAppend(q: RenderedParam): string[] {
  const base = unwrapNullableRef(q.ref);
  const out: string[] = [];
  if (base.kind === 'array') {
    const elem = base.items;
    const elemExpr = isEnumTypeRef(elem) ? 'value.rawValue' : isStringPrimitive(elem) ? 'value' : '"\\(value)"';
    if (q.optional) {
      out.push(`        if let ${q.name} {`);
      out.push(`            for value in ${q.name} {`);
      out.push(`                query.append(URLQueryItem(name: ${swiftStringLiteral(q.wire)}, value: ${elemExpr}))`);
      out.push('            }');
      out.push('        }');
    } else {
      out.push(`        for value in ${q.name} {`);
      out.push(`            query.append(URLQueryItem(name: ${swiftStringLiteral(q.wire)}, value: ${elemExpr}))`);
      out.push('        }');
    }
    return out;
  }
  if (q.optional) {
    out.push(`        if let ${q.name} {`);
    out.push(
      `            query.append(URLQueryItem(name: ${swiftStringLiteral(q.wire)}, value: ${queryValueExpr(q.name, base)}))`,
    );
    out.push('        }');
  } else {
    out.push(
      `        query.append(URLQueryItem(name: ${swiftStringLiteral(q.wire)}, value: ${queryValueExpr(q.name, base)}))`,
    );
  }
  return out;
}

/** Emit body-building statements and return the argument expression for `body:`. */
function renderBody(
  lines: string[],
  params: RenderedParam[],
  defaults: Record<string, string | number | boolean>,
  infer: string[],
): string {
  const raw = params.find((p) => p.kind === 'bodyRaw');
  if (raw) return raw.name;

  const bodyParams = params.filter((p) => p.kind === 'body');
  const defaultKeys = Object.keys(defaults);
  if (bodyParams.length === 0 && defaultKeys.length === 0 && infer.length === 0) {
    return 'nil';
  }

  lines.push('        var body = EncodableBody()');
  for (const p of bodyParams) {
    lines.push(`        body.set(${swiftStringLiteral(p.wire)}, ${p.name})`);
  }
  for (const key of defaultKeys) {
    lines.push(`        body.set(${swiftStringLiteral(key)}, ${literalExpr(defaults[key])})`);
  }
  for (const key of infer) {
    lines.push(`        body.set(${swiftStringLiteral(key)}, ${clientFieldExpr(key)})`);
  }
  return 'body';
}

function literalExpr(value: string | number | boolean): string {
  if (typeof value === 'string') return swiftStringLiteral(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/** Map an `inferFromClient` wire key to the client configuration property. */
function clientFieldExpr(key: string): string {
  if (key === 'client_id') return 'transport.configuration.clientID';
  if (key === 'client_secret') return 'transport.configuration.apiKey';
  return `transport.configuration.${propertyName(key)}`;
}
