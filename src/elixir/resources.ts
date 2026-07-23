import type { EmitterContext, GeneratedFile, Operation, Service, ResolvedOperation } from '@workos/oagen';
import { planOperation } from '@workos/oagen';
import { mapTypeRef } from './type-map.js';
import {
  moduleName,
  fileName,
  fullModuleName,
  functionName,
  varName,
  escapeDoc,
  escapeString,
  nsPascal,
} from './naming.js';
import { castExpr, casterFun, type CastNames } from './casting.js';
import { scopedMountGroups, type MountGroup } from '../shared/resolved-ops.js';
import { buildExportedClassNameSet, resolveServiceTarget } from '../shared/service-name-collision.js';
import { parsePathTemplate } from '../shared/path-template.js';
import { getSyntheticEnums } from '../shared/model-utils.js';

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
    if ((resolved as { urlBuilder?: boolean }).urlBuilder) continue;
    const fname = functionName(resolved.methodName);
    if (seen.has(fname)) continue;
    seen.add(fname);
    methods.push(renderMethod(resolved, fname, ctx, names));
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

function renderMethod(resolved: ResolvedOperation, fname: string, ctx: EmitterContext, names: CastNames): string {
  const ns = nsPascal(ctx);
  const op = resolved.operation;
  const plan = planOperation(op);
  const pathParams = pathParamInfos(op);
  const hasParams = plan.hasBody || plan.hasQueryParams || plan.isPaginated;
  const isQueryMethod = ['get', 'delete', 'head'].includes(op.httpMethod);

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
  lines.push('');
  lines.push('  ## Parameters');
  lines.push('');
  for (const p of pathParams) {
    lines.push(`    * \`${p.variable}\` — ${escapeDoc(p.description ?? 'path parameter')}`);
  }
  if (hasParams) {
    if (isQueryMethod && op.queryParams.length > 0) {
      const namesList = op.queryParams.map((p) => `\`:${varName(p.name)}\``).join(', ');
      lines.push(`    * \`params\` — query parameters: ${namesList}`);
    } else if (isQueryMethod) {
      lines.push('    * `params` — query parameters');
    } else {
      lines.push('    * `params` — request body map');
    }
  }
  lines.push(`    * \`opts\` — per-request options (see \`${ns}.Client.request/5\`)`);
  lines.push('  """');

  if (op.deprecated) {
    lines.push('  @deprecated "This operation is deprecated."');
  }

  // Spec
  const returnSpec = plan.isPaginated
    ? `${ns}.Page.t(${mapTypeRef(op.pagination!.itemType, { nsPascal: ns })})`
    : mapTypeRef(op.response, { nsPascal: ns });
  lines.push(`  @spec ${fname}(${specArgs.join(', ')}) ::`);
  lines.push(`          {:ok, ${returnSpec}} | {:error, ${ns}.Error.error()}`);

  // Body
  lines.push(`  def ${fname}(${args.join(', ')}) do`);

  if (plan.isPaginated && op.pagination) {
    const dataKey = op.pagination.dataPath ?? 'data';
    const itemCaster = casterFun(op.pagination.itemType, ctx, names) ?? '&Function.identity/1';
    const cursorParam = op.pagination.param;
    const recallArgs = ['client', ...pathParams.map((p) => p.variable)];
    lines.push(`    with {:ok, body} <- ${requestCall} do`);
    lines.push('      fetch_next = fn cursor ->');
    lines.push(`        ${fname}(`);
    for (const arg of recallArgs) {
      lines.push(`          ${arg},`);
    }
    lines.push(
      `          params |> Map.new(fn {k, v} -> {to_string(k), v} end) |> Map.put("${escapeString(cursorParam)}", cursor),`,
    );
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

/** "create_organization" → "Create organization." */
function humanize(methodName: string): string {
  const words = methodName.replace(/_/g, ' ').trim();
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}.`;
}
