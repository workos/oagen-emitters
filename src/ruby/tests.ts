import type { ApiSpec, EmitterContext, GeneratedFile, Model, Operation, ResolvedWrapper, TypeRef } from '@workos/oagen';
import { assignModelsToServices } from '@workos/oagen';
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
  buildMountDirMap,
} from './naming.js';
import {
  buildResolvedLookup,
  scopedMountGroups,
  lookupResolved,
  buildHiddenParams,
  collectBodyFieldTypes,
  isModelInScope,
  isScopedRun,
  fileExistsAfterRun,
} from '../shared/resolved-ops.js';
import { type AggregateBlock, readPriorFile, reconcileScopedBlocks } from '../shared/scoped-aggregate-merge.js';
import { isListWrapperModel, isListMetadataModel } from '../shared/model-utils.js';
import { classifyUnassignedModel } from './models.js';
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
    const authMethodManifest: {
      method: string;
      httpMethodSym: string;
      stubUrl: string;
      callArgs: string;
    }[] = [];

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

  // Model round-trip tests: one file per service dir
  // (test/workos/test_<dir>_model_round_trip.rb), each covering only that dir's
  // models regenerated this run. A scoped run regenerates the selected
  // services' round-trip tests in lockstep with their models — fixing the
  // former wholesale file, which a scoped run skipped and thus left asserting a
  // selected model's OLD shape — and leaves untouched services' files alone.
  files.push(...generateModelRoundTripTests(spec, ctx));
  const legacyRoundTrip = retireLegacyRoundTripMonolith(ctx);
  if (legacyRoundTrip) files.push(legacyRoundTrip);

  return files;
}

const LEGACY_ROUNDTRIP_PATH = 'test/workos/test_model_round_trip.rb';

/**
 * Per-service model round-trip tests: one file per service dir
 * (`test/workos/test_<dir>_model_round_trip.rb`) that round-trips every
 * non-wrapper model in that dir through `.new(json)`/`.to_h`, asserting a Hash
 * result and that seeded keys survive.
 *
 * A dir's file is regenerated only when at least one of its models is IN SCOPE
 * (`isModelInScope`: everything on a full run, selected-only under
 * `--services`), so it moves in lockstep with that dir's regenerated per-model
 * `.rb` files. This replaces the former single wholesale file, which a scoped
 * run skipped entirely — leaving it asserting the OLD shape of a model the same
 * run had just regenerated. Dirs with no in-scope models are skipped, so
 * untouched services' files are left byte-for-byte alone (scoped runs never
 * prune).
 *
 * A regenerated dir covers in-scope ∪ on-disk models (`fileExistsAfterRun`) so
 * out-of-scope models keep their coverage, and every referenced
 * `WorkOS::<Class>` still has a file on disk for Zeitwerk to autoload. Their
 * METHODS are frozen to the prior on-disk text (`reconcileScopedBlocks`) rather
 * than re-rendered: the fixture is synthesized from the CURRENT spec, but an
 * out-of-scope model's `.rb` was not rewritten this run, so re-rendering asserts
 * a shape the stale model can't produce — a spec-added field lands in the
 * fixture and `to_h` never returns it. Freezing also keeps an unrelated
 * same-delta change to an out-of-scope model out of a scoped batch.
 */
function generateModelRoundTripTests(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const models = (spec.models as Model[]).filter((m) => !isListWrapperModel(m) && !isListMetadataModel(m));
  const enumNames = new Set(spec.enums.map((e) => e.name));
  const modelToService = assignModelsToServices(models, ctx.spec.services, ctx.modelHints);
  const mountDirMap = buildMountDirMap(ctx);
  const dirFor = (modelName: string): string => {
    const service = modelToService.get(modelName);
    if (!service) return classifyUnassignedModel(modelName);
    return mountDirMap.get(service) ?? classifyUnassignedModel(modelName);
  };

  // A dir's round-trip file is regenerated only when at least one of its models
  // is in scope (freshly emitted this run); on a full run that is every dir.
  // Dirs with no in-scope model are left untouched on disk, byte-for-byte.
  const activeDirs = new Set<string>();
  for (const model of models) {
    if (isModelInScope(model.name, ctx)) activeDirs.add(dirFor(model.name));
  }

  // Within a regenerated dir, cover EVERY model whose per-model file will exist
  // on disk after this run — in-scope (emitted now) OR out-of-scope but already
  // generated by a prior run (left untouched, never pruned). Emitting only the
  // in-scope subset here would silently DELETE the dir's out-of-scope models'
  // round-trip coverage even though their `.rb` files remain — the regression
  // this guards against. Mirrors the barrel-inclusion rule (`fileExistsAfterRun`),
  // so every referenced `WorkOS::<Class>` constant still has a file on disk for
  // Zeitwerk to autoload. Fixtures are built inline, so the model file is the
  // only on-disk dependency.
  const modelsByDir = new Map<string, Model[]>();
  for (const model of models) {
    const dir = dirFor(model.name);
    if (!activeDirs.has(dir)) continue;
    const modelFile = `lib/workos/${dir}/${fileName(model.name)}.rb`;
    if (!fileExistsAfterRun(modelFile, isModelInScope(model.name, ctx), ctx)) continue;
    if (!modelsByDir.has(dir)) modelsByDir.set(dir, []);
    modelsByDir.get(dir)!.push(model);
  }

  const files: GeneratedFile[] = [];
  for (const [dirName, dirModels] of [...modelsByDir].sort(([a], [b]) => a.localeCompare(b))) {
    const file = buildDirRoundTripFile(dirName, dirModels, enumNames, ctx);
    if (file) files.push(file);
  }
  return files;
}

