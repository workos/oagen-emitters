import type { ApiSpec, EmitterContext, GeneratedFile, Model, Operation, ResolvedWrapper, TypeRef } from '@workos/oagen';
import { className, fileName, fieldName, safeParamName, servicePropertyName, resolveMethodName } from './naming.js';
import { buildResolvedLookup, groupByMount, lookupResolved, buildHiddenParams } from '../shared/resolved-ops.js';
import { isListWrapperModel, isListMetadataModel } from '../shared/model-utils.js';
import { resolveWrapperParams } from '../shared/wrapper-utils.js';

/**
 * Generate Ruby Minitest test files for each service and per-method.
 * Tests use WebMock to stub HTTP and fixtures from test/fixtures/*.fixture.json.
 *
 * For MVP, we produce:
 *  - test/test_helper.rb (if not present, via hand-maintained runtime)
 *  - test/workos/{service}_test.rb — per-service test class with basic assertions
 *  - test/fixtures/{op}.fixture.json — sample fixture for each operation
 */
export function generateTests(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  const groups = groupByMount(ctx);
  const modelByName = new Map<string, Model>();
  for (const m of spec.models as Model[]) modelByName.set(m.name, m);

  const lookup = buildResolvedLookup(ctx);

  for (const [mountTarget, group] of groups) {
    const cls = className(mountTarget);
    const prop = servicePropertyName(mountTarget);
    const file = fileName(mountTarget);

    const lines: string[] = [];
    lines.push(`require 'test_helper'`);
    lines.push('');
    lines.push(`class ${cls}Test < Minitest::Test`);
    lines.push('  include FixtureHelper');
    lines.push('');
    lines.push('  def setup');
    lines.push('    @client = WorkOS::Client.new(api_key: "sk_test_123")');
    lines.push('  end');

    const emittedTestMethods = new Set<string>();
    const authMethodManifest: { method: string; httpMethodSym: string; stubUrl: string; callArgs: string }[] = [];

    for (const op of group.operations) {
      const ownerService = group.resolvedOps.find((r) => r.operation === op)?.service;
      if (!ownerService) continue;
      const method = resolveMethodName(op, ownerService, ctx);
      // Skip url-builder ops: their generated wrappers are suppressed (handled
      // in resources.ts) and their hand-maintained replacements live inside
      // @oagen-ignore blocks with bespoke tests.
      if (lookupResolved(op, lookup)?.urlBuilder) continue;
      // Skip duplicate method names (two ops may resolve to the same name).
      if (emittedTestMethods.has(method)) continue;
      emittedTestMethods.add(method);
      lines.push('');

      // Build the exact stub URL with path params substituted.
      const stubUrl = buildStubUrl(op);

      const isList =
        (op.response.kind === 'model' &&
          modelByName.get(op.response.name) &&
          (isListWrapperModel(modelByName.get(op.response.name)!) || false)) ||
        // Also detect paginated endpoints whose IR response is typed as array
        (op.response.kind === 'array' && !!op.pagination);

      const _isDelete = op.httpMethod.toLowerCase() === 'delete';
      const httpMethodSym = `:${op.httpMethod.toLowerCase()}`;

      const resolved = lookupResolved(op, lookup);
      const hiddenParams = buildHiddenParams(resolved);
      const callArgs = buildCallArgsStub(op, modelByName, hiddenParams);

      // Collect method info for the parameterized 401 test (T20).
      authMethodManifest.push({ method, httpMethodSym, stubUrl, callArgs });

      const stubRegex = stubUrlRegex(stubUrl);
      lines.push(`  def test_${method}_returns_expected_result`);
      if (isList) {
        lines.push(`    stub_request(${httpMethodSym}, ${stubRegex})`);
        lines.push(`      .to_return(body: '{"data": [], "list_metadata": {}}', status: 200)`);
        lines.push(`    result = @client.${prop}.${method}(${callArgs})`);
        lines.push('    assert_kind_of WorkOS::Types::ListStruct, result');
      } else if (op.response.kind === 'primitive') {
        lines.push(`    stub_request(${httpMethodSym}, ${stubRegex})`);
        lines.push(`      .to_return(body: "{}", status: 200)`);
        lines.push(`    result = @client.${prop}.${method}(${callArgs})`);
        lines.push('    assert_nil result');
      } else {
        lines.push(`    stub_request(${httpMethodSym}, ${stubRegex})`);
        lines.push(`      .to_return(body: "{}", status: 200)`);
        lines.push(`    result = @client.${prop}.${method}(${callArgs})`);
        lines.push('    refute_nil result');
      }
      lines.push('  end');

      // Wrapper tests (union split variants).
      if (resolved?.wrappers && resolved.wrappers.length > 0) {
        for (const wrapper of resolved.wrappers) {
          emitWrapperTests({
            lines,
            wrapper,
            op,
            prop,
            stubUrl,
            httpMethodSym,
            ctx,
          });
        }
      }
    }

    // T20: parameterized 401 test — one define_method per endpoint.
    if (authMethodManifest.length > 0) {
      lines.push('');
      lines.push('  # Parameterized authentication error tests (one per endpoint).');
      lines.push('  [');
      for (const entry of authMethodManifest) {
        const argsLit = entry.callArgs ? `, args: { ${entry.callArgs} }` : '';
        lines.push(
          `    { name: :${entry.method}, verb: ${entry.httpMethodSym}, url: ${stubUrlRegex(entry.stubUrl)}${argsLit} },`,
        );
      }
      lines.push('  ].each do |spec|');
      lines.push(`    define_method("test_#{spec[:name]}_raises_authentication_error_on_401") do`);
      lines.push(`      stub_request(spec[:verb], spec[:url])`);
      lines.push(`        .to_return(body: '{"message": "Unauthorized"}', status: 401)`);
      lines.push(`      assert_raises(WorkOS::AuthenticationError) do`);
      lines.push(`        @client.${prop}.send(spec[:name], **(spec[:args] || {}))`);
      lines.push('      end');
      lines.push('    end');
      lines.push('  end');
    }

    lines.push('end');

    files.push({
      path: `test/workos/test_${file}.rb`,
      content: lines.join('\n'),
      integrateTarget: true,
      overwriteExisting: true,
    });
  }

  files.push(generateModelRoundTripTest(spec));

  return files;
}

