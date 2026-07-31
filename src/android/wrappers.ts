import type { EmitterContext, Operation, ResolvedOperation, ResolvedWrapper, TypeRef } from '@workos/oagen';
import { resolveWrapperParams, formatWrapperDescription } from '../shared/wrapper-utils.js';
import { parsePathTemplate } from '../shared/path-template.js';
import {
  methodName,
  propertyName,
  typeName,
  subPackage,
  ktStringLiteral,
  ktLiteral,
  ktTemplatePart,
} from './naming.js';
import { mapTypeRef, implicitImportsFor } from './type-map.js';
import { resolveTypeImports } from './imports.js';
import { renderMethodDoc } from './doc-comments.js';
import type { RenderedMethod } from './resources.js';
import { clientFieldExpr } from './resources.js';

/**
 * Render one `suspend fun` per wrapper of a union-split operation (e.g.
 * `authenticate` → `authenticateWithPassword`, `authenticateWithCode`). Each
 * exposes only its variant's fields plus any client-inferred / default values.
 */
export function generateWrapperMethods(resolved: ResolvedOperation, ctx: EmitterContext): RenderedMethod[] {
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

interface WPathParam {
  name: string;
  wire: string;
  ref: TypeRef;
  description?: string;
  deprecated?: boolean;
}

/**
 * Doc text for a union-split wrapper.
 *
 * The variant name alone ("Create oauth application") only restates the method
 * name — it drops everything the spec says about what the endpoint does. So the
 * parent operation's description is carried through underneath it.
 *
 * Spec descriptions are conventionally "Short Title\n\nFull explanation.", and the
 * short title duplicates the variant line, so when a body is present only the body
 * is appended. With no body the whole description is used.
 */
function wrapperDoc(wrapperName: string, operationDescription: string | undefined): string {
  const title = formatWrapperDescription(wrapperName);
  const desc = operationDescription?.trim();
  if (!desc) return title;
  const blank = desc.indexOf('\n\n');
  const body = blank === -1 ? desc : desc.slice(blank + 2).trim();
  return body ? `${title}\n\n${body}` : title;
}

function unwrapNullable(ref: TypeRef): TypeRef {
  return ref.kind === 'nullable' ? ref.inner : ref;
}
function isEnumRef(ref: TypeRef): boolean {
  return unwrapNullable(ref).kind === 'enum';
}

function renderWrapper(op: Operation, wrapper: ResolvedWrapper, ctx: EmitterContext): RenderedMethod {
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
    .map((s) => (s.kind === 'param' ? s.name : ''));
  const pathByWire = new Map(op.pathParams.map((p) => [p.name, p]));
  const pathParams: WPathParam[] = [];
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

  const required = bodyParams.filter((p) => !p.optional);
  const optional = bodyParams.filter((p) => p.optional);

  const lines: string[] = [];
  lines.push(
    ...renderMethodDoc(
      wrapperDoc(wrapper.name, op.description),
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
          description: 'Per-request overrides: extra headers, timeout, retries, base URL, idempotency key.',
        },
      ],
      ret ? `The \`${ret}\` returned by the API.` : undefined,
      '    ',
    ),
  );

  lines.push(`    public suspend fun ${method}(`);
  for (const p of pathParams) lines.push(`        ${p.name}: ${mapTypeRef(p.ref)},`);
  for (const p of required) lines.push(`        ${p.name}: ${p.type},`);
  for (const p of optional) lines.push(`        ${p.name}: ${p.type} = null,`);
  lines.push('        requestOptions: RequestOptions? = null,');
  lines.push(`    )${ret ? `: ${ret}` : ''} {`);

  const pathExpr = renderPathExpr(op, pathParams);
  lines.push(`        val path = ${pathExpr}`);
  // Avoid shadowing a wrapper parameter that happens to be named `payload`/`body`.
  const taken = new Set<string>([
    ...pathParams.map((p) => p.name.replace(/`/g, '')),
    ...bodyParams.map((p) => p.name.replace(/`/g, '')),
    'path',
    'requestOptions',
  ]);
  let local = 'payload';
  for (let n = 2; taken.has(local); n++) local = `payload${n}`;

  lines.push(`        val ${local} = JsonBody()`);
  for (const p of bodyParams) {
    lines.push(`        ${local}.set(${ktStringLiteral(p.wire)}, ${p.name})`);
  }
  for (const [key, value] of Object.entries(wrapper.defaults ?? {})) {
    lines.push(`        ${local}.set(${ktStringLiteral(key)}, ${ktLiteral(value)})`);
  }
  for (const key of wrapper.inferFromClient ?? []) {
    lines.push(`        ${local}.set(${ktStringLiteral(key)}, ${clientFieldExpr(key)})`);
  }

  const httpMethod = op.httpMethod.toUpperCase();
  const call = ret ? `return transport.request<${ret}>(` : 'transport.requestVoid(';
  lines.push(`        ${call}`);
  lines.push(`            method = ${ktStringLiteral(httpMethod)},`);
  lines.push('            path = path,');
  lines.push('            query = emptyList(),');
  lines.push(`            body = ${local},`);
  lines.push('            options = requestOptions,');
  lines.push('        )');
  lines.push('    }');

  const typeExprs = [
    ...pathParams.map((p) => mapTypeRef(p.ref)),
    ...bodyParams.map((p) => p.type),
    ...(ret ? [ret] : []),
  ];
  const imports = new Set<string>([`${subPackage(ctx, '')}.RequestOptions`, `${subPackage(ctx, 'internal')}.JsonBody`]);
  for (const expr of typeExprs) {
    for (const imp of implicitImportsFor(expr)) imports.add(imp);
  }
  for (const imp of resolveTypeImports(ctx, typeExprs)) imports.add(imp);
  if (pathExpr.includes('PathEncoding')) imports.add(`${subPackage(ctx, 'internal')}.PathEncoding`);

  return { name: method, lines, imports: [...imports] };
}

function renderPathExpr(op: Operation, pathParams: WPathParam[]): string {
  const segments = parsePathTemplate(op.path, { stripLeadingSlash: true });
  if (segments.length === 0) return '""';
  const byWire = new Map(pathParams.map((p) => [p.wire, p]));
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
