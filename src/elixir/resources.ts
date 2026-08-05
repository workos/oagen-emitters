import type {
  EmitterContext,
  GeneratedFile,
  Operation,
  Parameter,
  Service,
  ResolvedOperation,
  ResolvedWrapper,
  TypeRef,
} from '@workos/oagen';
import { planOperation } from '@workos/oagen';
import { mapTypeRef } from './type-map.js';
import {
  moduleName,
  fileName,
  fieldName,
  fullModuleName,
  functionName,
  varName,
  escapeDoc,
  escapeString,
  nsPascal,
} from './naming.js';
import { castExpr, casterFun, type CastNames } from './casting.js';
import {
  scopedMountGroups,
  getOpDefaults,
  getOpInferFromClient,
  buildHiddenParams,
  hasHiddenParams,
  type MountGroup,
} from '../shared/resolved-ops.js';
import { buildExportedClassNameSet, resolveServiceTarget } from '../shared/service-name-collision.js';
import { parsePathTemplate } from '../shared/path-template.js';
import { getSyntheticEnums, resolvePaginationItemType } from '../shared/model-utils.js';
import { resolveWrapperParams, formatWrapperDescription } from '../shared/wrapper-utils.js';

/**
 * Generate one resource module per mount group. Functions take the client as
 * their first argument, then required path params, then a `params` map (query
 * params for GET/DELETE/HEAD, request body otherwise), then an `opts` keyword
 * list — returning `{:ok, result} | {:error, error}` tuples.
 */
