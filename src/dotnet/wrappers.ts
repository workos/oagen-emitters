import type { EmitterContext, ResolvedOperation, ResolvedWrapper } from '@workos/oagen';
import {
  className as csClassName,
  fieldName as csFieldName,
  methodName as csMethodName,
  localName,
  csLiteral,
  clientFieldExpression,
  httpMethodCs,
  escapeXml,
  emitXmlDoc,
  humanize,
} from './naming.js';
import { sortPathParamsByTemplateOrder } from './resources.js';
import { resolveWrapperParams, formatWrapperDescription, type ResolvedWrapperParam } from '../shared/wrapper-utils.js';
import { mapTypeRef, isValueTypeRef, isEnumRef, emitJsonPropertyAttributes } from './type-map.js';

/**
 * Generate C# wrapper method lines for union split operations.
 */
export function generateWrapperMethods(
  _serviceType: string,
  resolvedOp: ResolvedOperation,
  ctx: EmitterContext,
): string[] {
  if (!resolvedOp.wrappers || resolvedOp.wrappers.length === 0) return [];

  const lines: string[] = [];

  for (const wrapper of resolvedOp.wrappers) {
    const wrapperParams = resolveWrapperParams(wrapper, ctx);
    lines.push('');
    emitWrapperMethod(lines, resolvedOp, wrapper, wrapperParams, ctx);
  }

  return lines;
}

function emitWrapperMethod(
  lines: string[],
  resolvedOp: ResolvedOperation,
  wrapper: ResolvedWrapper,
  _wrapperParams: ResolvedWrapperParam[],
  _ctx: EmitterContext,
): void {
  const op = resolvedOp.operation;
  const method = csMethodName(wrapper.name);
  const optionsClass = `${method}Options`;
  const responseType = wrapper.responseModelName ? csClassName(wrapper.responseModelName) : null;

  // XML doc
  lines.push(`        /// <summary>${formatWrapperDescription(wrapper.name)}.</summary>`);
  for (const p of sortPathParamsByTemplateOrder(op)) {
    const paramDesc = p.description ? escapeXml(p.description) : `The ${humanize(p.name)}.`;
    lines.push(`        /// <param name="${localName(p.name)}">${paramDesc}</param>`);
  }
  lines.push(`        /// <param name="options">Request options.</param>`);
  lines.push(`        /// <param name="requestOptions">Per-request configuration overrides.</param>`);
  lines.push(`        /// <param name="cancellationToken">Cancellation token.</param>`);
  if (responseType) {
    lines.push(`        /// <returns>The <see cref="${responseType}"/> result.</returns>`);
  }

  // Signature
  const sigParams: string[] = [];
  for (const p of sortPathParamsByTemplateOrder(op)) {
    sigParams.push(`string ${localName(p.name)}`);
  }
  sigParams.push(`${optionsClass} options`);
  sigParams.push('RequestOptions? requestOptions = null');
  sigParams.push('CancellationToken cancellationToken = default');

  const returnType = responseType ? `Task<${responseType}>` : 'Task';
  lines.push(`        public async ${returnType} ${method}(${sigParams.join(', ')})`);
  lines.push('        {');

  // Set defaults on options
  for (const [key, value] of Object.entries(wrapper.defaults)) {
    lines.push(`            options.${csFieldName(key)} = ${csLiteral(value)};`);
  }

  // Set inferred fields from client. ClientId is required: fail loudly via RequireClientId()
  // so that callers who forgot to configure it get a clear error instead of a 422 from the API.
  for (const field of wrapper.inferFromClient) {
    if (field === 'client_id') {
      lines.push(`            options.${csFieldName(field)} = this.Client.RequireClientId();`);
    } else {
      lines.push(
        `            options.${csFieldName(field)} = this.Client.${clientFieldExpression(field)} ?? string.Empty;`,
      );
    }
  }

  // Build path
  let pathExpr: string;
  if (op.pathParams.length > 0) {
    let interpolated = op.path;
    for (const p of sortPathParamsByTemplateOrder(op)) {
      interpolated = interpolated.replace(`{${p.name}}`, `{${localName(p.name)}}`);
    }
    pathExpr = `$"${interpolated}"`;
  } else {
    pathExpr = `"${op.path}"`;
  }

  // Build request
  lines.push('            var request = new WorkOSRequest');
  lines.push('            {');
  lines.push(`                Method = HttpMethod.${httpMethodCs(op.httpMethod)},`);
  lines.push(`                Path = ${pathExpr},`);
  lines.push('                Options = options,');
  lines.push('                RequestOptions = requestOptions,');
  lines.push('            };');

  if (responseType) {
    lines.push(`            return await this.Client.MakeAPIRequest<${responseType}>(request, cancellationToken);`);
  } else {
    lines.push('            await this.Client.MakeRawAPIRequest(request, cancellationToken);');
  }

  lines.push('        }');
}