/**
 * Emit test/workos/model_round_trip_test.rb that round-trips every non-wrapper
 * model through `.new(json)` and `.to_json`, asserting the result is a Hash and
 * that required fields appear with the seeded values.
 */
function generateModelRoundTripTest(spec: ApiSpec): GeneratedFile {
  const lines: string[] = [];
  lines.push(`require 'test_helper'`);
  lines.push('');
  lines.push('class ModelRoundTripTest < Minitest::Test');

  const models = (spec.models as Model[]).filter((m) => !isListWrapperModel(m) && !isListMetadataModel(m));
  const enumNames = new Set(spec.enums.map((e) => e.name));
  const emitted = new Set<string>();

  for (const model of models) {
    // Avoid duplicate test names when two IR model names collapse to the same
    // snake_case file name (we use the file name as the test suffix).
    const fileBase = fileName(model.name);
    if (emitted.has(fileBase)) continue;
    emitted.add(fileBase);

    // Build a fixture hash with string keys and stub values for every field.
    const fixtureEntries: string[] = [];
    const assertions: string[] = [];
    const dedupFields = new Set<string>();
    for (const f of model.fields) {
      const wireName = f.name;
      const rubyFieldName = fieldName(f.name);
      if (dedupFields.has(rubyFieldName)) continue;
      dedupFields.add(rubyFieldName);
      const stub = roundTripStub(f.type, enumNames);
      fixtureEntries.push(`    ${stringKeyLiteral(wireName)} => ${stub},`);
      // For primitive required fields we can assert the value round-trips.
      // The model's to_json uses `<wireName>:` shorthand (symbol keys) for
      // valid Ruby identifiers and `"wire#name" =>` (string keys) otherwise.
      // Note: the symbol key uses the original wire name, not the snake_cased
      // Ruby field name.
      void rubyFieldName;
      if (f.required && isPrimitiveLike(f.type)) {
        const accessorKey = /^[A-Za-z_][A-Za-z0-9_]*$/.test(wireName) ? `:${wireName}` : stringKeyLiteral(wireName);
        const actualExpr = `json[${accessorKey}]`;
        // Minitest 6 removed the `assert_equal nil, x` form — emit the
        // correct assertion based on the stub the emitter chose above.
        if (stub === 'nil') {
          assertions.push(`    assert_nil ${actualExpr}`);
        } else {
          assertions.push(`    assert_equal fixture[${stringKeyLiteral(wireName)}], ${actualExpr}`);
        }
      }
    }

    lines.push('');
    lines.push(`  def test_${fileBase}_round_trip`);
    if (fixtureEntries.length === 0) {
      lines.push(`    model = WorkOS::${className(model.name)}.new('{}')`);
      lines.push('    json = model.to_h');
      lines.push('    assert_kind_of Hash, json');
    } else {
      lines.push('    fixture = {');
      for (const line of fixtureEntries) lines.push(line);
      lines.push('    }');
      lines.push(`    model = WorkOS::${className(model.name)}.new(fixture.to_json)`);
      lines.push('    json = model.to_h');
      lines.push('    assert_kind_of Hash, json');
      for (const a of assertions) lines.push(a);
      // T23: Assert every fixture key round-trips into to_h (handles both symbol and string keys).
      lines.push(
        '    fixture.each_key { |k| assert json.key?(k.to_sym) || json.key?(k), "Expected to_h to include key #{k}" }',
      );
    }
    lines.push('  end');
  }

  lines.push('end');

  return {
    path: 'test/workos/test_model_round_trip.rb',
    content: lines.join('\n'),
    integrateTarget: true,
    overwriteExisting: true,
  };
}

