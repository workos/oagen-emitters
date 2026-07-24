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
import { authAssertHeader } from './client.js';
import { buildFixtureEntries, generateFixtureFiles, fixtureName } from './fixtures.js';
import { scopedMountGroups, getOpDefaults, type MountGroup } from '../shared/resolved-ops.js';
import { buildExportedClassNameSet, resolveServiceTarget } from '../shared/service-name-collision.js';
import { parsePathTemplate } from '../shared/path-template.js';
import { resolveWrapperParams } from '../shared/wrapper-utils.js';

/**
 * Generate ExUnit tests (one file per mount group) plus their JSON fixtures,
 * the fixture loader helper, and test_helper.exs. Tests stub HTTP with
 * Req.Test plugs — no real network, `async: true` everywhere.
 */
export function generateTests(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  void spec;
  const ns = nsPascal(ctx);
  const groups = scopedMountGroups(ctx);
  const exported = buildExportedClassNameSet(ctx, moduleName);
  const fixtures = buildFixtureEntries(ctx);
  const modelNames = new Set(ctx.spec.models.map((m) => m.name));

  const files: GeneratedFile[] = [
    {
      path: 'test/test_helper.exs',
      content: 'ExUnit.start()',
      integrateTarget: true,
      overwriteExisting: true,
    },
    {
      path: 'test/support/test_fixtures.ex',
      content: renderTestFixturesModule(ns),
      integrateTarget: true,
      overwriteExisting: true,
    },
    ...generateFixtureFiles(ctx),
  ];

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

  files.push({
    path: `test/${ctx.namespace}/client_runtime_test.exs`,
    content: renderClientRuntimeTests(ctx, groups, exported, fixtures),
    integrateTarget: true,
    overwriteExisting: true,
  });
  return files;
}