// NOTE: T26 (wrapper DRY) — the AuthenticateWith* wrappers share a small
// SendAuthenticateAsync helper at runtime to avoid 8x copies of the same
// MakeAPIRequest call. The helper itself lives in UserManagementService.cs as
// a hand-maintained method (it can't easily be expressed as a generic because
// the eight options classes don't share an interface). Keeping each generated
// wrapper's body short is the practical part of the DRY win.

/**
 * Generate wrapper options classes. Called from resources.ts options generation.
 */
export function generateWrapperOptionsClasses(resolvedOp: ResolvedOperation, ctx: EmitterContext): string[] {
  if (!resolvedOp.wrappers || resolvedOp.wrappers.length === 0) return [];

  const lines: string[] = [];

  for (const wrapper of resolvedOp.wrappers) {
    const wrapperParams = resolveWrapperParams(wrapper, ctx);
    const optionsClass = `${csMethodName(wrapper.name)}Options`;

    lines.push('');
    lines.push(`    public class ${optionsClass} : BaseOptions`);
    lines.push('    {');

    // Exposed params
    for (const { paramName, field, isOptional } of wrapperParams) {
      const csField = csFieldName(paramName);
      const csType = field ? resolveSimpleCsType(field.type, isOptional) : isOptional ? 'string?' : 'string';
      const needsDefault = !isOptional && !csType.endsWith('?') && !(field && isValueTypeRef(field.type));
      const initializer = needsDefault ? ' = default!;' : '';

      const isRequiredEnum = !isOptional && !!field && isEnumRef(field.type);
      lines.push(...emitXmlDoc(field?.description, '        '));
      lines.push(...emitJsonPropertyAttributes(paramName, { isRequiredEnum }));
      lines.push(`        public ${csType} ${csField} { get; set; }${initializer}`);
      lines.push('');
    }

    // Hidden fields (defaults + inferred)
    for (const key of Object.keys(wrapper.defaults)) {
      const csField = csFieldName(key);
      lines.push(`        [JsonProperty("${key}")]`);
      lines.push(`        [STJS.JsonPropertyName("${key}")]`);
      lines.push(`        internal string ${csField} { get; set; } = default!;`);
      lines.push('');
    }
    for (const key of wrapper.inferFromClient) {
      const csField = csFieldName(key);
      // Skip if already added as a default
      if (Object.keys(wrapper.defaults).includes(key)) continue;
      lines.push(`        [JsonProperty("${key}")]`);
      lines.push(`        [STJS.JsonPropertyName("${key}")]`);
      lines.push(`        internal string ${csField} { get; set; } = default!;`);
      lines.push('');
    }

    lines.push('    }');
  }

  return lines;
}

function resolveSimpleCsType(ref: any, isOptional: boolean): string {
  const base = mapTypeRef(ref);
  if (isOptional && !base.endsWith('?')) return `${base}?`;
  return base;
}