/** Produce a Ruby string literal for a raw (possibly non-identifier) key. */
function stringKeyLiteral(name: string): string {
  return `"${name.replace(/"/g, '\\"')}"`;
}

function isPrimitiveLike(ref: TypeRef): boolean {
  if (ref.kind === 'primitive') return true;
  if (ref.kind === 'nullable') return isPrimitiveLike(ref.inner);
  return false;
}

/** Produce a Ruby literal value for seeding a model fixture. */
function roundTripStub(ref: TypeRef, enumNames: Set<string>): string {
  switch (ref.kind) {
    case 'primitive':
      switch (ref.type) {
        case 'string':
          return `"stub"`;
        case 'integer':
          return `1`;
        case 'number':
          return `1.0`;
        case 'boolean':
          return `true`;
        default:
          return `nil`;
      }
    case 'array':
      return `[]`;
    case 'map':
      return `{}`;
    case 'enum':
      return enumNames.has(ref.name) ? `"stub"` : `"stub"`;
    case 'literal':
      if (typeof ref.value === 'string') return `"${ref.value}"`;
      if (ref.value === null) return `nil`;
      return String(ref.value);
    case 'nullable':
      return `nil`;
    case 'model':
      return `{}`;
    case 'union':
      return ref.variants.length > 0 ? roundTripStub(ref.variants[0], enumNames) : `nil`;
    default:
      return `nil`;
  }
}

/** Build minimal placeholder arguments for calling the SDK method from a test. */
function buildCallArgsStub(op: Operation, modelByName: Map<string, Model>, hiddenParams: Set<string>): string {
  const parts: string[] = [];
  const seen = new Set<string>();

  // Path params (required).
  const pathParamNames = new Set<string>();
  for (const p of op.pathParams ?? []) {
    const name = safeParamName(p.name);
    pathParamNames.add(name);
    if (seen.has(name)) continue;
    seen.add(name);
    parts.push(`${name}: ${stubValueFor(p.type)}`);
  }

  // Required body fields — expand from model if present.
  // Apply path/body collision rename (body_ prefix) matching resources.ts.
  const body = op.requestBody;
  if (body) {
    const bodyModel = resolveBodyModel(body, modelByName);
    if (bodyModel) {
      for (const f of bodyModel.fields) {
        if (!f.required) continue;
        if (hiddenParams.has(f.name)) continue;
        let name = fieldName(f.name);
        if (pathParamNames.has(name)) {
          name = `body_${name}`;
        }
        if (seen.has(name)) continue;
        seen.add(name);
        parts.push(`${name}: ${stubValueFor(f.type)}`);
      }
    }
  }

  // Required query params.
  for (const q of op.queryParams ?? []) {
    if (!q.required) continue;
    if (hiddenParams.has(q.name)) continue;
    const name = safeParamName(q.name);
    if (seen.has(name)) continue;
    seen.add(name);
    parts.push(`${name}: ${stubValueFor(q.type)}`);
  }

  // Required parameter group kwargs.
  for (const group of op.parameterGroups ?? []) {
    if (group.optional) continue;
    const name = fieldName(group.name);
    if (seen.has(name)) continue;
    seen.add(name);
    // Stub as a hash with the first variant's type discriminant.
    const firstVariant = group.variants[0];
    if (firstVariant) {
      parts.push(`${name}: { type: "${firstVariant.name}" }`);
    } else {
      parts.push(`${name}: {}`);
    }
  }

  return parts.join(', ');
}

