import type { EmitterContext, ResolvedOperation, ResolvedWrapper } from '@workos/oagen';
import {
  className,
  propertyName,
  ktLiteral,
  clientFieldExpression,
  escapeReserved,
  humanize,
  maybeShortenEnumParamDescription,
} from './naming.js';
import { mapTypeRef, mapTypeRefOptional } from './type-map.js';
import { resolveWrapperParams } from '../shared/wrapper-utils.js';
import { sortPathParamsByTemplateOrder } from './resources.js';
import { buildKotlinPathExpression } from './path-expression.js';
import { emitSuspendVariant, type SuspendParam } from './suspend.js';

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

  // Build KDoc: operation description + a `@param` line for *every* parameter
  // (Dokka does not flag missing @param blocks, so coverage has to be enforced
  // at emit time) + `@return` when there's a response model. Spec-provided
  // descriptions are preferred; the fallback is templated from the parameter
  // name so the SDK still compiles cleanly under failOnWarning.
  const kdocLines: string[] = [];
  const opDesc = (op.description ?? '').trim();
  const wrapperHumanName = method.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  if (opDesc) {
    kdocLines.push(opDesc.split('\n')[0]);
  } else {
    kdocLines.push(`${wrapperHumanName.charAt(0).toUpperCase()}${wrapperHumanName.slice(1)}.`);
  }
  const paramDocs: string[] = [];
  const pushParamDoc = (
    kotlinName: string,
    sourceName: string,
    description: string | undefined,
    type?: import('@workos/oagen').TypeRef,
  ) => {
    const firstLine =
      description
        ?.split('\n')
        .find((l) => l.trim())
        ?.trim() ?? '';
    const fallback = `the ${humanize(sourceName)} of the request.`;
    let text = firstLine || fallback;
    const shortened = maybeShortenEnumParamDescription(type, text);
    if (shortened) text = shortened.description;
    paramDocs.push(`@param ${kotlinName} ${escapeKdoc(text)}`);
  };
  for (const pp of pathParams) {
    pushParamDoc(propertyName(pp.name), pp.name, pp.description, pp.type);
  }
  for (const rp of resolvedParams) {
    pushParamDoc(propertyName(rp.paramName), rp.paramName, rp.field?.description, rp.field?.type);
  }
  // Trailing `requestOptions` parameter — stable canned phrasing.
  pushParamDoc(
    'requestOptions',
    'request_options',
    'per-request overrides (idempotency key, API key, headers, timeout)',
  );
  if (responseClass) {
    paramDocs.push(`@return the ${responseClass}`);
  }
  lines.push('  /**');
  for (const l of kdocLines) lines.push(`   * ${escapeKdoc(l)}`);
  lines.push('   *');
  for (const p of paramDocs) lines.push(`   * ${p}`);
  lines.push('   */');

  lines.push('  @JvmOverloads');

  // Build the method parameter list: path params, wrapper params, requestOptions.
  // `suspendParams` mirrors `params` but tracks the bare parameter name so the
  // suspend overload (emitted at the end of this function) can forward each
  // argument to the blocking implementation.
  const params: string[] = [];
  const suspendParams: SuspendParam[] = [];
  for (const pp of pathParams) {
    const decl = `    ${propertyName(pp.name)}: String`;
    params.push(decl);
    suspendParams.push({ decl, name: propertyName(pp.name) });
  }
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
    const decl = `    ${paramName}: ${kotlinType}${trailer}`;
    params.push(decl);
    suspendParams.push({ decl, name: paramName });
  }
  params.push('    requestOptions: RequestOptions? = null');
  suspendParams.push({ decl: '    requestOptions: RequestOptions? = null', name: 'requestOptions' });

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

  // The /user_management/authenticate endpoint is union-split into one
  // wrapper per grant_type. Every variant posts the same shape (caller
  // params + grant_type + client_id + client_secret) to the same path with
  // the same response model, so we route through a single `authenticate(...)`
  // private helper instead of duplicating the request boilerplate per grant.
  const inferred = wrapper.inferFromClient ?? [];
  const usesStandardClientCreds = inferred.includes('client_id') && inferred.includes('client_secret');
  if (
    op.path === '/user_management/authenticate' &&
    op.httpMethod.toUpperCase() === 'POST' &&
    responseClass === 'AuthenticateResponse' &&
    typeof wrapper.defaults?.grant_type === 'string' &&
    usesStandardClientCreds
  ) {
    const grantType = wrapper.defaults.grant_type;
    lines.push(`    return authenticate(`);
    lines.push(`      grantType = ${ktLiteral(grantType)},`);
    lines.push(`      requestOptions = requestOptions,`);
    const entryLines = resolvedParams.map((rp) => {
      const paramName = propertyName(rp.paramName);
      return `      ${ktLiteral(rp.paramName)} to ${paramName}`;
    });
    for (let i = 0; i < entryLines.length; i++) {
      const sep = i === entryLines.length - 1 ? '' : ',';
      lines.push(`${entryLines[i]}${sep}`);
    }
    lines.push(`    )`);
    lines.push('  }');
    appendSuspendVariant(lines, method, suspendParams, responseClass ?? 'Unit');
    return lines;
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

  const pathExpr = buildKotlinPathExpression(op.path).expression;
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
  appendSuspendVariant(lines, method, suspendParams, responseClass ?? 'Unit');
  return lines;
}

function appendSuspendVariant(
  lines: string[],
  method: string,
  suspendParams: SuspendParam[],
  returnType: string,
): void {
  lines.push('');
  for (const ln of emitSuspendVariant({ methodName: method, params: suspendParams, returnType })) {
    lines.push(ln);
  }
}

function escapeKdoc(s: string): string {
  return s.replace(/\*\//g, '*\u200b/');
}
