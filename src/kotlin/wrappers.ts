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

  // Build KDoc from operation description + @param docs for each wrapper param.
  const kdocLines: string[] = [];
  const opDesc = (op.description ?? '').trim();
  const wrapperHumanName = method.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  if (opDesc) {
    kdocLines.push(opDesc.split('\n')[0]);
  } else {
    kdocLines.push(`${wrapperHumanName.charAt(0).toUpperCase()}${wrapperHumanName.slice(1)}.`);
  }
  const paramDocs: string[] = [];
  for (const pp of pathParams) {
    if (pp.description?.trim()) {
      paramDocs.push(`@param ${propertyName(pp.name)} ${escapeKdoc(pp.description.split('\n')[0].trim())}`);
    }
  }
  for (const rp of resolvedParams) {
    const desc = rp.field?.description?.trim();
    if (desc) {
      paramDocs.push(`@param ${propertyName(rp.paramName)} ${escapeKdoc(desc.split('\n')[0])}`);
    }
  }
  if (responseClass) {
    paramDocs.push(`@return the ${responseClass}`);
  }
  if (paramDocs.length > 0 || kdocLines.length > 0) {
    lines.push('  /**');
    for (const l of kdocLines) lines.push(`   * ${escapeKdoc(l)}`);
    if (paramDocs.length > 0) {
      lines.push('   *');
      for (const p of paramDocs) lines.push(`   * ${p}`);
    }
    lines.push('   */');
  }

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

  // Build body using bodyOf() — consistent with non-wrapper methods.
  // bodyOf() automatically drops null optional values.
  const bodyEntries: string[] = [];
  for (const rp of resolvedParams) {
    const paramName = propertyName(rp.paramName);
    bodyEntries.push(`      ${ktLiteral(rp.paramName)} to ${paramName}`);
  }
  for (const [k, v] of Object.entries(wrapper.defaults ?? {})) {
    bodyEntries.push(`      ${ktLiteral(k)} to ${ktLiteral(v)}`);
  }
  for (const k of wrapper.inferFromClient ?? []) {
    bodyEntries.push(`      ${ktLiteral(k)} to workos.${clientFieldExpression(k)}`);
  }
  if (bodyEntries.length > 0) {
    lines.push(`    val body =`);
    lines.push(`      bodyOf(`);
    for (let i = 0; i < bodyEntries.length; i++) {
      const sep = i === bodyEntries.length - 1 ? '' : ',';
      lines.push(`  ${bodyEntries[i]}${sep}`);
    }
    lines.push(`      )`);
  } else {
    lines.push(`    val body = linkedMapOf<String, Any?>()`);
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

function escapeKdoc(s: string): string {
  return s.replace(/\*\//g, '*\u200b/');
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
