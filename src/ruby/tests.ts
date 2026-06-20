import type { ApiSpec, EmitterContext, GeneratedFile, Model, Operation, ResolvedWrapper, TypeRef } from '@workos/oagen';
import {
  className,
  fileName,
  fieldName,
  domainFieldName,
  safeParamName,
  scopedGroupVariantClassName,
  servicePropertyName,
  resolveMethodName,
  buildExportedClassNameSet,
  resolveServiceTarget,
} from './naming.js';
import {
  buildResolvedLookup,
  scopedMountGroups,
  lookupResolved,
  buildHiddenParams,
  collectBodyFieldTypes,
} from '../shared/resolved-ops.js';
import { isListWrapperModel, isListMetadataModel } from '../shared/model-utils.js';
import { resolveWrapperParams } from '../shared/wrapper-utils.js';
import { buildGroupOwnerMap, pickVariantParamType } from './parameter-groups.js';

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

  const groups = scopedMountGroups(ctx);
  const models = spec.models as Model[];
  const modelByName = new Map<string, Model>();
  for (const m of models) modelByName.set(m.name, m);

  const lookup = buildResolvedLookup(ctx);
  const groupOwners = buildGroupOwnerMap(ctx);
  const exportedClasses = buildExportedClassNameSet(ctx);

  for (const [mountTarget, group] of groups) {
    const resolvedTarget = resolveServiceTarget(mountTarget, exportedClasses);
    const cls = className(resolvedTarget);
    const prop = servicePropertyName(mountTarget);
    const file = fileName(resolvedTarget);

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
      const callArgs = buildCallArgsStub(op, modelByName, hiddenParams, groupOwners, models, exportedClasses);
      const bodyMatcher = buildBodyMatcher(op, modelByName, hiddenParams, models);

      // Collect method info for the parameterized 401 test (T20).
      authMethodManifest.push({ method, httpMethodSym, stubUrl, callArgs });

      const stubRegex = stubUrlRegex(stubUrl);
      lines.push(`  def test_${method}_returns_expected_result`);
      lines.push(`    stub_request(${httpMethodSym}, ${stubRegex})`);
      if (bodyMatcher) lines.push(`      .with(body: ${bodyMatcher})`);
      if (isList) {
        lines.push(`      .to_return(body: '{"data": [], "list_metadata": {}}', status: 200)`);
        lines.push(`    result = @client.${prop}.${method}(${callArgs})`);
        lines.push('    assert_kind_of WorkOS::Types::ListStruct, result');
      } else if (op.response.kind === 'primitive') {
        lines.push(`      .to_return(body: "{}", status: 200)`);
        lines.push(`    result = @client.${prop}.${method}(${callArgs})`);
        lines.push('    assert_nil result');
      } else {
        lines.push(`      .to_return(body: "{}", status: 200)`);
        lines.push(`    result = @client.${prop}.${method}(${callArgs})`);
        lines.push('    refute_nil result');
      }
      lines.push('  end');

      // Per-variant tests: for every parameter group with more than one
      // variant, emit one extra test per non-first variant so the second/third
      // arm of the dispatcher gets exercised. Without this, a wrong wire-name
      // mapping in (e.g.) ResourceTargetByExternalId would slip through.
      for (const group of op.parameterGroups ?? []) {
        for (let vi = 1; vi < group.variants.length; vi++) {
          const variant = group.variants[vi];
          const overrides = new Map<string, number>([[group.name, vi]]);
          const variantCallArgs = buildCallArgsStub(
            op,
            modelByName,
            hiddenParams,
            groupOwners,
            models,
            exportedClasses,
            overrides,
          );
          const variantBodyMatcher = buildBodyMatcher(op, modelByName, hiddenParams, models, overrides);
          const suffix = `with_${fieldName(group.name)}_${fieldName(variant.name)}`;
          lines.push('');
          lines.push(`  def test_${method}_${suffix}_returns_expected_result`);
          lines.push(`    stub_request(${httpMethodSym}, ${stubRegex})`);
          if (variantBodyMatcher) lines.push(`      .with(body: ${variantBodyMatcher})`);
          if (isList) {
            lines.push(`      .to_return(body: '{"data": [], "list_metadata": {}}', status: 200)`);
            lines.push(`    result = @client.${prop}.${method}(${variantCallArgs})`);
            lines.push('    assert_kind_of WorkOS::Types::ListStruct, result');
          } else if (op.response.kind === 'primitive') {
            lines.push(`      .to_return(body: "{}", status: 200)`);
            lines.push(`    result = @client.${prop}.${method}(${variantCallArgs})`);
            lines.push('    assert_nil result');
          } else {
            lines.push(`      .to_return(body: "{}", status: 200)`);
            lines.push(`    result = @client.${prop}.${method}(${variantCallArgs})`);
            lines.push('    refute_nil result');
          }
          lines.push('  end');
        }
      }

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
      // Dedup on the DOMAIN accessor name to mirror the model's field dedup
      // (models.ts). The fixture/assertion keys below still use the WIRE name.
      const rubyFieldName = domainFieldName(f);
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

/** Build minimal placeholder arguments for calling the SDK method from a test.
 *  `variantOverrides` selects a non-zero variant index per group; absent groups
 *  default to variant 0. Used to emit per-variant test cases that exercise the
 *  second/third arm of each parameter-group dispatcher.
 */
function buildCallArgsStub(
  op: Operation,
  modelByName: Map<string, Model>,
  hiddenParams: Set<string>,
  groupOwners: Map<string, string>,
  models: Model[],
  exportedClasses: Set<string>,
  variantOverrides: Map<string, number> = new Map(),
): string {
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

  // Parameter group kwargs (required and optional): instantiate the first
  // variant's class. Optional groups are exercised too so the dispatcher
  // code path is covered — passing nothing would skip the body block and
  // hide silent-drop bugs (see workos/oagen-emitters#66).
  //
  // Variant param types are recovered from the body model: the IR's leaf type
  // is often a bare primitive (`role_slugs: string`) even when the body model
  // declares a richer shape (`Array<String>`). Stubbing without recovery would
  // pass `"stub"` to `RoleMultiple.new(role_slugs:)` while the class signature
  // declares `T::Array[String]` — the test passes locally but ships an invalid
  // wire body the API rejects.
  const bodyFieldTypes = collectBodyFieldTypes(op, models);
  for (const group of op.parameterGroups ?? []) {
    const name = fieldName(group.name);
    if (seen.has(name)) continue;
    seen.add(name);
    const idx = variantOverrides.get(group.name) ?? 0;
    const variant = group.variants[idx];
    if (variant) {
      const owner = groupOwners.get(group.name);
      if (!owner) {
        throw new Error(`No owner mount target found for parameter group '${group.name}'`);
      }
      const variantClass = scopedGroupVariantClassName(
        resolveServiceTarget(owner, exportedClasses),
        group.name,
        variant.name,
      );
      const fieldStubs = variant.parameters
        .map((p) => `${fieldName(p.name)}: ${stubValueFor(pickVariantParamType(p.type, bodyFieldTypes.get(p.name)))}`)
        .join(', ');
      parts.push(`${name}: ${variantClass}.new(${fieldStubs})`);
    }
  }

  return parts.join(', ');
}

/**
 * Build a Ruby `hash_including(...)` matcher describing the wire body the
 * SDK should send for an operation whose body is constructed (in part) by a
 * parameter-group dispatcher. Returns `null` for operations without body
 * groups — those are still stubbed without a body matcher.
 *
 * The matcher includes every required non-group body field plus the first
 * variant's wire-name leaves for each group dispatched into the body. This
 * catches regressions where the dispatcher silently drops a passed group
 * (the original `update_organization_membership` regression).
 */
function buildBodyMatcher(
  op: Operation,
  modelByName: Map<string, Model>,
  hiddenParams: Set<string>,
  models: Model[],
  variantOverrides: Map<string, number> = new Map(),
): string | null {
  const httpMethod = op.httpMethod.toLowerCase();
  const hasBodyMethod = !['get', 'head', 'delete'].includes(httpMethod);
  const hasGroups = (op.parameterGroups?.length ?? 0) > 0;
  if (!hasBodyMethod || !hasGroups) return null;

  const groupedParamNames = new Set<string>();
  for (const group of op.parameterGroups ?? []) {
    for (const variant of group.variants) {
      for (const p of variant.parameters) groupedParamNames.add(p.name);
    }
  }

  const entries: string[] = [];

  // Required non-group body fields, keyed by wire name.
  if (op.requestBody) {
    const bodyModel = resolveBodyModel(op.requestBody, modelByName);
    if (bodyModel) {
      for (const f of bodyModel.fields) {
        if (!f.required) continue;
        if (hiddenParams.has(f.name)) continue;
        if (groupedParamNames.has(f.name)) continue;
        entries.push(`"${f.name}" => ${stubValueFor(f.type)}`);
      }
    }
  }

  // Selected variant of each group: its leaves get pumped into the body. The
  // matcher value must use the recovered (body-model) type, not the IR leaf —
  // see buildCallArgsStub for the same reasoning. Without this, the matcher
  // shape diverges from what the SDK actually sends.
  const bodyFieldTypes = collectBodyFieldTypes(op, models);
  for (const group of op.parameterGroups ?? []) {
    const idx = variantOverrides.get(group.name) ?? 0;
    const variant = group.variants[idx];
    if (!variant) continue;
    for (const p of variant.parameters) {
      const recovered = pickVariantParamType(p.type, bodyFieldTypes.get(p.name));
      entries.push(`"${p.name}" => ${stubValueFor(recovered)}`);
    }
  }

  if (entries.length === 0) return null;
  return `hash_including(${entries.join(', ')})`;
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
      // Single-element array — exercises the wire shape under hash_including
      // matchers. An empty `[]` would match `"role_slugs": []` on the wire,
      // hiding regressions where the SDK serializes the wrong type.
      return `[${stubValueFor(ref.items)}]`;
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