/** First paginated operation with a fixture — target for the auto-pagination test. */
function findPaginatedOp(
  ctx: EmitterContext,
  groups: Map<string, MountGroup>,
  exported: ReturnType<typeof buildExportedClassNameSet>,
  fixtures: Map<string, unknown>,
): { call: string; fixture: string; cursorParam: string } | null {
  let fallback: { call: string; fixture: string; cursorParam: string } | null = null;
  for (const group of [...groups.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    for (const op of testableOps(group, ctx)) {
      if (op.wrapper) continue;
      const operation = op.resolved.operation;
      if (!planOperation(operation).isPaginated || !operation.pagination) continue;
      const fixture = fixtureName(group.name, op.fname);
      if (!fixtures.has(fixture)) continue;
      const target = resolveServiceTarget(group.name, exported, moduleName);
      const call = `${fullModuleName(ctx, target)}.${op.fname}(${['build_client()', ...op.callArgs].join(', ')})`;
      const candidate = { call, fixture, cursorParam: operation.pagination.param };
      if (op.callArgs.length === 0) return candidate;
      fallback ??= candidate;
    }
  }
  return fallback;
}

/**
 * Runtime-contract behavior tests: instance-scoped configuration, per-request
 * options on the wire, typed transport errors, and multi-page auto-pagination.
 */
function renderClientRuntimeTests(
  ctx: EmitterContext,
  groups: Map<string, MountGroup>,
  exported: ReturnType<typeof buildExportedClassNameSet>,
  fixtures: Map<string, unknown>,
): string {
  const ns = nsPascal(ctx);
  const auth = authAssertHeader(ctx.spec);
  const idemHeader = escapeString(ctx.spec.sdk.idempotency.headerName.toLowerCase());
  const paginated = findPaginatedOp(ctx, groups, exported, fixtures);

  const lines: string[] = [];
  lines.push(`defmodule ${ns}.ClientRuntimeTest do`);
  lines.push('  use ExUnit.Case, async: true');
  lines.push('');
  lines.push('  defp build_client(opts \\\\ []) do');
  lines.push(`    [api_key: "sk_test_key", req_options: [plug: {Req.Test, ${ns}.Client}]]`);
  lines.push('    |> Keyword.merge(opts)');
  lines.push(`    |> ${ns}.Client.new()`);
  lines.push('  end');
  lines.push('');
  lines.push('  test "client configuration is instance-scoped" do');
  lines.push('    client_a = build_client(api_key: "sk_a")');
  lines.push('    client_b = build_client(api_key: "sk_b")');
  lines.push('');
  lines.push(`    Req.Test.stub(${ns}.Client, fn conn ->`);
  lines.push(`      assert Plug.Conn.get_req_header(conn, "${auth.name}") == ["${auth.valuePrefix}sk_a"]`);
  lines.push('      Req.Test.json(conn, %{})');
  lines.push('    end)');
  lines.push('');
  lines.push(`    assert {:ok, _} = ${ns}.Client.request(client_a, :get, "/instance-scope")`);
  lines.push('');
  lines.push(`    Req.Test.stub(${ns}.Client, fn conn ->`);
  lines.push(`      assert Plug.Conn.get_req_header(conn, "${auth.name}") == ["${auth.valuePrefix}sk_b"]`);
  lines.push('      Req.Test.json(conn, %{})');
  lines.push('    end)');
  lines.push('');
  lines.push(`    assert {:ok, _} = ${ns}.Client.request(client_b, :get, "/instance-scope")`);
  lines.push('  end');
  lines.push('');
  lines.push('  test "per-request headers and query options are sent on the wire" do');
  lines.push(`    Req.Test.stub(${ns}.Client, fn conn ->`);
  lines.push('      assert Plug.Conn.get_req_header(conn, "x-request-option") == ["honored"]');
  lines.push('      assert Plug.Conn.fetch_query_params(conn).query_params["limit"] == "2"');
  lines.push('      Req.Test.json(conn, %{})');
  lines.push('    end)');
  lines.push('');
  lines.push('    assert {:ok, _} =');
  lines.push(`             ${ns}.Client.request(build_client(), :get, "/option-check", %{limit: 2},`);
  lines.push('               headers: [{"x-request-option", "honored"}]');
  lines.push('             )');
  lines.push('  end');
  lines.push('');
  lines.push('  test "per-request idempotency key is sent on the wire" do');
  lines.push(`    Req.Test.stub(${ns}.Client, fn conn ->`);
  lines.push(`      assert Plug.Conn.get_req_header(conn, "${idemHeader}") == ["idem_123"]`);
  lines.push('      Req.Test.json(conn, %{})');
  lines.push('    end)');
  lines.push('');
  lines.push('    assert {:ok, _} =');
  lines.push(`             ${ns}.Client.request(build_client(), :post, "/option-check", %{},`);
  lines.push('               idempotency_key: "idem_123"');
  lines.push('             )');
  lines.push('  end');
  lines.push('');
  lines.push('  test "user agent reports the SDK package version" do');
  lines.push(`    Req.Test.stub(${ns}.Client, fn conn ->`);
  lines.push('      assert [ua] = Plug.Conn.get_req_header(conn, "user-agent")');
  lines.push(`      assert ua == "${ctx.namespace}-elixir/" <> ${ns}.version()`);
  lines.push('      Req.Test.json(conn, %{})');
  lines.push('    end)');
  lines.push('');
  lines.push(`    assert {:ok, _} = ${ns}.Client.request(build_client(), :get, "/ua-check")`);
  lines.push('  end');
  lines.push('');
  lines.push(`  test "transport failures surface as ${ns}.TransportError" do`);
  lines.push(`    Req.Test.stub(${ns}.Client, fn conn ->`);
  lines.push('      Req.Test.transport_error(conn, :econnrefused)');
  lines.push('    end)');
  lines.push('');
  lines.push('    client = build_client(max_retries: 0)');
  lines.push(`    assert {:error, %${ns}.TransportError{}} = ${ns}.Client.request(client, :get, "/down")`);
  lines.push('  end');
  if (paginated) {
    lines.push('');
    lines.push('  test "auto-pagination streams items across multiple pages" do');
    lines.push(`    base = ${ns}.TestFixtures.fixture("${paginated.fixture}")`);
    lines.push('    page1 = Map.put(base, "list_metadata", %{"before" => nil, "after" => "cursor_page_2"})');
    lines.push('    page2 = Map.put(base, "list_metadata", %{"before" => nil, "after" => nil})');
    lines.push('');
    lines.push(`    Req.Test.stub(${ns}.Client, fn conn ->`);
    lines.push('      conn = Plug.Conn.fetch_query_params(conn)');
    lines.push('');
    lines.push(`      if conn.query_params["${escapeString(paginated.cursorParam)}"] == "cursor_page_2" do`);
    lines.push('        Req.Test.json(conn, page2)');
    lines.push('      else');
    lines.push('        Req.Test.json(conn, page1)');
    lines.push('      end');
    lines.push('    end)');
    lines.push('');
    lines.push(`    assert {:ok, %${ns}.Page{} = page} = ${paginated.call}`);
    lines.push(`    assert page |> ${ns}.Page.stream() |> Enum.count() == 2`);
    lines.push('  end');
  }
  lines.push('end');
  return lines.join('\n');
}

function renderTestFixturesModule(ns: string): string {
  return [
    `defmodule ${ns}.TestFixtures do`,
    '  @moduledoc false',
    '',
    '  @fixtures_dir Path.join(__DIR__, "fixtures")',
    '',
    '  @doc "Loads and decodes a JSON fixture by name (without extension)."',
    '  @spec fixture(String.t()) :: term()',
    '  def fixture(name) do',
    '    @fixtures_dir |> Path.join(name <> ".json") |> File.read!() |> JSON.decode!()',
    '  end',
    'end',
  ].join('\n');
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
    if (!(resolved as { urlBuilder?: boolean }).urlBuilder) {
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