export function generateResources(services: Service[], ctx: EmitterContext): GeneratedFile[] {
  void services; // emission is driven by resolved operations, not raw IR services
  const groups = scopedMountGroups(ctx);
  const exported = buildExportedClassNameSet(ctx, moduleName);
  const names: CastNames = {
    modelNames: new Set(ctx.spec.models.map((m) => m.name)),
    enumNames: new Set([...ctx.spec.enums.map((e) => e.name), ...getSyntheticEnums().map((e) => e.name)]),
  };

  const files: GeneratedFile[] = [];
  for (const group of [...groups.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const target = resolveServiceTarget(group.name, exported, moduleName);
    const content = renderService(group, target, ctx, names);
    if (content === null) continue;
    files.push({
      path: `lib/${ctx.namespace}/${fileName(target)}.ex`,
      content,
      integrateTarget: true,
      overwriteExisting: true,
    });
  }
  return files;
}

function renderService(group: MountGroup, target: string, ctx: EmitterContext, names: CastNames): string | null {
  const methods: string[] = [];
  const seen = new Set<string>();
  for (const resolved of group.resolvedOps) {
    // When wrappers exist (union-body operations like Authenticate), emit only
    // the wrappers — the raw base method is not part of the SDK surface.
    if ((resolved.wrappers?.length ?? 0) > 0) {
      for (const wrapper of resolved.wrappers!) {
        const wname = functionName(wrapper.name);
        if (seen.has(wname)) continue;
        seen.add(wname);
        methods.push(renderWrapper(resolved, wrapper, wname, ctx, names));
      }
      continue;
    }
    const fname = functionName(resolved.methodName);
    if (seen.has(fname)) continue;
    seen.add(fname);
    if ((resolved as { urlBuilder?: boolean }).urlBuilder) {
      methods.push(renderUrlBuilder(resolved, fname, ctx));
    } else {
      methods.push(renderMethod(resolved, fname, ctx, names));
    }
  }
  if (methods.length === 0) return null;

  const description =
    group.resolvedOps.map((r) => r.service.description).find((d) => d && d.trim().length > 0) ??
    `Operations for the ${group.name} API.`;

  const lines: string[] = [];
  lines.push(`defmodule ${fullModuleName(ctx, target)} do`);
  lines.push('  @moduledoc """');
  lines.push(`  ${escapeDoc(description).split('\n').join('\n  ')}`);
  lines.push('  """');
  lines.push('');
  lines.push(methods.join('\n\n'));
  lines.push('end');
  return lines.join('\n');
}

interface PathParamInfo {
  wireName: string;
  variable: string;
  description?: string;
  deprecated?: boolean;
}

/** `:atom` doc entry for a query param, tagging spec-deprecated ones. */
function queryParamDoc(p: Parameter): string {
  return `\`:${varName(p.name)}\`${p.deprecated ? ' (deprecated)' : ''}`;
}

/** Doc bullet for a path param, tagging spec-deprecated ones. */
function pathParamDocLine(p: PathParamInfo): string {
  return `    * \`${p.variable}\` — ${escapeDoc(p.description ?? 'path parameter')}${p.deprecated ? ' (deprecated)' : ''}`;
}

function pathParamInfos(op: Operation): PathParamInfo[] {
  const segments = parsePathTemplate(op.path);
  const infos: PathParamInfo[] = [];
  for (const segment of segments) {
    if (segment.kind !== 'param') continue;
    const irParam = op.pathParams.find((p) => p.name === segment.name);
    infos.push({
      wireName: segment.name,
      variable: varName(segment.name),
      description: irParam?.description,
      deprecated: irParam?.deprecated,
    });
  }
  return infos;
}

/** Render the Elixir string expression for an operation path, URL-encoding every param segment. */
function pathExpression(op: Operation, params: PathParamInfo[]): string {
  const segments = parsePathTemplate(op.path);
  let out = '"';
  for (const segment of segments) {
    if (segment.kind === 'literal') {
      out += escapeString(segment.value);
    } else {
      const variable = params.find((p) => p.wireName === segment.name)?.variable ?? varName(segment.name);
      out += `#{URI.encode(${variable}, &URI.char_unreserved?/1)}`;
    }
  }
  return `${out}"`;
}

/** Elixir literal for a constant default value. */
function elixirLiteral(value: string | number | boolean): string {
  return typeof value === 'string' ? `"${escapeString(value)}"` : String(value);
}

/** Expression reading an inferFromClient field off the client struct. */
function clientFieldExpr(field: string): string {
  switch (field) {
    case 'client_id':
      return 'client.client_id';
    case 'client_secret':
      return 'client.api_key';
    default:
      return `client.${functionName(field)}`;
  }
}

/**
 * Lines rebinding `params` with constant defaults and client-inferred fields.
 * Defaults always win (the whole point of a wrapper is pinning them); inferred
 * fields fill in only when the caller did not pass them. Empty when the
 * operation has no hidden params.
 */
function injectionLines(ns: string, defaults: Record<string, string | number | boolean>, inferred: string[]): string[] {
  const defaultKeys = Object.keys(defaults);
  if (defaultKeys.length === 0 && inferred.length === 0) return [];
  const lines: string[] = [];
  lines.push('    params =');
  lines.push('      params');
  const entries = defaultKeys.map((k) => `"${escapeString(k)}" => ${elixirLiteral(defaults[k])}`).join(', ');
  lines.push(`      |> ${ns}.Client.merge_defaults(%{${entries}})`);
  for (const field of inferred) {
    lines.push(`      |> ${ns}.Client.put_inferred("${escapeString(field)}", ${clientFieldExpr(field)})`);
  }
  lines.push('');
  return lines;
}

/**
 * ` Deprecated: `:a`, `:b` (see `Ns.Model`).` sentence for a request-body doc
 * bullet, mirroring the `(deprecated)` tag on query/path params. Lists only
 * body-model fields that survive the snake_case dedup applied to the struct
 * (an alias collapsed into a non-deprecated canonical field is not deprecated
 * on the SDK surface); the model's moduledoc carries the full notes. Empty
 * when the body has no deprecated fields.
 */
function deprecatedBodyFieldsDoc(op: Operation, ctx: EmitterContext): string {
  const reqBody = op.requestBody;
  if (reqBody?.kind !== 'model') return '';
  const model = ctx.spec.models.find((m) => m.name === reqBody.name);
  if (!model) return '';
  const seen = new Set<string>();
  const deprecated: string[] = [];
  for (const f of model.fields) {
    const name = fieldName(f.name);
    if (seen.has(name)) continue;
    seen.add(name);
    if (f.deprecated) deprecated.push(name);
  }
  if (deprecated.length === 0) return '';
  const names = deprecated.map((n) => `\`:${n}\``).join(', ');
  return ` Deprecated: ${names} (see \`${fullModuleName(ctx, model.name)}\`).`;
}

/** Doc sentences describing hidden params the SDK fills in automatically. */
function injectionDocLines(defaults: Record<string, string | number | boolean>, inferred: string[]): string[] {
  const lines: string[] = [];
  const defaultKeys = Object.keys(defaults);
  if (defaultKeys.length > 0) {
    const rendered = defaultKeys.map((k) => `\`${k}\` (\`${elixirLiteral(defaults[k])}\`)`).join(', ');
    lines.push(`  Sets ${rendered} automatically.`);
  }
  if (inferred.length > 0) {
    const rendered = inferred.map((f) => `\`${f}\``).join('/');
    lines.push(`  Reads ${rendered} from the client configuration unless passed explicitly.`);
  }
  return lines;
}

/**
 * Whether a non-wrapper method takes a `params` map argument. Exported so the
 * test emitter builds calls with the same arity this renderer emits — getting
 * these out of step produces generated tests that fail to compile.
 */
export function methodTakesParams(resolved: ResolvedOperation): boolean {
  const plan = planOperation(resolved.operation);
  return plan.hasBody || plan.hasQueryParams || plan.isPaginated || hasHiddenParams(resolved);
}

function renderMethod(resolved: ResolvedOperation, fname: string, ctx: EmitterContext, names: CastNames): string {
  const ns = nsPascal(ctx);
  const op = resolved.operation;
  const plan = planOperation(op);
  const pathParams = pathParamInfos(op);
  const defaults = getOpDefaults(resolved);
  const inferred = getOpInferFromClient(resolved);
  const injection = injectionLines(ns, defaults, inferred);
  const hasParams = methodTakesParams(resolved);
  const isQueryMethod = ['get', 'delete', 'head'].includes(op.httpMethod);

  // `Page.from_map/4` casts each element of the `data` array, so paginated ops
  // need the element type — not the list envelope the response names.
  const pageItemType =
    plan.isPaginated && op.pagination
      ? resolvePaginationItemType(op.pagination.itemType, new Map(ctx.spec.models.map((m) => [m.name, m])))
      : null;

  const args = ['client', ...pathParams.map((p) => p.variable)];
  if (hasParams) args.push('params \\\\ %{}');
  args.push('opts \\\\ []');

  const specArgs = [
    `${ns}.Client.t()`,
    ...pathParams.map(() => 'String.t()'),
    ...(hasParams ? ['map()'] : []),
    'keyword()',
  ];

  const optsExpr = op.injectIdempotencyKey ? 'Keyword.put_new(opts, :idempotency, true)' : 'opts';
  const requestCall = `${ns}.Client.request(client, :${op.httpMethod}, ${pathExpression(op, pathParams)}, ${
    hasParams ? 'params' : '%{}'
  }, ${optsExpr})`;

  const lines: string[] = [];

  // Documentation
  lines.push('  @doc """');
  const summary = op.description?.trim() || humanize(resolved.methodName);
  lines.push(`  ${escapeDoc(summary).split('\n').join('\n  ')}`);
  for (const docLine of injectionDocLines(defaults, inferred)) {
    lines.push('');
    lines.push(docLine);
  }
  lines.push('');
  lines.push('  ## Parameters');
  lines.push('');
  for (const p of pathParams) {
    lines.push(pathParamDocLine(p));
  }
  if (hasParams) {
    const hidden = buildHiddenParams(resolved);
    const visibleQueryParams = op.queryParams.filter((p) => !hidden.has(p.name));
    if (isQueryMethod && visibleQueryParams.length > 0) {
      const namesList = visibleQueryParams.map(queryParamDoc).join(', ');
      lines.push(`    * \`params\` — query parameters: ${namesList}`);
    } else if (isQueryMethod) {
      lines.push('    * `params` — query parameters');
    } else {
      const bodyDeprecated = deprecatedBodyFieldsDoc(op, ctx);
      lines.push(`    * \`params\` — request body map${bodyDeprecated ? `.${bodyDeprecated}` : ''}`);
    }
  }
  lines.push(`    * \`opts\` — per-request options (see \`${ns}.Client.request/5\`)`);
  lines.push('  """');

  if (op.deprecated) {
    lines.push('  @deprecated "This operation is deprecated."');
  }

  // Spec
  const returnSpec = pageItemType
    ? `${ns}.Page.t(${mapTypeRef(pageItemType, { nsPascal: ns })})`
    : mapTypeRef(op.response, { nsPascal: ns });
  lines.push(`  @spec ${fname}(${specArgs.join(', ')}) ::`);
  lines.push(`          {:ok, ${returnSpec}} | {:error, ${ns}.Error.error()}`);

  // Body
  lines.push(`  def ${fname}(${args.join(', ')}) do`);
  lines.push(...injection);

  if (plan.isPaginated && op.pagination) {
    const dataKey = op.pagination.dataPath ?? 'data';
    const itemCaster = casterFun(pageItemType ?? op.pagination.itemType, ctx, names) ?? '&Function.identity/1';
    const cursorParam = op.pagination.param;
    const recallArgs = ['client', ...pathParams.map((p) => p.variable)];
    lines.push(`    with {:ok, body} <- ${requestCall} do`);
    lines.push('      fetch_next = fn cursor ->');
    lines.push(`        ${fname}(`);
    for (const arg of recallArgs) {
      lines.push(`          ${arg},`);
    }
    lines.push(`          ${ns}.Page.next_params(params, "${escapeString(cursorParam)}", cursor),`);
    lines.push('          opts');
    lines.push('        )');
    lines.push('      end');
    lines.push('');
    lines.push(`      {:ok, ${ns}.Page.from_map(body, "${escapeString(dataKey)}", ${itemCaster}, fetch_next)}`);
    lines.push('    end');
  } else {
    const resultExpr = castExpr(op.response, 'body', ctx, names);
    if (resultExpr === 'body') {
      lines.push(`    ${requestCall}`);
    } else {
      lines.push(`    with {:ok, body} <- ${requestCall} do`);
      lines.push(`      {:ok, ${resultExpr}}`);
      lines.push('    end');
    }
  }

  lines.push('  end');
  return lines.join('\n');
}

/**
 * URL-builder operation: composes a browser-redirect URL from the client's
 * base URL plus query params — no HTTP request. Hidden params (constant
 * defaults like `response_type`, client-inferred `client_id`) are injected.
 */
function renderUrlBuilder(resolved: ResolvedOperation, fname: string, ctx: EmitterContext): string {
  const ns = nsPascal(ctx);
  const op = resolved.operation;
  const pathParams = pathParamInfos(op);
  const defaults = getOpDefaults(resolved);
  const inferred = getOpInferFromClient(resolved);
  const injection = injectionLines(ns, defaults, inferred);
  const hidden = buildHiddenParams(resolved);
  const visibleQueryParams = op.queryParams.filter((p) => !hidden.has(p.name));

  const args = ['client', ...pathParams.map((p) => p.variable), 'params \\\\ %{}'];
  const specArgs = [`${ns}.Client.t()`, ...pathParams.map(() => 'String.t()'), 'map()'];

  const lines: string[] = [];
  lines.push('  @doc """');
  const summary = op.description?.trim() || humanize(resolved.methodName);
  lines.push(`  ${escapeDoc(summary).split('\n').join('\n  ')}`);
  lines.push('');
  lines.push('  Returns the fully-qualified redirect URL — no HTTP request is made.');
  for (const docLine of injectionDocLines(defaults, inferred)) {
    lines.push('');
    lines.push(docLine);
  }
  lines.push('');
  lines.push('  ## Parameters');
  lines.push('');
  for (const p of pathParams) {
    lines.push(pathParamDocLine(p));
  }
  if (visibleQueryParams.length > 0) {
    const namesList = visibleQueryParams.map(queryParamDoc).join(', ');
    lines.push(`    * \`params\` — query parameters: ${namesList}`);
  } else {
    lines.push('    * `params` — query parameters');
  }
  lines.push('  """');

  if (op.deprecated) {
    lines.push('  @deprecated "This operation is deprecated."');
  }

  lines.push(`  @spec ${fname}(${specArgs.join(', ')}) :: String.t()`);
  lines.push(`  def ${fname}(${args.join(', ')}) do`);
  lines.push(...injection);
  lines.push(`    ${ns}.Client.build_url(client, ${pathExpression(op, pathParams)}, params)`);
  lines.push('  end');
  return lines.join('\n');
}

/**
 * Union-split wrapper: a convenience method that pins the discriminating
 * defaults (e.g. `grant_type`), fills client-inferred credentials, and
 * delegates to the underlying operation's path.
 */
function renderWrapper(
  resolved: ResolvedOperation,
  wrapper: ResolvedWrapper,
  wname: string,
  ctx: EmitterContext,
  names: CastNames,
): string {
  const ns = nsPascal(ctx);
  const op = resolved.operation;
  const pathParams = pathParamInfos(op);
  const wrapperParams = resolveWrapperParams(wrapper, ctx);
  const required = wrapperParams.filter((p) => !p.isOptional);
  const optional = wrapperParams.filter((p) => p.isOptional);
  const injection = injectionLines(ns, wrapper.defaults, wrapper.inferFromClient);

  const responseRef: TypeRef =
    wrapper.responseModelName && names.modelNames.has(wrapper.responseModelName)
      ? { kind: 'model', name: wrapper.responseModelName }
      : op.response;

  const args = ['client', ...pathParams.map((p) => p.variable), 'params \\\\ %{}', 'opts \\\\ []'];
  const specArgs = [`${ns}.Client.t()`, ...pathParams.map(() => 'String.t()'), 'map()', 'keyword()'];
  const optsExpr = op.injectIdempotencyKey ? 'Keyword.put_new(opts, :idempotency, true)' : 'opts';
  const requestCall = `${ns}.Client.request(client, :${op.httpMethod}, ${pathExpression(op, pathParams)}, params, ${optsExpr})`;

  const lines: string[] = [];
  lines.push('  @doc """');
  lines.push(`  ${escapeDoc(formatWrapperDescription(wrapper.name))}`);
  const summary = op.description?.trim();
  if (summary) {
    lines.push('');
    lines.push(`  ${escapeDoc(summary).split('\n').join('\n  ')}`);
  }
  for (const docLine of injectionDocLines(wrapper.defaults, wrapper.inferFromClient)) {
    lines.push('');
    lines.push(docLine);
  }
  lines.push('');
  lines.push('  ## Parameters');
  lines.push('');
  for (const p of pathParams) {
    lines.push(pathParamDocLine(p));
  }
  const paramsDocParts: string[] = [];
  const wrapperParamDoc = (p: (typeof wrapperParams)[number]): string =>
    `\`:${varName(p.paramName)}\`${p.field?.deprecated ? ' (deprecated)' : ''}`;
  if (required.length > 0) {
    paramsDocParts.push(`Required: ${required.map(wrapperParamDoc).join(', ')}.`);
  }
  if (optional.length > 0) {
    paramsDocParts.push(`Optional: ${optional.map(wrapperParamDoc).join(', ')}.`);
  }
  lines.push(`    * \`params\` — request body map.${paramsDocParts.length > 0 ? ` ${paramsDocParts.join(' ')}` : ''}`);
  lines.push(`    * \`opts\` — per-request options (see \`${ns}.Client.request/5\`)`);
  lines.push('  """');

  if (op.deprecated) {
    lines.push('  @deprecated "This operation is deprecated."');
  }

  lines.push(`  @spec ${wname}(${specArgs.join(', ')}) ::`);
  lines.push(`          {:ok, ${mapTypeRef(responseRef, { nsPascal: ns })}} | {:error, ${ns}.Error.error()}`);
  lines.push(`  def ${wname}(${args.join(', ')}) do`);
  lines.push(...injection);

  const resultExpr = castExpr(responseRef, 'body', ctx, names);
  if (resultExpr === 'body') {
    lines.push(`    ${requestCall}`);
  } else {
    lines.push(`    with {:ok, body} <- ${requestCall} do`);
    lines.push(`      {:ok, ${resultExpr}}`);
    lines.push('    end');
  }

  lines.push('  end');
  return lines.join('\n');
}

/** "create_organization" → "Create organization." */
function humanize(methodName: string): string {
  const words = methodName.replace(/_/g, ' ').trim();
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}.`;
}