/** Build one service dir's round-trip test file, or null when it has no models. */
function buildDirRoundTripFile(
  dirName: string,
  dirModels: Model[],
  enumNames: Set<string>,
  ctx: EmitterContext,
): GeneratedFile | null {
  // Each dir gets a distinct test-class name so two files never reopen the same
  // Minitest class (which would merge — and clash — their methods).
  const dirClass = dirName
    .split(/[_/]/)
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');

  const path = `test/workos/test_${dirName.replace(/\//g, '_')}_model_round_trip.rb`;
  const scoped = isScopedRun(ctx);

  const newBlocks: AggregateBlock[] = [];
  const emitted = new Set<string>();
  // Keys of every in-scope model this dir CONSIDERED, whether or not it goes on
  // to produce a block. A scoped run drops the prior block of an in-scope model
  // that produced none rather than carrying stale text over — its `.rb` WAS
  // regenerated, so the frozen fixture asserts a shape the fresh model can't
  // produce (see reconcileScopedBlocks).
  const inScopeKeys = new Set(dirModels.filter((m) => isModelInScope(m.name, ctx)).map((m) => fileName(m.name)));
  for (const model of dirModels) {
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

    const block: string[] = [];
    block.push(`  def test_${fileBase}_round_trip`);
    if (fixtureEntries.length === 0) {
      block.push(`    model = WorkOS::${className(model.name)}.new('{}')`);
      block.push('    json = model.to_h');
      block.push('    assert_kind_of Hash, json');
    } else {
      block.push('    fixture = {');
      for (const line of fixtureEntries) block.push(line);
      block.push('    }');
      block.push(`    model = WorkOS::${className(model.name)}.new(fixture.to_json)`);
      block.push('    json = model.to_h');
      block.push('    assert_kind_of Hash, json');
      for (const a of assertions) block.push(a);
      // T23: Assert every fixture key round-trips into to_h (handles both symbol and string keys).
      block.push(
        '    fixture.each_key { |k| assert json.key?(k.to_sym) || json.key?(k), "Expected to_h to include key #{k}" }',
      );
    }
    block.push('  end');

    newBlocks.push({
      key: fileBase,
      text: block.join('\n'),
      inScope: isModelInScope(model.name, ctx),
    });
  }

  // Freeze out-of-scope models' methods to their prior on-disk text. Their
  // `.rb` was NOT regenerated this run, so re-rendering their fixture from the
  // CURRENT spec would assert a shape the stale model can't produce (e.g. a
  // field the spec gained since the model was last written).
  let priorBlocks: AggregateBlock[] = [];
  if (scoped) {
    try {
      priorBlocks = parseRoundTripMethods(readPriorFile(path, ctx));
    } catch (err) {
      // The prior file exists but is unreadable. Emitting now would reconcile
      // against an empty prior and silently drop every out-of-scope method;
      // leave the on-disk copy untouched instead.
      console.warn(
        `[oagen] ruby: leaving ${path} untouched — could not read prior file: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }
  const methods = reconcileScopedBlocks(newBlocks, priorBlocks, scoped, inScopeKeys);
  if (methods.length === 0) return null;

  const lines: string[] = [];
  lines.push(`require 'test_helper'`);
  lines.push('');
  lines.push(`class ${dirClass}ModelRoundTripTest < Minitest::Test`);
  for (const method of methods) lines.push('', ...method.split('\n'));
  lines.push('end');

  return {
    path,
    content: lines.join('\n'),
    integrateTarget: true,
    overwriteExisting: true,
  };
}

/**
 * Parse a prior round-trip file's per-model `def test_<base>_round_trip` methods,
 * keyed by `<base>` (the model's snake_case file name), so a scoped run can
 * freeze out-of-scope methods verbatim. Each generated method runs from its
 * `  def ` line to the first `  end` at method indent — the emitted bodies are
 * flat (hash literal + assertions), so no inner 2-space `end` can appear.
 */
function parseRoundTripMethods(content: string | null): AggregateBlock[] {
  if (!content) return [];
  const lines = content.split('\n');
  const blocks: AggregateBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^ {2}def (test_(.+)_round_trip)$/);
    if (!m) continue;
    let end = i + 1;
    while (end < lines.length && lines[end] !== '  end') end++;
    if (end < lines.length) blocks.push({ key: m[2], text: lines.slice(i, end + 1).join('\n') });
    i = end;
  }
  return blocks;
}

/**
 * Retire the pre-split monolith (`test/workos/test_model_round_trip.rb`). A full
 * run stops emitting it (engine prunes it); a scoped run never prunes, so
 * overwrite the stale (now-failing) monolith with an inert placeholder while
 * it's still on disk (recorded in the prior manifest). Gating on the prior
 * manifest means it is NOT recreated once a full run has pruned it.
 */
function retireLegacyRoundTripMonolith(ctx: EmitterContext): GeneratedFile | null {
  if (!isScopedRun(ctx)) return null;
  if (!ctx.priorTargetManifestPaths?.has(LEGACY_ROUNDTRIP_PATH)) return null;
  return {
    path: LEGACY_ROUNDTRIP_PATH,
    content:
      '# Model round-trip tests moved to per-service ' +
      'test/workos/test_<service>_model_round_trip.rb files.\n' +
      '# This placeholder remains only until the next full generation prunes it.\n',
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
