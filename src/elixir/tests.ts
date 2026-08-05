import type {
  ApiSpec,
  EmitterContext,
  GeneratedFile,
  Model,
  TypeRef,
  ResolvedOperation,
  ResolvedWrapper,
} from '@workos/oagen';
import { planOperation } from '@workos/oagen';
import {
  moduleName,
  fileName,
  fullModuleName,
  functionName,
  varName,
  fieldName,
  nsPascal,
  escapeString,
} from './naming.js';
import { buildFixtureEntries, generateFixtureFiles, fixtureName, roundTripSample } from './fixtures.js';
import { getSyntheticEnums, resolvePaginationItemType } from '../shared/model-utils.js';
import { scopedMountGroups, getOpDefaults, isModelInScope, type MountGroup } from '../shared/resolved-ops.js';
import { methodTakesParams } from './resources.js';
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

    const roundTrip = renderRoundTripTests(group, target, ctx, modelNames);
    if (roundTrip !== null) {
      files.push({
        path: `test/${ctx.namespace}/${fileName(target)}_round_trip_test.exs`,
        content: roundTrip,
        integrateTarget: true,
        overwriteExisting: true,
      });
    }
  }

  return files;
}

/** Response models reachable from a mount group's operations, in stable order. */
function groupResponseModels(group: MountGroup, modelNames: Set<string>, models: Map<string, Model>): string[] {
  const out = new Set<string>();
  for (const resolved of group.resolvedOps) {
    const op = resolved.operation;
    const plan = planOperation(op);
    if (plan.isPaginated && op.pagination) {
      const item = modelRefName(resolvePaginationItemType(op.pagination.itemType, models), modelNames);
      if (item) out.add(item);
    }
    const response = modelRefName(op.response, modelNames);
    if (response) out.add(response);
    if (op.response.kind === 'array') {
      const item = modelRefName(op.response.items, modelNames);
      if (item) out.add(item);
    }
    for (const wrapper of resolved.wrappers ?? []) {
      if (wrapper.responseModelName && modelNames.has(wrapper.responseModelName)) {
        out.add(wrapper.responseModelName);
      }
    }
  }
  return [...out].sort();
}

