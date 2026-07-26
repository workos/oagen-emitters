import type {
  ApiSpec,
  EmitterContext,
  GeneratedFile,
  TypeRef,
  ResolvedOperation,
  ResolvedWrapper,
} from '@workos/oagen';
import { planOperation } from '@workos/oagen';
import { moduleName, fileName, fullModuleName, functionName, varName, nsPascal, escapeString } from './naming.js';
import { buildFixtureEntries, generateFixtureFiles, fixtureName } from './fixtures.js';
import { scopedMountGroups, getOpDefaults, type MountGroup } from '../shared/resolved-ops.js';
import { buildExportedClassNameSet, resolveServiceTarget } from '../shared/service-name-collision.js';
import { parsePathTemplate } from '../shared/path-template.js';
import { resolveWrapperParams } from '../shared/wrapper-utils.js';

/**
 * Generate ExUnit tests (one file per mount group) plus their JSON fixtures.
 * Tests stub HTTP with Req.Test plugs — no real network, `async: true`
 * everywhere.
 *
 * test_helper.exs, the fixture loader, and the client runtime-contract tests
 * are hand-maintained in the target SDK (@oagen-ignore-file) — never emitted.
 */
export function generateTests(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  void spec;
  const groups = scopedMountGroups(ctx);
  const exported = buildExportedClassNameSet(ctx, moduleName);
  const fixtures = buildFixtureEntries(ctx);
  const modelNames = new Set(ctx.spec.models.map((m) => m.name));

  const files: GeneratedFile[] = [...generateFixtureFiles(ctx)];

  for (const group of [...groups.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const target = resolveServiceTarget(group.name, exported, moduleName);
    const content = renderGroupTests(group, target, ctx, fixtures, modelNames);
    if (content === null) continue;
    files.push({
      path: `test/${ctx.namespace}/${fileName(target)}_test.exs`,
      content,
      integrateTarget: true,
      overwriteExisting: true,
    });
  }

  return files;
}

interface TestableOp {
  resolved: ResolvedOperation;
  fname: string;
  /** Call arguments after `client`. */
  callArgs: string[];
  /** Set when this entry is a union-split wrapper method. */
  wrapper?: ResolvedWrapper;
}

function pathCallArgs(resolved: ResolvedOperation): string[] {
  return parsePathTemplate(resolved.operation.path)
    .filter((s) => s.kind === 'param')
    .map((s) => `"test_${varName((s as { name: string }).name)}"`);
}

/** Elixir map literal covering a wrapper's required params with type-shaped placeholders. */
function wrapperParamsLiteral(wrapper: ResolvedWrapper, ctx: EmitterContext): string {
  const required = resolveWrapperParams(wrapper, ctx).filter((p) => !p.isOptional);
  if (required.length === 0) return '%{}';
  const entries = required.map(({ paramName, field }) => {
    const key = varName(paramName);
    const kind = field?.type.kind === 'nullable' ? field.type.inner.kind : field?.type.kind;
    const primType =
      field?.type.kind === 'primitive'
        ? field.type.type
        : field?.type.kind === 'nullable' && field.type.inner.kind === 'primitive'
          ? field.type.inner.type
          : null;
    let value: string;
    if (primType === 'boolean') value = 'true';
    else if (primType === 'integer' || primType === 'number') value = '1';
    else if (kind === 'array') value = `["test_${key}"]`;
    else value = `"test_${key}"`;
    return `${key}: ${value}`;
  });
  return `%{${entries.join(', ')}}`;
}

function testableOps(group: MountGroup, ctx: EmitterContext): TestableOp[] {
  const out: TestableOp[] = [];
  const seen = new Set<string>();
  for (const resolved of group.resolvedOps) {
    // Split operations expose only their wrappers (matches resources.ts).
    const hasWrappers = (resolved.wrappers?.length ?? 0) > 0;
    if (!hasWrappers && !(resolved as { urlBuilder?: boolean }).urlBuilder) {
      const fname = functionName(resolved.methodName);
      if (!seen.has(fname)) {
        seen.add(fname);
        out.push({ resolved, fname, callArgs: pathCallArgs(resolved) });
      }
    }
    for (const wrapper of resolved.wrappers ?? []) {
      const wname = functionName(wrapper.name);
      if (seen.has(wname)) continue;
      seen.add(wname);
      out.push({
        resolved,
        fname: wname,
        callArgs: [...pathCallArgs(resolved), wrapperParamsLiteral(wrapper, ctx)],
        wrapper,
      });
    }
  }
  return out;
}

/** URL-builder ops in a group (no HTTP request — tested separately). */
function urlBuilderOps(group: MountGroup): TestableOp[] {
  const out: TestableOp[] = [];
  const seen = new Set<string>();
  for (const resolved of group.resolvedOps) {
    if (!(resolved as { urlBuilder?: boolean }).urlBuilder) continue;
    const fname = functionName(resolved.methodName);
    if (seen.has(fname)) continue;
    seen.add(fname);
    out.push({ resolved, fname, callArgs: pathCallArgs(resolved) });
  }
  return out;
}

function renderGroupTests(
  group: MountGroup,
  target: string,
  ctx: EmitterContext,
  fixtures: Map<string, unknown>,
  modelNames: Set<string>,
): string | null {
  const ns = nsPascal(ctx);
  const ops = testableOps(group, ctx);
  const urlBuilders = urlBuilderOps(group);
  if (ops.length === 0 && urlBuilders.length === 0) return null;

  const serviceModule = fullModuleName(ctx, target);
  const lines: string[] = [];
  lines.push(`defmodule ${serviceModule}Test do`);
  lines.push('  use ExUnit.Case, async: true');
  lines.push('');
  lines.push('  setup do');
  lines.push('    client =');
  lines.push(`      ${ns}.Client.new(`);
  lines.push('        api_key: "sk_test_key",');
  lines.push(`        req_options: [plug: {Req.Test, ${ns}.Client}]`);
  lines.push('      )');
  lines.push('');
  lines.push('    {:ok, client: client}');
  lines.push('  end');

  for (const op of ops) {
    lines.push('');
    lines.push(renderOpTest(op, group, serviceModule, ctx, fixtures, modelNames));
  }

  for (const op of urlBuilders) {
    lines.push('');
    lines.push(renderUrlBuilderTest(op, serviceModule));
  }

  if (ops.length > 0) {
    lines.push('');
    lines.push(renderErrorTest(ops[0], serviceModule, ctx));
  }
  lines.push('end');
  return lines.join('\n');
}

/**
 * URL-builder assertion: the function returns a string URL rooted at the
 * client's base URL, containing the operation path and any constant defaults
 * in the query string — without touching the network (no stub installed).
 */
function renderUrlBuilderTest(op: TestableOp, serviceModule: string): string {
  const call = `${serviceModule}.${op.fname}(${['client', ...op.callArgs].join(', ')})`;
  const defaults = getOpDefaults(op.resolved);
  const specPath = op.resolved.operation.path;

  const lines: string[] = [];
  lines.push(`  test "${op.fname} builds a redirect URL without an HTTP request", %{client: client} do`);
  lines.push(`    url = ${call}`);
  lines.push('');
  lines.push('    assert is_binary(url)');
  lines.push('    assert String.starts_with?(url, client.base_url)');
  // Path params are interpolated, so assert on the longest literal prefix.
  const literalPrefix = specPath.split('{')[0];
  lines.push(`    assert url =~ "${escapeString(literalPrefix)}"`);
  for (const [key, value] of Object.entries(defaults)) {
    lines.push(`    assert url =~ URI.encode_query(%{"${escapeString(key)}" => "${escapeString(String(value))}"})`);
  }
  lines.push('  end');
  return lines.join('\n');
}

function renderOpTest(
  op: TestableOp,
  group: MountGroup,
  serviceModule: string,
  ctx: EmitterContext,
  fixtures: Map<string, unknown>,
  modelNames: Set<string>,
): string {
  const ns = nsPascal(ctx);
  const fixture = fixtureName(group.name, op.fname);
  const hasFixture = fixtures.has(fixture);
  const call = `${serviceModule}.${op.fname}(${['client', ...op.callArgs].join(', ')})`;
  const pattern = op.wrapper
    ? wrapperSuccessPattern(op.wrapper, op.resolved, ctx, modelNames)
    : successPattern(op.resolved, ctx, modelNames);
  // Wrappers pin constant body defaults (grant_type, application_type) — assert
  // they actually reach the wire, not just that the response deserializes.
  const bodyAsserts =
    op.wrapper && !['get', 'delete', 'head'].includes(op.resolved.operation.httpMethod)
      ? Object.entries(op.wrapper.defaults)
      : [];

  const lines: string[] = [];
  lines.push(`  test "${op.fname} succeeds", %{client: client} do`);
  lines.push(`    Req.Test.stub(${ns}.Client, fn conn ->`);
  if (bodyAsserts.length > 0) {
    lines.push('      {:ok, req_body, conn} = Plug.Conn.read_body(conn)');
    lines.push('      req_body = JSON.decode!(req_body)');
    for (const [key, value] of bodyAsserts) {
      const literal = typeof value === 'string' ? `"${escapeString(value)}"` : String(value);
      lines.push(`      assert req_body["${escapeString(key)}"] == ${literal}`);
    }
  }
  if (hasFixture) {
    lines.push(`      Req.Test.json(conn, ${ns}.TestFixtures.fixture("${fixture}"))`);
  } else {
    lines.push('      Plug.Conn.send_resp(conn, 204, "")');
  }
  lines.push('    end)');
  lines.push('');
  lines.push(`    assert ${pattern} = ${call}`);
  lines.push('  end');
  return lines.join('\n');
}

function wrapperSuccessPattern(
  wrapper: ResolvedWrapper,
  resolved: ResolvedOperation,
  ctx: EmitterContext,
  modelNames: Set<string>,
): string {
  if (wrapper.responseModelName && modelNames.has(wrapper.responseModelName)) {
    return `{:ok, %${fullModuleName(ctx, wrapper.responseModelName)}{}}`;
  }
  return successPattern(resolved, ctx, modelNames);
}

function successPattern(resolved: ResolvedOperation, ctx: EmitterContext, modelNames: Set<string>): string {
  const ns = nsPascal(ctx);
  const op = resolved.operation;
  const plan = planOperation(op);

  if (plan.isPaginated && op.pagination) {
    const itemModel = modelRefName(op.pagination.itemType, modelNames);
    if (itemModel) {
      return `{:ok, %${ns}.Page{data: [%${fullModuleName(ctx, itemModel)}{} | _]}}`;
    }
    return `{:ok, %${ns}.Page{}}`;
  }

  const responseModel = modelRefName(op.response, modelNames);
  if (responseModel) {
    return `{:ok, %${fullModuleName(ctx, responseModel)}{}}`;
  }
  if (op.response.kind === 'array') {
    const itemModel = modelRefName(op.response.items, modelNames);
    if (itemModel) {
      return `{:ok, [%${fullModuleName(ctx, itemModel)}{} | _]}`;
    }
  }
  return '{:ok, _}';
}

function modelRefName(ref: TypeRef, modelNames: Set<string>): string | null {
  if (ref.kind === 'model' && modelNames.has(ref.name)) return ref.name;
  if (ref.kind === 'nullable') return modelRefName(ref.inner, modelNames);
  return null;
}

function renderErrorTest(op: TestableOp, serviceModule: string, ctx: EmitterContext): string {
  const ns = nsPascal(ctx);
  const call = `${serviceModule}.${op.fname}(${['client', ...op.callArgs].join(', ')})`;
  const lines: string[] = [];
  lines.push('  test "surfaces API errors as tagged tuples", %{client: client} do');
  lines.push(`    Req.Test.stub(${ns}.Client, fn conn ->`);
  lines.push('      conn');
  lines.push('      |> Plug.Conn.put_status(401)');
  lines.push('      |> Req.Test.json(%{"message" => "Unauthorized"})');
  lines.push('    end)');
  lines.push('');
  lines.push(`    assert {:error, %${ns}.ApiError{status: 401}} = ${call}`);
  lines.push('  end');
  return lines.join('\n');
}