function resolveBodyModel(ref: TypeRef, modelByName: Map<string, Model>): Model | null {
  if (ref.kind === 'model') return modelByName.get(ref.name) ?? null;
  if (ref.kind === 'nullable') return resolveBodyModel(ref.inner, modelByName);
  if (ref.kind === 'union') {
    for (const v of ref.variants) {
      if (v.kind === 'model') return modelByName.get(v.name) ?? null;
    }
  }
  return null;
}

function emitWrapperTests(args: {
  lines: string[];
  wrapper: ResolvedWrapper;
  op: Operation;
  prop: string;
  stubUrl: string;
  httpMethodSym: string;
  ctx: EmitterContext;
}): void {
  const { lines, wrapper, op, prop, stubUrl, httpMethodSym, ctx } = args;
  const wrapperParams = resolveWrapperParams(wrapper, ctx);

  // Build call args: path params + required exposed params only.
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const p of op.pathParams ?? []) {
    const n = safeParamName(p.name);
    if (seen.has(n)) continue;
    seen.add(n);
    parts.push(`${n}: ${stubValueFor(p.type)}`);
  }
  for (const wp of wrapperParams) {
    if (wp.isOptional) continue;
    const n = fieldName(wp.paramName);
    if (seen.has(n)) continue;
    seen.add(n);
    parts.push(`${n}: ${wp.field ? stubValueFor(wp.field.type) : '"stub"'}`);
  }
  const callArgs = parts.join(', ');

  const wrapperRegex = stubUrlRegex(stubUrl);
  lines.push('');
  lines.push(`  def test_${wrapper.name}_returns_expected_result`);
  lines.push(`    stub_request(${httpMethodSym}, ${wrapperRegex})`);
  lines.push(`      .to_return(body: "{}", status: 200)`);
  lines.push(`    result = @client.${prop}.${wrapper.name}(${callArgs})`);
  lines.push('    refute_nil result');
  lines.push('  end');

  lines.push('');
  lines.push(`  def test_${wrapper.name}_raises_authentication_error_on_401`);
  lines.push(`    stub_request(${httpMethodSym}, ${wrapperRegex})`);
  lines.push(`      .to_return(body: '{"message": "Unauthorized"}', status: 401)`);
  lines.push(`    assert_raises(WorkOS::AuthenticationError) do`);
  lines.push(`      @client.${prop}.${wrapper.name}(${callArgs})`);
  lines.push('    end');
  lines.push('  end');
}

function stubValueFor(ref: TypeRef): string {
  switch (ref.kind) {
    case 'primitive':
      switch (ref.type) {
        case 'string':
          return `"stub"`;
        case 'integer':
          return `1`;
        case 'number':
          return `1.0`;
        case 'boolean':
          return `true`;
        default:
          return `nil`;
      }
    case 'array':
      return `[]`;
    case 'map':
      return `{}`;
    case 'enum':
      return `"stub"`;
    case 'literal':
      if (typeof ref.value === 'string') return `"${ref.value}"`;
      if (ref.value === null) return `nil`;
      return String(ref.value);
    case 'nullable':
      return stubValueFor(ref.inner);
    case 'model':
      return `{}`;
    case 'union':
      return ref.variants.length > 0 ? stubValueFor(ref.variants[0]) : `nil`;
    default:
      return `nil`;
  }
}

/**
 * Build a WebMock-compatible regex string that matches the exact API path
 * (with stub path params) plus an optional query string.
 *
 * Returns a Ruby Regexp literal like: %r{\Ahttps://api\.workos\.com/organizations(\?|\z)}
 */
function buildStubUrl(op: Operation): string {
  let path = op.path;
  for (const p of op.pathParams ?? []) {
    path = path.replace(`{${p.name}}`, 'stub');
  }
  // Escape regex special chars in the URL path (dots, slashes, etc.)
  const escaped = `https://api.workos.com${path}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escaped;
}

/** Format the stub URL as a Ruby regex literal for WebMock. */
function stubUrlRegex(escaped: string): string {
  return `%r{\\A${escaped}(\\?|\\z)}`;
}
