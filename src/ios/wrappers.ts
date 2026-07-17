import type { EmitterContext, Operation, ResolvedOperation, ResolvedWrapper, TypeRef } from '@workos/oagen';
import { resolveWrapperParams, formatWrapperDescription } from '../shared/wrapper-utils.js';
import { parsePathTemplate } from '../shared/path-template.js';
import { methodName, propertyName, typeName, swiftStringLiteral } from './naming.js';
import { mapTypeRef } from './type-map.js';
import { renderDocComment, renderParameterDocs } from './doc-comments.js';

/**
 * Render one `async throws` method per wrapper of a union-split operation (e.g.
 * `authenticate` → `authenticateWithPassword`, `authenticateWithCode`). Each
 * exposes only its variant's fields plus any client-inferred / default values.
 */
export function generateWrapperMethods(resolved: ResolvedOperation, ctx: EmitterContext): string[] {
  const op = resolved.operation;
  return (resolved.wrappers ?? []).map((wrapper) => renderWrapper(op, wrapper, ctx));
}

interface WParam {
  name: string;
  wire: string;
  type: string;
  optional: boolean;
  description?: string;
  deprecated?: boolean;
}

function unwrapNullable(ref: TypeRef): TypeRef {
  return ref.kind === 'nullable' ? ref.inner : ref;
}
function isEnumRef(ref: TypeRef): boolean {
  return unwrapNullable(ref).kind === 'enum';
}

function renderWrapper(op: Operation, wrapper: ResolvedWrapper, ctx: EmitterContext): string {
  const method = methodName(wrapper.name);
  const wparams = resolveWrapperParams(wrapper, ctx);
  const used = new Set<string>();
  const dedupe = (n: string): string => {
    let c = n;
    let i = 2;
    while (used.has(c)) c = `${n}${i++}`;
    used.add(c);
    return c;
  };

  // Path params (rare for split ops) come first and are always required.
  const pathParamOrder = parsePathTemplate(op.path)
    .filter((s) => s.kind === 'param')
    .map((s) => (s as { name: string }).name);
  const pathByWire = new Map(op.pathParams.map((p) => [p.name, p]));
  const pathParams: { name: string; wire: string; ref: TypeRef; description?: string; deprecated?: boolean }[] = [];
  for (const wire of pathParamOrder) {
    const p = pathByWire.get(wire);
    if (!p) continue;
    pathParams.push({
      name: dedupe(propertyName(p.name)),
      wire: p.name,
      ref: p.type,
      description: p.description,
      deprecated: p.deprecated,
    });
  }

  const bodyParams: WParam[] = wparams.map((wp) => {
    const base = wp.field ? mapTypeRef(wp.field.type) : 'String';
    const type = wp.isOptional && !base.endsWith('?') ? `${base}?` : base;
    return {
      name: dedupe(propertyName(wp.paramName)),
      wire: wp.paramName,
      type,
      optional: type.endsWith('?'),
      description: wp.field?.description,
      deprecated: wp.field?.deprecated,
    };
  });

  const ret = wrapper.responseModelName ? typeName(wrapper.responseModelName) : null;

  const sig: string[] = [];
  for (const p of pathParams) sig.push(`        ${p.name}: ${mapTypeRef(p.ref)}`);
  const required = bodyParams.filter((p) => !p.optional);
  const optional = bodyParams.filter((p) => p.optional);
  for (const p of required) sig.push(`        ${p.name}: ${p.type}`);
  for (const p of optional) sig.push(`        ${p.name}: ${p.type} = nil`);
  sig.push('        requestOptions: RequestOptions? = nil');

  const lines: string[] = [];
  const doc = renderDocComment(formatWrapperDescription(wrapper.name), '    ');
  if (doc) lines.push(doc);
  const paramNotes = renderParameterDocs(
    [
      ...pathParams.map((param) => ({
        name: param.name,
        description: param.description,
        deprecated: param.deprecated,
      })),
      ...bodyParams.map((param) => ({
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
  lines.push(`    public func ${method}(`);
  lines.push(sig.join(',\n'));
  lines.push(`    ) async throws${ret ? ` -> ${ret}` : ''} {`);
  lines.push(`        let path = ${renderPathExpr(op, pathParams)}`);
  lines.push('        var body = EncodableBody()');
  for (const p of bodyParams) {
    lines.push(`        body.set(${swiftStringLiteral(p.wire)}, ${p.name})`);
  }
  for (const [key, value] of Object.entries(wrapper.defaults ?? {})) {
    lines.push(`        body.set(${swiftStringLiteral(key)}, ${literalExpr(value)})`);
  }
  for (const key of wrapper.inferFromClient ?? []) {
    lines.push(`        body.set(${swiftStringLiteral(key)}, ${clientFieldExpr(key)})`);
  }

  const httpMethod = op.httpMethod.toUpperCase();
  if (ret) {
    lines.push('        return try await transport.request(');
    lines.push(`            method: "${httpMethod}",`);
    lines.push('            path: path,');
    lines.push('            query: [],');
    lines.push('            body: body,');
    lines.push('            options: requestOptions,');
    lines.push(`            as: ${ret}.self`);
    lines.push('        )');
  } else {
    lines.push('        try await transport.requestVoid(');
    lines.push(`            method: "${httpMethod}",`);
    lines.push('            path: path,');
    lines.push('            query: [],');
    lines.push('            body: body,');
    lines.push('            options: requestOptions');
    lines.push('        )');
  }
  lines.push('    }');
  return lines.join('\n');
}

function renderPathExpr(op: Operation, pathParams: { name: string; wire: string; ref: TypeRef }[]): string {
  const segments = parsePathTemplate(op.path, { stripLeadingSlash: true });
  if (segments.length === 0) return '""';
  const byWire = new Map(pathParams.map((p) => [p.wire, p]));
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

function literalExpr(value: string | number | boolean): string {
  if (typeof value === 'string') return swiftStringLiteral(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function clientFieldExpr(key: string): string {
  if (key === 'client_id') return 'transport.configuration.clientID';
  if (key === 'client_secret') return 'transport.configuration.apiKey';
  return `transport.configuration.${propertyName(key)}`;
}
