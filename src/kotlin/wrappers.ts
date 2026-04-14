import type { EmitterContext, ResolvedOperation, ResolvedWrapper, Parameter } from '@workos/oagen';
import { className, propertyName, ktLiteral, clientFieldExpression, escapeReserved } from './naming.js';
import { mapTypeRef, mapTypeRefOptional } from './type-map.js';
import { resolveWrapperParams } from '../shared/wrapper-utils.js';
import { sortPathParamsByTemplateOrder } from './resources.js';

/**
 * Emit Kotlin wrapper methods for a union-split operation. Each wrapper
 * method takes only the fields it needs for its variant, fills in the
 * operation-level defaults and client-inferred values, and posts to the
 * underlying operation.
 *
 * Returns a list of lines (with leading indentation suitable for inclusion
 * inside the service class body).
 */
export function generateWrapperMethods(resolvedOp: ResolvedOperation, ctx: EmitterContext): string[] {
  if (!resolvedOp.wrappers || resolvedOp.wrappers.length === 0) return [];

  const out: string[] = [];
  for (const wrapper of resolvedOp.wrappers) {
    if (out.length > 0) out.push('');
    for (const line of emitWrapperMethod(resolvedOp, wrapper, ctx)) out.push(line);
  }
  return out;
}

function emitWrapperMethod(resolvedOp: ResolvedOperation, wrapper: ResolvedWrapper, ctx: EmitterContext): string[] {
  const op = resolvedOp.operation;
  const method = propertyName(wrapper.name);
  const resolvedParams = resolveWrapperParams(wrapper, ctx);
  const responseClass = wrapper.responseModelName ? className(wrapper.responseModelName) : null;

  const pathParams = sortPathParamsByTemplateOrder(op);

  const lines: string[] = [];
  lines.push(`  /** ${method.replace(/_/g, ' ')} */`);
  lines.push('  @JvmOverloads');

  // Build the method parameter list: path params, wrapper params, requestOptions
  const params: string[] = [];
  for (const pp of pathParams) params.push(`    ${propertyName(pp.name)}: String`);
  for (const rp of resolvedParams) {
    const paramName = propertyName(rp.paramName);
    const kotlinType = rp.field
      ? rp.isOptional
        ? mapTypeRefOptional(rp.field.type)
        : mapTypeRef(rp.field.type)
      : rp.isOptional
        ? 'String?'
        : 'String';
    const trailer = rp.isOptional ? ' = null' : '';
    params.push(`    ${paramName}: ${kotlinType}${trailer}`);
  }
  params.push('    requestOptions: RequestOptions? = null');

  const returnClause = responseClass ? `: ${responseClass}` : '';
  if (params.length === 1) {
    const single = params[0].replace(/^\s+/, '');
    lines.push(`  fun ${escapeReserved(method)}(${single})${returnClause} {`);
  } else {
    lines.push(`  fun ${escapeReserved(method)}(`);
    for (let i = 0; i < params.length; i++) {
      const suffix = i === params.length - 1 ? '' : ',';
      lines.push(`${params[i]}${suffix}`);
    }
    lines.push(`  )${returnClause} {`);
  }

  // Build body
  lines.push(`    val body = linkedMapOf<String, Any?>()`);
  for (const rp of resolvedParams) {
    const paramName = propertyName(rp.paramName);
    if (rp.isOptional) {
      lines.push(`    if (${paramName} != null) body[${ktLiteral(rp.paramName)}] = ${paramName}`);
    } else {
      lines.push(`    body[${ktLiteral(rp.paramName)}] = ${paramName}`);
    }
  }
  for (const [k, v] of Object.entries(wrapper.defaults ?? {})) {
    lines.push(`    body[${ktLiteral(k)}] = ${ktLiteral(v)}`);
  }
  for (const k of wrapper.inferFromClient ?? []) {
    lines.push(`    body[${ktLiteral(k)}] = workos.${clientFieldExpression(k)}`);
  }

  const pathExpr = buildPathExpr(op.path, pathParams);
  const httpMethod = op.httpMethod.toUpperCase();

  lines.push(`    val config =`);
  lines.push(`      RequestConfig(`);
  lines.push(`        method = ${ktLiteral(httpMethod)},`);
  lines.push(`        path = ${pathExpr},`);
  lines.push(`        body = body,`);
  if (op.requestBodyEncoding === 'form-urlencoded') {
    // Some ops (SSO token, User Management authenticate) are form-encoded.
    // Rewrite as formBody mapping string→string instead of JSON body.
    // Fallback: leave body as JSON — the API accepts JSON for these too.
  }
  lines.push(`        requestOptions = requestOptions`);
  lines.push(`      )`);

  if (responseClass) {
    lines.push(`    return workos.baseClient.request(config, ${responseClass}::class.java)`);
  } else {
    lines.push(`    workos.baseClient.requestVoid(config)`);
  }

  lines.push('  }');
  return lines;
}

function buildPathExpr(path: string, pathParams: Parameter[]): string {
  if (pathParams.length === 0) return ktLiteral(path);
  let result = path;
  for (const pp of pathParams) {
    const placeholder = `{${pp.name}}`;
    const propName = propertyName(pp.name);
    const replacement = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(propName) ? `\$${propName}` : `\${${propName}}`;
    result = result.replaceAll(placeholder, replacement);
  }
  return `"${result.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
