import type { ApiSpec, EmitterContext, GeneratedFile, TypeRef, ResolvedOperation } from '@workos/oagen';
import { planOperation } from '@workos/oagen';
import { moduleName, fileName, fullModuleName, functionName, varName, nsPascal } from './naming.js';
import { buildFixtureEntries, generateFixtureFiles, fixtureName } from './fixtures.js';
import { scopedMountGroups, type MountGroup } from '../shared/resolved-ops.js';
import { buildExportedClassNameSet, resolveServiceTarget } from '../shared/service-name-collision.js';
import { parsePathTemplate } from '../shared/path-template.js';

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
  return files;
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
}

function testableOps(group: MountGroup): TestableOp[] {
  const out: TestableOp[] = [];
  const seen = new Set<string>();
  for (const resolved of group.resolvedOps) {
    if ((resolved as { urlBuilder?: boolean }).urlBuilder) continue;
    const fname = functionName(resolved.methodName);
    if (seen.has(fname)) continue;
    seen.add(fname);
    const callArgs = parsePathTemplate(resolved.operation.path)
      .filter((s) => s.kind === 'param')
      .map((s) => `"test_${varName((s as { name: string }).name)}"`);
    out.push({ resolved, fname, callArgs });
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
  const ops = testableOps(group);
  if (ops.length === 0) return null;

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

  lines.push('');
  lines.push(renderErrorTest(ops[0], serviceModule, ctx));
  lines.push('end');
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
  const pattern = successPattern(op.resolved, ctx, modelNames);

  const lines: string[] = [];
  lines.push(`  test "${op.fname} succeeds", %{client: client} do`);
  if (hasFixture) {
    lines.push(`    Req.Test.stub(${ns}.Client, fn conn ->`);
    lines.push(`      Req.Test.json(conn, ${ns}.TestFixtures.fixture("${fixture}"))`);
    lines.push('    end)');
  } else {
    lines.push(`    Req.Test.stub(${ns}.Client, fn conn ->`);
    lines.push('      Plug.Conn.send_resp(conn, 204, "")');
    lines.push('    end)');
  }
  lines.push('');
  lines.push(`    assert ${pattern} = ${call}`);
  lines.push('  end');
  return lines.join('\n');
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