/** Render a JSON-ish sample as an Elixir map/list literal with string keys. */
function elixirTerm(value: unknown): string {
  if (value === null || value === undefined) return 'nil';
  if (typeof value === 'string') return `"${escapeString(value)}"`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(elixirTerm).join(', ')}]`;
  const entries = Object.entries(value as Record<string, unknown>).map(
    ([k, v]) => `"${escapeString(k)}" => ${elixirTerm(v)}`,
  );
  return `%{${entries.join(', ')}}`;
}

/**
 * Serialization coverage for a group's response models: wire payload →
 * `from_map` → `to_map` must reproduce the payload exactly, and a second pass
 * must be stable. This is what catches casing drift, enum dump mismatches, and
 * nested cast errors that a "returns the right struct" assertion cannot.
 */
function renderRoundTripTests(
  group: MountGroup,
  target: string,
  ctx: EmitterContext,
  modelNames: Set<string>,
): string | null {
  const models = new Map(ctx.spec.models.map((m) => [m.name, m]));
  const enums = new Map([...ctx.spec.enums, ...getSyntheticEnums()].map((e) => [e.name, e]));

  const testable = groupResponseModels(group, modelNames, models)
    .map((name) => models.get(name))
    .filter((m): m is NonNullable<typeof m> => !!m && m.fields.length > 0 && isModelInScope(m.name, ctx));
  if (testable.length === 0) return null;

  const lines: string[] = [];
  lines.push(`defmodule ${fullModuleName(ctx, target)}RoundTripTest do`);
  lines.push('  use ExUnit.Case, async: true');

  for (const model of testable) {
    const mod = fullModuleName(ctx, model.name);
    const sample = roundTripSample(model, models, enums);
    lines.push('');
    lines.push(`  test "${moduleName(model.name)} round-trips between wire and struct" do`);
    lines.push(`    data = ${elixirTerm(sample)}`);
    lines.push('');
    lines.push(`    serialized = data |> ${mod}.from_map() |> ${mod}.to_map()`);
    lines.push('    assert serialized == data');
    lines.push('');
    lines.push(`    assert serialized |> ${mod}.from_map() |> ${mod}.to_map() == serialized`);
    lines.push('  end');
  }

  lines.push('end');
  return lines.join('\n');
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

/**
 * The exact `conn.request_path` the generated call produces: path params are
 * substituted with the same `test_<var>` literals `pathCallArgs` passes, which
 * contain only unreserved characters so `URI.encode` is the identity here.
 */
function expectedRequestPath(resolved: ResolvedOperation): string {
  let out = '';
  for (const segment of parsePathTemplate(resolved.operation.path)) {
    out += segment.kind === 'literal' ? segment.value : `test_${varName(segment.name)}`;
  }
  return out;
}

/** A scalar field assertion lifted from a fixture: `:elixir_field` == literal. */
interface FieldAssertion {
  field: string;
  literal: string;
}

function scalarLiteral(value: unknown): string | null {
  if (typeof value === 'string') return `"${escapeString(value)}"`;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return null;
}

/**
 * Pick up to `limit` scalar fields to assert on, driven by the MODEL's field
 * list rather than the fixture's raw keys. The model dedupes fields that
 * collapse to the same snake_case struct key (the spec ships deprecated
 * camelCase aliases such as `createdAt` beside `created_at`), and only the
 * first survives — reading fixture keys directly would pair a struct key with
 * the alias's differing sample value and assert something untrue.
 */
function assertableFields(
  modelName: string | null,
  fixtureData: unknown,
  ctx: EmitterContext,
  limit = 2,
): FieldAssertion[] {
  if (!modelName || typeof fixtureData !== 'object' || fixtureData === null) return [];
  const model = ctx.spec.models.find((m) => m.name === modelName);
  if (!model) return [];
  const data = fixtureData as Record<string, unknown>;

  const out: FieldAssertion[] = [];
  const seen = new Set<string>();
  for (const field of model.fields) {
    const key = fieldName(field.name);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!(field.name in data)) continue;
    // Enum fields deserialize to atoms via Cast.enum/2, so the fixture's raw
    // string is not what lands on the struct — leave them to the round-trip
    // tests rather than asserting a value that was never produced.
    if (baseTypeKind(field.type) === 'enum') continue;
    const literal = scalarLiteral(data[field.name]);
    if (literal === null) continue;
    out.push({ field: key, literal });
    if (out.length >= limit) break;
  }
  return out;
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
    if (planOperation(op.resolved.operation).isPaginated && op.resolved.operation.pagination) {
      lines.push('');
      lines.push(renderEmptyPageTest(op, serviceModule, ctx));
    }
  }

  for (const op of urlBuilders) {
    lines.push('');
    lines.push(renderUrlBuilderTest(op, serviceModule));
  }

  // One query-encoding witness per group: the first op that declares query
  // params and yields at least one assertable encoding rule.
  for (const op of ops) {
    const queryTest = renderQueryEncodingTest(op, serviceModule, ctx);
    if (queryTest) {
      lines.push('');
      lines.push(queryTest);
      break;
    }
  }

  if (ops.length > 0) {
    lines.push('');
    lines.push(renderRequestOptionsTest(ops[0], serviceModule, ctx));
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
  const shape = op.wrapper
    ? wrapperSuccessShape(op.wrapper, op.resolved, ctx, modelNames)
    : successShape(op.resolved, ctx, modelNames);
  const asserts = assertableFields(shape.modelName, fixtureAt(fixtures.get(fixture), shape.fixturePath), ctx);
  const pattern = shape.render(asserts.map((a) => `${a.field}: ${a.literal}`).join(', '));
  // Wrappers pin constant body defaults (grant_type, application_type) — assert
  // they actually reach the wire, not just that the response deserializes.
  const bodyAsserts =
    op.wrapper && !['get', 'delete', 'head'].includes(op.resolved.operation.httpMethod)
      ? Object.entries(op.wrapper.defaults)
      : [];

  const lines: string[] = [];
  lines.push(`  test "${op.fname} succeeds", %{client: client} do`);
  lines.push(`    Req.Test.stub(${ns}.Client, fn conn ->`);
  lines.push(`      assert conn.method == "${op.resolved.operation.httpMethod.toUpperCase()}"`);
  lines.push(`      assert conn.request_path == "${escapeString(expectedRequestPath(op.resolved))}"`);
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

/**
 * Empty-page coverage for a paginated op: no items, no next cursor, and an
 * exhausted stream. Guards the "returns the right class" pagination
 * anti-pattern the runtime contract calls out.
 */
function renderEmptyPageTest(op: TestableOp, serviceModule: string, ctx: EmitterContext): string {
  const ns = nsPascal(ctx);
  const dataPath = op.resolved.operation.pagination?.dataPath ?? 'data';
  const call = `${serviceModule}.${op.fname}(${['client', ...op.callArgs].join(', ')})`;

  const lines: string[] = [];
  lines.push(`  test "${op.fname} handles an empty page", %{client: client} do`);
  lines.push(`    Req.Test.stub(${ns}.Client, fn conn ->`);
  lines.push(`      Req.Test.json(conn, %{"${escapeString(dataPath)}" => [], "list_metadata" => %{"after" => nil}})`);
  lines.push('    end)');
  lines.push('');
  lines.push(`    assert {:ok, %${ns}.Page{data: []} = page} = ${call}`);
  lines.push(`    refute ${ns}.Page.has_more?(page)`);
  lines.push(`    assert page |> ${ns}.Page.stream() |> Enum.to_list() == []`);
  lines.push('  end');
  return lines.join('\n');
}

/**
 * The success match for an operation, plus the model whose fields the caller may
 * assert on and where in the fixture that model's sample lives. `render(inner)`
 * splices field assertions into that model's braces.
 */
interface SuccessShape {
  render: (inner: string) => string;
  /** Model the asserted fields belong to, or null when nothing is assertable. */
  modelName: string | null;
  /** Path into the fixture where that model's sample sits ('' = fixture root). */
  fixturePath: string[];
}

function wrapperSuccessShape(
  wrapper: ResolvedWrapper,
  resolved: ResolvedOperation,
  ctx: EmitterContext,
  modelNames: Set<string>,
): SuccessShape {
  if (wrapper.responseModelName && modelNames.has(wrapper.responseModelName)) {
    const mod = fullModuleName(ctx, wrapper.responseModelName);
    return {
      render: (inner) => `{:ok, %${mod}{${inner}}}`,
      modelName: wrapper.responseModelName,
      fixturePath: [],
    };
  }
  return successShape(resolved, ctx, modelNames);
}

function successShape(resolved: ResolvedOperation, ctx: EmitterContext, modelNames: Set<string>): SuccessShape {
  const ns = nsPascal(ctx);
  const op = resolved.operation;
  const plan = planOperation(op);

  if (plan.isPaginated && op.pagination) {
    const models = new Map(ctx.spec.models.map((m) => [m.name, m]));
    const itemModel = modelRefName(resolvePaginationItemType(op.pagination.itemType, models), modelNames);
    if (itemModel) {
      const mod = fullModuleName(ctx, itemModel);
      return {
        render: (inner) => `{:ok, %${ns}.Page{data: [%${mod}{${inner}} | _]}}`,
        modelName: itemModel,
        fixturePath: [op.pagination.dataPath ?? 'data', '0'],
      };
    }
    return { render: () => `{:ok, %${ns}.Page{}}`, modelName: null, fixturePath: [] };
  }

  const responseModel = modelRefName(op.response, modelNames);
  if (responseModel) {
    const mod = fullModuleName(ctx, responseModel);
    return { render: (inner) => `{:ok, %${mod}{${inner}}}`, modelName: responseModel, fixturePath: [] };
  }
  if (op.response.kind === 'array') {
    const itemModel = modelRefName(op.response.items, modelNames);
    if (itemModel) {
      const mod = fullModuleName(ctx, itemModel);
      return { render: (inner) => `{:ok, [%${mod}{${inner}} | _]}`, modelName: itemModel, fixturePath: ['0'] };
    }
  }
  return { render: () => '{:ok, _}', modelName: null, fixturePath: [] };
}

/** Walk a fixture along a `fixturePath` produced by {@link successShape}. */
function fixtureAt(data: unknown, path: string[]): unknown {
  let cur = data;
  for (const step of path) {
    if (Array.isArray(cur)) cur = cur[Number(step)];
    else if (cur && typeof cur === 'object') cur = (cur as Record<string, unknown>)[step];
    else return undefined;
  }
  return cur;
}

function modelRefName(ref: TypeRef, modelNames: Set<string>): string | null {
  if (ref.kind === 'model' && modelNames.has(ref.name)) return ref.name;
  if (ref.kind === 'nullable') return modelRefName(ref.inner, modelNames);
  return null;
}

/** Unwrap nullable to reach the underlying kind of a query param. */
function baseTypeKind(ref: TypeRef | undefined): string | undefined {
  if (!ref) return undefined;
  return ref.kind === 'nullable' ? baseTypeKind(ref.inner) : ref.kind;
}

/**
 * Query-encoding coverage: arrays comma-join, maps JSON-encode, special
 * characters survive percent-encoding, and params the caller omits are absent.
 * Emitted for the first op in the group that actually declares query params —
 * the generic encoding rules live in the runtime, so one witness per service
 * proves the wiring without 80 near-identical tests.
 */
function renderQueryEncodingTest(op: TestableOp, serviceModule: string, ctx: EmitterContext): string | null {
  const ns = nsPascal(ctx);
  const queryParams = op.resolved.operation.queryParams ?? [];
  if (queryParams.length === 0) return null;

  const entries: string[] = [];
  const asserts: string[] = [];
  let omitted: string | null = null;

  for (const p of queryParams) {
    const kind = baseTypeKind(p.type);
    const key = varName(p.name);
    if (kind === 'array' && !entries.some((e) => e.startsWith(`${key}:`))) {
      entries.push(`${key}: ["a", "b"]`);
      asserts.push(`      assert params["${escapeString(p.name)}"] == "a,b"`);
    } else if (kind === 'map' && !entries.some((e) => e.startsWith(`${key}:`))) {
      entries.push(`${key}: %{"k" => "v"}`);
      asserts.push(`      assert params["${escapeString(p.name)}"] == ~s({"k":"v"})`);
    } else if (kind === 'primitive' && asserts.length < 3 && !omitted) {
      // one scalar carries the special-character case; the next is left out
      // entirely to prove absent optionals are not sent
      if (!entries.some((e) => e.includes('hello world'))) {
        entries.push(`${key}: "hello world&x"`);
        asserts.push(`      assert params["${escapeString(p.name)}"] == "hello world&x"`);
      } else {
        omitted = p.name;
      }
    }
  }
  if (asserts.length === 0) return null;

  const callArgs = ['client', ...op.callArgs.filter((a) => a.startsWith('"')), `%{${entries.join(', ')}}`];
  const lines: string[] = [];
  lines.push(`  test "${op.fname} encodes query parameters", %{client: client} do`);
  lines.push(`    Req.Test.stub(${ns}.Client, fn conn ->`);
  lines.push('      params = Plug.Conn.fetch_query_params(conn).query_params');
  lines.push(...asserts);
  if (omitted) lines.push(`      refute Map.has_key?(params, "${escapeString(omitted)}")`);
  lines.push('      Req.Test.json(conn, %{"data" => [], "list_metadata" => %{"after" => nil}})');
  lines.push('    end)');
  lines.push('');
  lines.push(`    assert {:ok, _} = ${serviceModule}.${op.fname}(${callArgs.join(', ')})`);
  lines.push('  end');
  return lines.join('\n');
}

/**
 * Per-request option propagation: extra headers and a base-URL override must
 * reach the wire. The contract forbids claiming per-request option support
 * without a test proving the runtime honors it.
 */
function renderRequestOptionsTest(op: TestableOp, serviceModule: string, ctx: EmitterContext): string {
  const ns = nsPascal(ctx);
  // Wrappers always carry a params map; plain methods only when the operation
  // has a body, query params, pagination, or injected values.
  const args = ['client', ...op.callArgs];
  if (!op.wrapper && methodTakesParams(op.resolved)) args.push('%{}');
  args.push('[headers: [{"x-custom", "value"}], base_url: "https://override.example.com"]');

  const lines: string[] = [];
  lines.push(`  test "${op.fname} honors per-request options", %{client: client} do`);
  lines.push(`    Req.Test.stub(${ns}.Client, fn conn ->`);
  lines.push('      assert Plug.Conn.get_req_header(conn, "x-custom") == ["value"]');
  lines.push('      assert conn.host == "override.example.com"');
  lines.push('      Plug.Conn.send_resp(conn, 204, "")');
  lines.push('    end)');
  lines.push('');
  lines.push(`    ${serviceModule}.${op.fname}(${args.join(', ')})`);
  lines.push('  end');
  return lines.join('\n');
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
