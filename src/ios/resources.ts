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

function docComment(description: string | undefined, indent: string): string {
  if (!description) return '';
  return description
    .trim()
    .split('\n')
    .map((line) => (line.trim() ? `${indent}/// ${line.trim()}` : `${indent}///`))
    .join('\n');
}

function renderResource(mountName: string, resolvedOps: ResolvedOperation[], ctx: EmitterContext): string {
  const resourceName = resourceTypeName(mountName, ctx);
  const methods: string[] = [];
  const seen = new Set<string>();

  for (const resolved of resolvedOps) {
    if (resolved.urlBuilder) continue;
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
  }

  const lines: string[] = [];
  lines.push('import Foundation');
  lines.push('');
  lines.push(`/// Operations for the ${resourceName} API.`);
  lines.push(`public struct ${resourceName}: Sendable {`);
  lines.push('    let transport: Transport');
  lines.push('');
  lines.push('    init(transport: Transport) {');
  lines.push('        self.transport = transport');
  lines.push('    }');
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
 */
function resolvePaginatedItemName(name: string, ctx: EmitterContext): string {
  const model = ctx.spec.models.find((m) => m.name === name);
  if (!model) return name;
  const dataField = model.fields.find((f) => f.name === 'data');
  if (!dataField || dataField.type.kind !== 'array') return name;
  const items = dataField.type.items;
  return items.kind === 'model' ? items.name : name;
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
      const accessor = p && isEnumRef(p.ref) ? `${name}.rawValue` : name;
      expr += `\\(PathEncoding.segment(${accessor}))`;
    }
  }
  expr += '"';
  return expr;
}

function queryValueExpr(name: string, ref: TypeRef): string {
  if (isEnumRef(ref)) return `${name}.rawValue`;
  if (isStringPrimitive(ref)) return name;
  return `"\\(${name})"`;
}

function renderQueryAppend(q: RenderedParam): string[] {
  const base = unwrapNullable(q.ref);
  const out: string[] = [];
  if (base.kind === 'array') {
    const elem = base.items;
    const elemExpr = isEnumRef(elem) ? 'value.rawValue' : isStringPrimitive(elem) ? 'value' : '"\\(value)"';
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
