import type { EmitterContext, Operation, ResolvedOperation, ResolvedWrapper } from '@workos/oagen';
import { className, fieldName, safeParamName } from './naming.js';
import { resolveWrapperParams, formatWrapperDescription } from '../shared/wrapper-utils.js';
import { mapTypeRefForYard } from './type-map.js';

/**
 * Generate Ruby wrapper method lines for union split operations.
 *
 * Each wrapper is a typed convenience method that:
 * - Accepts only the exposed params (keyword args)
 * - Injects constant defaults (e.g., grant_type)
 * - Reads inferred fields from client config (e.g., client_id)
 * - Delegates to the same HTTP runtime as the main method
 */
export function generateWrapperMethods(
  resolvedOp: ResolvedOperation,
  ctx: EmitterContext,
  modelNames: Set<string>,
  requires: Set<string>,
): string[] {
  if (!resolvedOp.wrappers || resolvedOp.wrappers.length === 0) return [];
  const out: string[] = [];
  for (const wrapper of resolvedOp.wrappers) {
    const body = emitWrapperMethod(resolvedOp.operation, wrapper, ctx, modelNames, requires);
    out.push(body);
  }
  return out;
}

/** Collect response model filenames needed for wrapper imports. */
export function collectWrapperResponseModels(resolvedOp: ResolvedOperation): Set<string> {
  const models = new Set<string>();
  for (const w of resolvedOp.wrappers ?? []) {
    if (w.responseModelName) models.add(w.responseModelName);
  }
  return models;
}

function emitWrapperMethod(
  op: Operation,
  wrapper: ResolvedWrapper,
  ctx: EmitterContext,
  modelNames: Set<string>,
  requires: Set<string>,
): string {
  void requires;
  const method = wrapper.name; // already snake_case
  const wrapperParams = resolveWrapperParams(wrapper, ctx);
  const lines: string[] = [];

  // YARD doc
  lines.push(`    # ${formatWrapperDescription(wrapper.name)}.`);
  for (const p of op.pathParams ?? []) {
    const pyType = mapTypeRefForYard(p.type);
    lines.push(`    # @param ${safeParamName(p.name)} [${pyType}]`);
  }
  for (const wp of wrapperParams) {
    const type = wp.field ? mapTypeRefForYard(wp.field.type) : 'String';
    const alreadyNilable = type.split(', ').includes('nil');
    const suffix = wp.isOptional && !alreadyNilable ? ', nil' : '';
    lines.push(`    # @param ${fieldName(wp.paramName)} [${type}${suffix}]`);
  }
  lines.push(`    # @param request_options [Hash] Per-request overrides.`);
  if (wrapper.responseModelName) {
    lines.push(`    # @return [WorkOS::${className(wrapper.responseModelName)}]`);
  } else {
    lines.push(`    # @return [nil]`);
  }

  // Signature
  const sigParts: string[] = [];
  const seen = new Set<string>();
  for (const p of op.pathParams ?? []) {
    const n = safeParamName(p.name);
    if (seen.has(n)) continue;
    seen.add(n);
    sigParts.push(`${n}:`);
  }
  // Required first, then optional
  for (const wp of wrapperParams) {
    if (wp.isOptional) continue;
    const n = fieldName(wp.paramName);
    if (seen.has(n)) continue;
    seen.add(n);
    sigParts.push(`${n}:`);
  }
  for (const wp of wrapperParams) {
    if (!wp.isOptional) continue;
    const n = fieldName(wp.paramName);
    if (seen.has(n)) continue;
    seen.add(n);
    sigParts.push(`${n}: nil`);
  }
  sigParts.push('request_options: {}');

  if (sigParts.length === 1 && sigParts[0].length < 60) {
    lines.push(`    def ${method}(${sigParts[0]})`);
  } else {
    lines.push(`    def ${method}(`);
    for (let i = 0; i < sigParts.length; i++) {
      const sep = i === sigParts.length - 1 ? '' : ',';
      lines.push(`      ${sigParts[i]}${sep}`);
    }
    lines.push('    )');
  }

  // Body hash
  const bodyEntries: string[] = [];
  for (const [k, v] of Object.entries(wrapper.defaults)) {
    const lit = typeof v === 'string' ? rubyStringLit(v) : String(v);
    bodyEntries.push(`${rubyStringLit(k)} => ${lit}`);
  }
  for (const fc of wrapper.inferFromClient) {
    const clientProp = fc === 'client_secret' ? 'api_key' : fc;
    bodyEntries.push(`${rubyStringLit(fc)} => @client.${clientProp}`);
  }
  for (const wp of wrapperParams) {
    bodyEntries.push(`${rubyStringLit(wp.paramName)} => ${fieldName(wp.paramName)}`);
  }
  lines.push('      body = {');
  for (let i = 0; i < bodyEntries.length; i++) {
    const sep = i === bodyEntries.length - 1 ? '' : ',';
    lines.push(`        ${bodyEntries[i]}${sep}`);
  }
  lines.push('      }.compact');

  // Path string
  const rubyPath = interpolateRubyPath(op.path, op.pathParams ?? []);
  const verb = httpVerbRubyMethod(op.httpMethod.toLowerCase());
  lines.push('      response = @client.execute_request(');
  lines.push(
    `        request: @client.${verb}(path: ${rubyPath}, auth: true, body: body, request_options: request_options),`,
  );
  lines.push('        request_options: request_options');
  lines.push('      )');

  // Response handling
  if (wrapper.responseModelName && modelNames.has(wrapper.responseModelName)) {
    lines.push(`      WorkOS::${className(wrapper.responseModelName)}.new(response.body)`);
  } else {
    lines.push('      JSON.parse(response.body)');
  }

  lines.push('    end');

  return lines.join('\n');
}

function interpolateRubyPath(path: string, pathParams: Operation['pathParams']): string {
  if (!pathParams || pathParams.length === 0) return `'${path}'`;
  let result = path;
  for (const p of pathParams) {
    result = result.split(`{${p.name}}`).join(`#{${safeParamName(p.name)}}`);
  }
  return `"${result}"`;
}

function httpVerbRubyMethod(method: string): string {
  switch (method) {
    case 'get':
      return 'get_request';
    case 'post':
      return 'post_request';
    case 'put':
      return 'put_request';
    case 'patch':
      return 'patch_request';
    case 'delete':
      return 'delete_request';
    default:
      return 'get_request';
  }
}

function rubyStringLit(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
