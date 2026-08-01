import type {
  ApiSpec,
  EmitterContext,
  GeneratedFile,
  Model,
  Enum,
  TypeRef,
  ResolvedOperation,
  ResolvedWrapper,
} from '@workos/oagen';
import { planOperation } from '@workos/oagen';
import { scopedMountGroups, getOpDefaults, isModelInScope, isEnumInScope } from '../shared/resolved-ops.js';
import { resolveWrapperParams } from '../shared/wrapper-utils.js';
import { enrichModelsFromSpec, getSyntheticEnums } from '../shared/model-utils.js';
import { flattenDiscriminatedUnionFields } from '../shared/union-flatten.js';
import { parsePathTemplate } from '../shared/path-template.js';
import {
  typeName,
  accessorName,
  resourceTypeName,
  resolveMethodName,
  methodName,
  propertyName,
  subPackage,
  testSourcePath,
  ktStringLiteral,
  withResolvedOps,
} from './naming.js';
import {
  collectMethodParams,
  orderMethodParams,
  planAutoPaging,
  autoPagingMethodName,
  resolvePaginatedItemName,
} from './resources.js';
import type { RenderedParam } from './resources.js';
import { renderImportBlock } from './imports.js';
import { generateModelFixture } from './fixtures.js';

/**
 * Generate the spec-driven test suites:
 *
 * - One suite per mount group with one wire-level test per operation: each test
 *   calls the real generated method against a fixture response and asserts the
 *   HTTP method, the rendered path, the encoded body/query, and that the response
 *   decodes into the expected type.
 * - One multi-page auto-pagination test driving the generated `Flow` through two
 *   stubbed pages.
 *
 * The static test support (`testClient`, the `RecordedRequest` helpers) and the
 * transport behavior suite are hand-maintained in the SDK repo with
 * `@oagen-ignore-file`. Keeping the MockWebServer-specific details behind those
 * helpers means a MockWebServer API change is a one-file edit rather than a
 * regeneration of every suite. Live wire parity is covered separately by the
 * oagen smoke runner (`smoke/sdk-android.ts`).
 */
export function generateTests(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const rctx = withResolvedOps(ctx);
  const groups = [...scopedMountGroups(rctx).values()].sort((a, b) => a.name.localeCompare(b.name));

  // Fixtures must decode into the emitted data classes, so mirror the exact model
  // pipeline the model generator runs (enrich + union-flatten).
  const enriched = enrichModelsFromSpec(spec.models, spec.enums);
  const originalByName = new Map(spec.models.map((m) => [m.name, m]));
  const flatModels = flattenDiscriminatedUnionFields(
    enriched.map((m) => {
      if (m.discriminator && m.fields.length === 0) {
        const original = originalByName.get(m.name);
        if (original && original.fields.length > 0) return { ...m, fields: original.fields };
      }
      return m;
    }),
  );
  const modelMap = new Map(flatModels.map((m) => [m.name, m]));
  const enumMap = new Map([...spec.enums, ...getSyntheticEnums()].map((e) => [e.name, e]));

  const files: GeneratedFile[] = [];

  // Generate the multi-page auto-pagination test exactly once, on the first
  // paginated operation (deterministic: groups and ops are sorted).
  let autoPagingEmitted = false;

  for (const group of groups) {
    const gen = new SuiteGenerator(rctx, modelMap, enumMap);
    const suite = typeName(group.name);
    const accessor = accessorName(group.name);
    const resource = resourceTypeName(group.name, rctx);

    // No existence-only "resource is reachable" test: the runtime contract's §6
    // anti-patterns forbid asserting that a symbol exists. Reachability is proven
    // by the per-operation tests, which call through the accessor for real.
    const tests: string[] = [];

    const seen = new Set<string>();
    for (const resolved of [...group.resolvedOps].sort((a, b) => a.operation.path.localeCompare(b.operation.path))) {
      if (resolved.urlBuilder) {
        const method = resolveMethodName(resolved.operation, group.name, rctx);
        if (seen.has(method)) continue;
        seen.add(method);
        const test = gen.urlBuilderTest(resolved, accessor, method);
        if (test) tests.push('', test);
        continue;
      }
      if (resolved.wrappers && resolved.wrappers.length > 0) {
        for (const wrapper of resolved.wrappers) {
          const method = methodName(wrapper.name);
          if (seen.has(method)) continue;
          seen.add(method);
          const test = gen.wrapperTest(resolved, wrapper, accessor, method);
          if (test) tests.push('', test);
        }
        continue;
      }
      const method = resolveMethodName(resolved.operation, group.name, rctx);
      if (seen.has(method)) continue;
      seen.add(method);
      const test = gen.operationTest(resolved, accessor, method);
      if (test) tests.push('', test);
      if (!autoPagingEmitted) {
        const autoTest = gen.autoPagingTest(resolved, accessor, method);
        if (autoTest) {
          tests.push('', autoTest);
          autoPagingEmitted = true;
        }
      }
    }

    // §6 suite-level coverage: error paths, per-request options, query encoding,
    // and the empty-page case. Ordered ops so the chosen subject is deterministic.
    const sortedOps = [...group.resolvedOps].sort((a, b) => a.operation.path.localeCompare(b.operation.path));
    const emptyPage = gen.emptyPageTest(sortedOps, accessor, group.name);
    if (emptyPage) tests.push('', emptyPage);
    const queryEncoding = gen.queryEncodingTest(sortedOps, accessor, group.name);
    if (queryEncoding) tests.push('', queryEncoding);
    const requestOptions = gen.requestOptionsTest(sortedOps, accessor, group.name);
    if (requestOptions) tests.push('', requestOptions);
    for (const errTest of gen.errorPathTests(sortedOps, accessor, group.name)) {
      tests.push('', errTest);
    }

    // A mount group whose every operation is unsampleable would otherwise emit an
    // empty test class — noise that also reads as coverage. Skip the file instead.
    if (tests.length === 0) continue;

    const pkg = subPackage(rctx, '');
    const imports = new Set<string>([
      'kotlinx.coroutines.test.runTest',
      'org.junit.jupiter.api.Test',
      `${subPackage(rctx, 'support')}.testClient`,
      // Bounded request retrieval: an unbounded takeRequest() hangs until the CI
      // job times out when the SDK issues no request, instead of failing legibly.
      `${subPackage(rctx, 'support')}.awaitRequest`,
      ...gen.imports,
    ]);

    const lines: string[] = [];
    lines.push(`package ${pkg}`);
    lines.push('');
    lines.push(...renderImportBlock(imports, pkg));
    lines.push('');
    lines.push(`/**`);
    lines.push(` * Wire-level tests for the ${resource} resource: each test performs a real call`);
    lines.push(' * through the mocked transport and asserts the request that went out and the');
    lines.push(' * decoded response that came back.');
    lines.push(' */');
    lines.push(`class ${suite}Test {`);
    lines.push(tests.join('\n'));
    lines.push('}');
    files.push({ path: testSourcePath(rctx, '', `${suite}Test`), content: lines.join('\n') });
  }

  const roundTrip = generateModelRoundTripTests(flatModels, enumMap, rctx);
  if (roundTrip) files.push(roundTrip);

  const enumForwardCompat = generateEnumForwardCompatTests([...enumMap.values()], rctx);
  if (enumForwardCompat) files.push(enumForwardCompat);

  return files;
}

/**
 * Forward-compatible enum tests (§5: "unknown enum values should be preserved").
 *
 * The sealed-class-plus-`Unknown(value)` shape is this emitter's distinguishing
 * choice over `enum class`, and its whole point is that a value the API adds after
 * this SDK shipped survives a decode/encode cycle byte-for-byte instead of throwing
 * or collapsing to a sentinel. Nothing else in the suite exercises that: the
 * per-operation and model round-trip tests only ever feed values the spec already
 * knows, so a serializer that silently dropped the carrier would pass all of them.
 *
 * Each test asserts both directions, because either alone is insufficient:
 * decoding proves the unknown value is captured, re-encoding proves it is not lost.
 * A known value is checked in the same test so that an over-eager serializer
 * mapping *everything* to `Unknown` fails too.
 */
function generateEnumForwardCompatTests(enums: Enum[], ctx: EmitterContext): GeneratedFile | null {
  const cases: Array<{ type: string; known: string; isNumeric: boolean }> = [];
  for (const e of [...enums].sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.values.length === 0) continue;
    if (!isEnumInScope(e.name, ctx)) continue;
    // A numeric enum has no unrepresentable string, so the unknown carrier is
    // exercised with an out-of-range number instead.
    const isNumeric = e.values.every((v) => typeof v.value === 'number');
    cases.push({ type: typeName(e.name), known: String(e.values[0].value), isNumeric });
    // Proportionate: the shape is identical across all of them, so a sample proves
    // the generator, and the per-enum serializers are generated from one template.
    if (cases.length >= 30) break;
  }
  if (cases.length === 0) return null;

  const pkg = subPackage(ctx, '');
  const imports = new Set<string>([
    'kotlin.test.assertEquals',
    'kotlin.test.assertTrue',
    'kotlinx.serialization.json.Json',
    'org.junit.jupiter.api.Test',
  ]);
  // Explicit per-enum imports, not a wildcard: ktlint's no-wildcard-imports rule
  // rejects `enums.*` and cannot auto-correct it.
  for (const c of cases) imports.add(`${subPackage(ctx, 'enums')}.${c.type}`);

  const lines: string[] = [];
  lines.push(`package ${pkg}`);
  lines.push('');
  lines.push(...renderImportBlock(imports, pkg));
  lines.push('');
  lines.push('/**');
  lines.push(' * Forward-compatibility coverage for the generated enum serializers: a wire value');
  lines.push(' * this SDK does not know must decode into `Unknown` and re-encode unchanged, and a');
  lines.push(' * known value must still resolve to its own case.');
  lines.push(' */');
  lines.push('class EnumForwardCompatTest {');
  lines.push('    private val json = Json { ignoreUnknownKeys = true }');
  for (const c of cases) {
    const unknownWire = c.isNumeric ? '987654' : 'totally-new-value-from-the-api';
    const unknownJson = c.isNumeric ? '987654' : '"totally-new-value-from-the-api"';
    const unknownArg = c.isNumeric ? unknownWire : ktStringLiteral(unknownWire);
    const knownJson = c.isNumeric ? c.known : JSON.stringify(c.known);
    lines.push('');
    lines.push('    @Test');
    lines.push(`    fun \`${c.type} preserves an unknown wire value\`() {`);
    lines.push(`        val decoded = json.decodeFromString(${c.type}.serializer(), ${ktStringLiteral(unknownJson)})`);
    lines.push('');
    lines.push(`        assertEquals(${c.type}.Unknown(${unknownArg}), decoded)`);
    lines.push(
      `        assertEquals(${ktStringLiteral(unknownJson)}, json.encodeToString(${c.type}.serializer(), decoded))`,
    );
    lines.push('');
    lines.push('        // A known value must still resolve to its own case, not Unknown.');
    lines.push(`        val known = json.decodeFromString(${c.type}.serializer(), ${ktStringLiteral(knownJson)})`);
    lines.push(`        assertTrue(known !is ${c.type}.Unknown)`);
    lines.push(`        assertEquals(${ktLiteralForRaw(c.known, c.isNumeric)}, known.rawValue)`);
    lines.push('    }');
  }
  lines.push('}');
  return { path: testSourcePath(ctx, '', 'EnumForwardCompatTest'), content: lines.join('\n') };
}

/** Render an enum's raw value as the Kotlin literal its `rawValue` property returns. */
function ktLiteralForRaw(value: string, isNumeric: boolean): string {
  return isNumeric ? value : ktStringLiteral(value);
}

/**
 * Model round-trip tests (§6): encode a constructed model to JSON, decode it
 * back, and assert equality. This is what actually proves `@SerialName` wire
 * mappings and the forward-compatible enum serializers survive a round trip —
 * the per-operation tests only exercise the decode direction.
 *
 * Only models whose required fields are all sample-constructible are covered;
 * a model needing a heterogeneous union is skipped rather than faked.
 */
function generateModelRoundTripTests(
  models: Model[],
  enumMap: Map<string, Enum>,
  ctx: EmitterContext,
): GeneratedFile | null {
  const modelMap = new Map(models.map((m) => [m.name, m]));
  const gen = new SuiteGenerator(ctx, modelMap, enumMap);
  const pkg = subPackage(ctx, '');

  const cases: Array<{ type: string; expr: string }> = [];
  for (const model of [...models].sort((a, b) => a.name.localeCompare(b.name))) {
    if (model.fields.length === 0) continue;
    if (!isModelInScope(model.name, ctx)) continue;
    const built = gen.sampleModelExpression(model.name);
    if (!built) continue;
    cases.push({ type: typeName(model.name), expr: built.expr });
    // Keep the suite proportionate; the shapes repeat heavily across 500+ models.
    if (cases.length >= 40) break;
  }
  if (cases.length === 0) return null;

  const imports = new Set<string>([
    'kotlin.test.assertEquals',
    'kotlinx.serialization.json.Json',
    'org.junit.jupiter.api.Test',
    ...gen.imports,
  ]);

  const lines: string[] = [];
  lines.push(`package ${pkg}`);
  lines.push('');
  lines.push(...renderImportBlock(imports, pkg));
  lines.push('');
  lines.push('/**');
  lines.push(' * Serialization round-trip coverage: every model here is encoded, decoded, and');
  lines.push(' * compared for equality, so a wrong `@SerialName` or a lossy enum serializer');
  lines.push(' * fails here rather than silently corrupting a request body.');
  lines.push(' */');
  lines.push('class ModelRoundTripTest {');
  lines.push('    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }');
  for (const c of cases) {
    lines.push('');
    lines.push('    @Test');
    lines.push(`    fun \`${c.type} round-trips through JSON\`() {`);
    lines.push(`        val original = ${c.expr}`);
    lines.push('');
    lines.push(`        val encoded = json.encodeToString(${c.type}.serializer(), original)`);
    lines.push(`        val decoded = json.decodeFromString(${c.type}.serializer(), encoded)`);
    lines.push('');
    lines.push('        assertEquals(original, decoded)');
    lines.push('    }');
  }
  lines.push('}');
  return { path: testSourcePath(ctx, '', 'ModelRoundTripTest'), content: lines.join('\n') };
}

// --- per-operation test generation -------------------------------------------

interface SampleArg {
  /** Kotlin argument expression. */
  expr: string;
  /** For path params: the literal value interpolated into the URL path. */
  pathValue?: string;
  /** For query params: the expected serialized query value. */
  queryValue?: string;
  /** Imports the expression requires. */
  imports?: string[];
}

class SuiteGenerator {
  /** Imports accumulated across every test rendered by this generator. */
  readonly imports = new Set<string>();

  constructor(
    private ctx: EmitterContext,
    private modelMap: Map<string, Model>,
    private enumMap: Map<string, Enum>,
  ) {}

  /**
   * Import a hand-maintained test-support helper. `pathOnly`/`bodyJson`/`queryParam`
   * are EXTENSION functions on `RecordedRequest`, and Kotlin only resolves an
   * extension that is explicitly imported (or declared in the same package) — a
   * missing import here is a compile error in every generated suite, not a warning.
   */
  private supportImport(name: string): void {
    this.imports.add(`${subPackage(this.ctx, 'support')}.${name}`);
  }

  /**
   * Build a wire-level test for one operation, or null when a required parameter
   * cannot be sample-constructed (heterogeneous-union bodies etc.).
   */
  operationTest(resolved: ResolvedOperation, accessor: string, method: string): string | null {
    const op = resolved.operation;
    const params = collectMethodParams(resolved, this.ctx);
    const ordered = orderMethodParams(params);

    const args: string[] = [];
    const pathValues = new Map<string, string>();
    let firstBodyWire: string | null = null;
    let firstQuery: { wire: string; value: string } | null = null;
    for (const p of ordered) {
      if (p.optional) continue;
      const sample = this.sampleArg(p);
      if (!sample) return null;
      args.push(`${p.name} = ${sample.expr}`);
      if (p.kind === 'path' && sample.pathValue) pathValues.set(p.wire, sample.pathValue);
      if (p.kind === 'body' && firstBodyWire === null) firstBodyWire = p.wire;
      if (p.kind === 'query' && firstQuery === null && sample.queryValue) {
        firstQuery = { wire: p.wire, value: sample.queryValue };
      }
    }

    const expectedPath = this.expectedPath(op.path, pathValues);
    if (expectedPath === null) return null;
    const fixture = this.responseFixture(resolved);
    if (fixture === null) return null;

    this.imports.add('kotlin.test.assertEquals');

    const lines: string[] = [];
    lines.push('    @Test');
    if (op.deprecated) lines.push('    @Suppress("DEPRECATION")');
    lines.push(`    fun \`${testLabel(method)} sends expected request\`() =`);
    lines.push('        runTest {');
    lines.push(`            val (client, server) = testClient(responding = ${ktStringLiteral(fixture.json)})`);
    const call = `client.${accessor}.${method}(${args.join(', ')})`;
    if (fixture.binding) {
      lines.push(`            val result = ${call}`);
    } else {
      lines.push(`            ${call}`);
    }
    lines.push('');
    lines.push('            val request = server.awaitRequest()');
    lines.push(`            assertEquals(${ktStringLiteral(op.httpMethod.toUpperCase())}, request.method)`);
    this.supportImport('pathOnly');
    lines.push(`            assertEquals(${ktStringLiteral(expectedPath)}, request.pathOnly())`);
    if (firstBodyWire) {
      this.imports.add('kotlin.test.assertTrue');
      this.supportImport('bodyJson');
      lines.push(`            assertTrue(request.bodyJson().containsKey(${ktStringLiteral(firstBodyWire)}))`);
    }
    if (firstQuery) {
      this.supportImport('queryParam');
      lines.push(
        `            assertEquals(${ktStringLiteral(firstQuery.value)}, request.queryParam(${ktStringLiteral(firstQuery.wire)}))`,
      );
    }
    for (const assertion of fixture.assertions) {
      lines.push(`            ${assertion}`);
    }
    lines.push('        }');
    return lines.join('\n');
  }

  /**
   * Build a test for a URL-builder operation: call the non-suspend method and
   * assert the assembled URL's path and query (defaults, inferred, caller params).
   */
  urlBuilderTest(resolved: ResolvedOperation, accessor: string, method: string): string | null {
    const op = resolved.operation;
    const defaults = getOpDefaults(resolved);
    const params = collectMethodParams(resolved, this.ctx);
    const ordered = orderMethodParams(params);

    const args: string[] = [];
    const pathValues = new Map<string, string>();
    let queryAssert: { wire: string; value: string } | null = null;
    for (const p of ordered) {
      if (p.optional) continue;
      const sample = this.sampleArg(p);
      if (!sample) return null;
      args.push(`${p.name} = ${sample.expr}`);
      if (p.kind === 'path' && sample.pathValue) pathValues.set(p.wire, sample.pathValue);
      if (p.kind === 'query' && queryAssert === null && sample.queryValue) {
        queryAssert = { wire: p.wire, value: sample.queryValue };
      }
    }
    const expectedPath = this.expectedPath(op.path, pathValues);
    if (expectedPath === null) return null;

    this.imports.add('kotlin.test.assertEquals');
    this.imports.add('kotlin.test.assertTrue');

    const lines: string[] = [];
    lines.push('    @Test');
    if (op.deprecated) lines.push('    @Suppress("DEPRECATION")');
    lines.push(`    fun \`${testLabel(method)} builds expected url\`() {`);
    lines.push('        val (client, _) = testClient()');
    lines.push('');
    lines.push(`        val url = client.${accessor}.${method}(${args.join(', ')})`);
    lines.push('');
    lines.push(`        assertTrue(url.substringBefore('?').endsWith(${ktStringLiteral(expectedPath)}))`);
    for (const [key, value] of Object.entries(defaults)) {
      lines.push(`        assertTrue(url.contains(${ktStringLiteral(`${key}=${String(value)}`)}))`);
    }
    if (queryAssert) {
      lines.push(`        assertTrue(url.contains(${ktStringLiteral(`${queryAssert.wire}=`)}))`);
    }

    // A map-valued query param is the one shape whose encoding is easy to get
    // silently wrong: stringifying the map yields Kotlin's own `{k=v}` rendering
    // as a single opaque value, which the provider cannot read. Assert the
    // bracketed form explicitly, and assert the un-bracketed name is absent so a
    // regression to `toString()` fails rather than merely looking different.
    const mapQuery = params.find(
      (p) => p.kind === 'query' && (p.ref.kind === 'nullable' ? p.ref.inner : p.ref).kind === 'map',
    );
    if (mapQuery) {
      const call = [...args, `${mapQuery.name} = mapOf("k1" to "v1")`].join(', ');
      lines.push('');
      lines.push(`        val withMap = client.${accessor}.${method}(${call})`);
      // Query names go through URLEncoder, so the brackets arrive percent-encoded —
      // `name%5Bk1%5D=v1`. Assert those literal bytes, matching what workos-kotlin
      // puts on the wire. The negative assertion is the un-bracketed `name=`, which
      // is exactly what a regression to `toString()` would produce.
      lines.push(`        assertTrue(withMap.contains(${ktStringLiteral(`${mapQuery.wire}%5Bk1%5D=v1`)}))`);
      lines.push(`        assertTrue(!withMap.contains(${ktStringLiteral(`${mapQuery.wire}=`)}))`);
    }
    lines.push('    }');
    return lines.join('\n');
  }

  /**
   * Build a wire-level test for one union-split wrapper method: call it with
   * sample variant params and assert the request (including the discriminating
   * default, e.g. `grant_type`) and the decoded response.
   */
  wrapperTest(resolved: ResolvedOperation, wrapper: ResolvedWrapper, accessor: string, method: string): string | null {
    const op = resolved.operation;
    const wparams = resolveWrapperParams(wrapper, this.ctx);

    // Path params (rare for split ops) lead the signature, mirroring wrappers.ts.
    const args: string[] = [];
    const pathValues = new Map<string, string>();
    for (const p of op.pathParams) {
      const sample = this.sampleForRef(p.type, p.name, 'path');
      if (!sample?.pathValue) return null;
      args.push(`${propertyName(p.name)} = ${sample.expr}`);
      pathValues.set(p.name, sample.pathValue);
    }
    let firstBodyWire: string | null = null;
    for (const wp of wparams) {
      if (wp.isOptional) continue;
      const sample = wp.field
        ? this.sampleForRef(wp.field.type, wp.paramName, 'body')
        : { expr: ktStringLiteral(`test_${wp.paramName}`) };
      if (!sample) return null;
      args.push(`${propertyName(wp.paramName)} = ${sample.expr}`);
      if (firstBodyWire === null) firstBodyWire = wp.paramName;
    }
    const expectedPath = this.expectedPath(op.path, pathValues);
    if (expectedPath === null) return null;

    const model = wrapper.responseModelName ? this.modelMap.get(wrapper.responseModelName) : undefined;
    // A declared response type we cannot fixture would leave the result unused;
    // skip rather than emit a test that asserts nothing about the response.
    if (wrapper.responseModelName && !model) return null;
    const fixture = model ? generateModelFixture(model, this.modelMap, this.enumMap) : null;
    const json = fixture ? JSON.stringify(fixture) : '{}';

    this.imports.add('kotlin.test.assertEquals');

    const lines: string[] = [];
    lines.push('    @Test');
    lines.push(`    fun \`${testLabel(method)} sends expected request\`() =`);
    lines.push('        runTest {');
    lines.push(`            val (client, server) = testClient(responding = ${ktStringLiteral(json)})`);
    const call = `client.${accessor}.${method}(${args.join(', ')})`;
    if (model) {
      lines.push(`            val result = ${call}`);
    } else {
      lines.push(`            ${call}`);
    }
    lines.push('');
    lines.push('            val request = server.awaitRequest()');
    lines.push(`            assertEquals(${ktStringLiteral(op.httpMethod.toUpperCase())}, request.method)`);
    this.supportImport('pathOnly');
    lines.push(`            assertEquals(${ktStringLiteral(expectedPath)}, request.pathOnly())`);

    const defaultEntries = Object.entries(wrapper.defaults ?? {});
    if (defaultEntries.length > 0 || firstBodyWire !== null) {
      this.supportImport('bodyJson');
      lines.push('            val body = request.bodyJson()');
    }
    for (const [key, value] of defaultEntries) {
      if (typeof value === 'string') {
        this.imports.add('kotlinx.serialization.json.jsonPrimitive');
        lines.push(
          `            assertEquals(${ktStringLiteral(value)}, body[${ktStringLiteral(key)}]?.jsonPrimitive?.content)`,
        );
      } else {
        this.imports.add('kotlin.test.assertTrue');
        lines.push(`            assertTrue(body.containsKey(${ktStringLiteral(key)}))`);
      }
    }
    if (firstBodyWire) {
      this.imports.add('kotlin.test.assertTrue');
      lines.push(`            assertTrue(body.containsKey(${ktStringLiteral(firstBodyWire)}))`);
    }
    if (model && fixture) {
      for (const assertion of this.idAssertion(model, fixture, 'result')) {
        lines.push(`            ${assertion}`);
      }
    }
    lines.push('        }');
    return lines.join('\n');
  }

  /** A two-page auto-pagination test for the first eligible paginated op. */
  autoPagingTest(resolved: ResolvedOperation, accessor: string, method: string): string | null {
    const auto = planAutoPaging(resolved, this.ctx);
    if (!auto) return null;
    // Only all-optional signatures keep this test simple and deterministic.
    if (auto.params.some((p) => !p.optional)) return null;
    const itemName = planOperation(resolved.operation).paginatedItemModelName;
    if (!itemName) return null;
    const itemModel = this.modelMap.get(resolvePaginatedItemName(itemName, this.ctx));
    if (!itemModel || itemModel.fields.length === 0) return null;
    const item = generateModelFixture(itemModel, this.modelMap, this.enumMap);
    const itemJson = JSON.stringify(item);
    const page1 = `{"data":[${itemJson}],"list_metadata":{"before":null,"after":"cursor_2"}}`;
    const page2 = `{"data":[${itemJson}],"list_metadata":{"before":null,"after":null}}`;

    this.imports.add('kotlin.test.assertEquals');
    this.imports.add('kotlinx.coroutines.flow.toList');
    this.supportImport('testClientWithStubs');
    this.supportImport('queryParam');

    const autoName = autoPagingMethodName(method);
    const lines: string[] = [];
    lines.push('    @Test');
    lines.push(`    fun \`${testLabel(autoName)} fetches all pages\`() =`);
    lines.push('        runTest {');
    lines.push('            val (client, server) =');
    lines.push('                testClientWithStubs(');
    lines.push('                    listOf(');
    lines.push(`                        ${ktStringLiteral(page1)},`);
    lines.push(`                        ${ktStringLiteral(page2)},`);
    lines.push('                    ),');
    lines.push('                )');
    lines.push('');
    lines.push(`            val items = client.${accessor}.${autoName}().toList()`);
    lines.push('');
    lines.push('            assertEquals(2, items.size)');
    lines.push('            server.awaitRequest()');
    lines.push('            val second = server.awaitRequest()');
    lines.push(`            assertEquals("cursor_2", second.queryParam(${ktStringLiteral(auto.cursorWire)}))`);
    lines.push('        }');
    return lines.join('\n');
  }

  // --- §6 suite-level coverage ---------------------------------------------

  /**
   * The first operation in the suite that can be called with sample arguments —
   * used as the subject for the suite-level error-path, request-options, and
   * query-encoding tests. Deterministic: callers pass path-sorted ops.
   * URL builders are excluded (they issue no HTTP request).
   */
  private firstCallable(
    resolvedOps: ResolvedOperation[],
    mountName: string,
  ): { resolved: ResolvedOperation; method: string; args: string[] } | null {
    for (const resolved of resolvedOps) {
      if (resolved.urlBuilder) continue;
      if (resolved.wrappers && resolved.wrappers.length > 0) continue;
      const method = resolveMethodName(resolved.operation, mountName, this.ctx);
      const params = orderMethodParams(collectMethodParams(resolved, this.ctx));
      const args: string[] = [];
      let ok = true;
      for (const p of params) {
        if (p.optional) continue;
        const sample = this.sampleArg(p);
        if (!sample) {
          ok = false;
          break;
        }
        args.push(`${p.name} = ${sample.expr}`);
      }
      if (ok) return { resolved, method, args };
    }
    return null;
  }

  /**
   * Error-path tests (§6): one per status code in the spec's own
   * `ErrorPolicy.statusCodeMap`, plus the 5xx catch-all. Exception names are
   * derived from that map rather than hardcoded, so a policy change moves the
   * generated tests with it.
   */
  errorPathTests(resolvedOps: ResolvedOperation[], accessor: string, mountName: string): string[] {
    const target = this.firstCallable(resolvedOps, mountName);
    if (!target) return [];
    const policy = this.ctx.spec.sdk.errors;

    // 401/404/429/400/422 come from the map; 500 uses the server catch-all.
    const wanted: Array<{ status: number; kind: string; headers?: string }> = [];
    for (const status of [401, 404, 429, 400, 422]) {
      const kind = policy.statusCodeMap[status];
      if (!kind) continue;
      // A 429 must carry Retry-After so the runtime's backoff path is exercised.
      wanted.push({ status, kind, headers: status === 429 ? 'mapOf("Retry-After" to "0")' : undefined });
    }
    wanted.push({ status: 500, kind: policy.serverErrorKind });

    this.imports.add('kotlin.test.assertFailsWith');
    this.supportImport('testClientWithStatus');

    const out: string[] = [];
    for (const { status, kind, headers } of wanted) {
      const exc = `${kind}Exception`;
      const stub = headers
        ? `testClientWithStatus(${status}, ${ktStringLiteral(`{"message":"error"}`)}, ${headers})`
        : `testClientWithStatus(${status}, ${ktStringLiteral(`{"message":"error"}`)})`;
      const lines: string[] = [];
      lines.push('    @Test');
      lines.push(`    fun \`${testLabel(target.method)} throws ${exc} on ${status}\`() =`);
      lines.push('        runTest {');
      lines.push(`            val (client, _) = ${stub}`);
      lines.push('');
      lines.push(`            val error =`);
      lines.push(`                assertFailsWith<${exc}> {`);
      lines.push(`                    client.${accessor}.${target.method}(${target.args.join(', ')})`);
      lines.push('                }');
      lines.push('');
      lines.push(`            assertEquals(${status}, error.statusCode)`);
      lines.push('        }');
      out.push(lines.join('\n'));
    }
    this.imports.add('kotlin.test.assertEquals');
    return out;
  }

  /**
   * Per-request-options test (§6 / §7): proves the runtime actually HONORS an
   * option rather than merely accepting the type — asserts the extra header
   * reached the wire.
   */
  requestOptionsTest(resolvedOps: ResolvedOperation[], accessor: string, mountName: string): string | null {
    const target = this.firstCallable(resolvedOps, mountName);
    if (!target) return null;
    const fixture = this.responseFixture(target.resolved);
    if (fixture === null) return null;

    this.imports.add('kotlin.test.assertEquals');
    this.supportImport('headerValue');

    const args = [...target.args, 'requestOptions = RequestOptions(headers = mapOf("X-Custom" to "value"))'];
    const lines: string[] = [];
    lines.push('    @Test');
    lines.push('    fun `request options are honored on the wire`() =');
    lines.push('        runTest {');
    lines.push(`            val (client, server) = testClient(responding = ${ktStringLiteral(fixture.json)})`);
    lines.push('');
    lines.push(`            client.${accessor}.${target.method}(${args.join(', ')})`);
    lines.push('');
    lines.push('            val request = server.awaitRequest()');
    lines.push('            assertEquals("value", request.headerValue("X-Custom"))');
    lines.push('        }');
    return lines.join('\n');
  }

  /**
   * Query-encoding test (§6): drives an optional string query param with a value
   * containing a space and a slash, then asserts it survives encoding intact.
   */
  queryEncodingTest(resolvedOps: ResolvedOperation[], accessor: string, mountName: string): string | null {
    for (const resolved of resolvedOps) {
      if (resolved.urlBuilder) continue;
      if (resolved.wrappers && resolved.wrappers.length > 0) continue;
      const params = collectMethodParams(resolved, this.ctx);
      const target = params.find((p) => p.kind === 'query' && p.optional && p.type === 'String?');
      if (!target) continue;
      // Every non-target required param must still be constructible.
      const required = orderMethodParams(params).filter((p) => !p.optional);
      const args: string[] = [];
      let ok = true;
      for (const p of required) {
        const sample = this.sampleArg(p);
        if (!sample) {
          ok = false;
          break;
        }
        args.push(`${p.name} = ${sample.expr}`);
      }
      if (!ok) continue;

      const method = resolveMethodName(resolved.operation, mountName, this.ctx);
      const fixture = this.responseFixture(resolved);
      if (fixture === null) continue;
      const raw = 'a b/c&d=e';
      args.push(`${target.name} = ${ktStringLiteral(raw)}`);

      this.imports.add('kotlin.test.assertEquals');
      this.supportImport('queryParam');

      const lines: string[] = [];
      lines.push('    @Test');
      lines.push(`    fun \`${testLabel(method)} percent-encodes special characters in query params\`() =`);
      lines.push('        runTest {');
      lines.push(`            val (client, server) = testClient(responding = ${ktStringLiteral(fixture.json)})`);
      lines.push('');
      lines.push(`            client.${accessor}.${method}(${args.join(', ')})`);
      lines.push('');
      lines.push('            val request = server.awaitRequest()');
      lines.push(
        `            assertEquals(${ktStringLiteral(raw)}, request.queryParam(${ktStringLiteral(target.wire)}))`,
      );
      lines.push('        }');
      return lines.join('\n');
    }
    return null;
  }

  /** Empty-page test (§6): a paginated call against `{"data":[]}` must yield an empty page. */
  emptyPageTest(resolvedOps: ResolvedOperation[], accessor: string, mountName: string): string | null {
    for (const resolved of resolvedOps) {
      if (resolved.urlBuilder) continue;
      if (resolved.wrappers && resolved.wrappers.length > 0) continue;
      if (!planOperation(resolved.operation).isPaginated) continue;
      const params = orderMethodParams(collectMethodParams(resolved, this.ctx));
      const args: string[] = [];
      let ok = true;
      for (const p of params) {
        if (p.optional) continue;
        const sample = this.sampleArg(p);
        if (!sample) {
          ok = false;
          break;
        }
        args.push(`${p.name} = ${sample.expr}`);
      }
      if (!ok) continue;

      const method = resolveMethodName(resolved.operation, mountName, this.ctx);
      this.imports.add('kotlin.test.assertTrue');
      const empty = '{"data":[],"list_metadata":{"before":null,"after":null}}';
      const lines: string[] = [];
      lines.push('    @Test');
      lines.push(`    fun \`${testLabel(method)} returns an empty page\`() =`);
      lines.push('        runTest {');
      lines.push(`            val (client, _) = testClient(responding = ${ktStringLiteral(empty)})`);
      lines.push('');
      lines.push(`            val result = client.${accessor}.${method}(${args.join(', ')})`);
      lines.push('');
      lines.push('            assertTrue(result.data.isEmpty())');
      lines.push('        }');
      return lines.join('\n');
    }
    return null;
  }

  /** Render the expected URL path for a template with sample path values. */
  private expectedPath(template: string, pathValues: Map<string, string>): string | null {
    const segments = parsePathTemplate(template, { stripLeadingSlash: true });
    let path = '';
    for (const seg of segments) {
      if (seg.kind === 'literal') {
        path += seg.value;
      } else {
        const value = pathValues.get(seg.name);
        if (!value) return null; // hidden/unsampled path param
        path += value;
      }
    }
    return `/${path}`;
  }

  /**
   * Sample constructor expression for a model, or null when a required field
   * cannot be built. Accumulates the imports the expression needs.
   */
  sampleModelExpression(modelName: string): SampleArg | null {
    const sample = this.sampleForRef({ kind: 'model', name: modelName }, modelName, 'body');
    if (sample?.imports) for (const imp of sample.imports) this.imports.add(imp);
    return sample;
  }

  /** Sample Kotlin expression for a required parameter, or null if unsupported. */
  private sampleArg(p: RenderedParam): SampleArg | null {
    const sample = this.sampleForRef(p.ref, p.kind === 'bodyRaw' ? p.wire || 'body' : p.wire, p.kind);
    if (sample?.imports) for (const imp of sample.imports) this.imports.add(imp);
    return sample;
  }

  private sampleForRef(ref: TypeRef, wire: string, kind: RenderedParam['kind'], depth = 0): SampleArg | null {
    if (depth > 4) return null; // guard against recursive model graphs
    switch (ref.kind) {
      case 'nullable':
        return this.sampleForRef(ref.inner, wire, kind, depth);
      case 'primitive':
        switch (ref.type) {
          case 'string': {
            if (ref.format === 'date-time' || ref.format === 'date') {
              return {
                expr: 'Instant.parse("2023-01-01T00:00:00Z")',
                imports: ['kotlinx.datetime.Instant'],
              };
            }
            if (ref.format === 'byte' || ref.format === 'binary') {
              return { expr: '"test".toByteArray()' };
            }
            const value = kind === 'path' ? `sample-${wire.replace(/[^a-zA-Z0-9]+/g, '-')}` : `test_${wire}`;
            return { expr: ktStringLiteral(value), pathValue: value, queryValue: value };
          }
          case 'integer':
            return ref.format === 'int32'
              ? { expr: '1', pathValue: '1', queryValue: '1' }
              : { expr: '1L', pathValue: '1', queryValue: '1' };
          case 'number':
            return { expr: '1.5', queryValue: '1.5' };
          case 'boolean':
            return { expr: 'true', queryValue: 'true' };
          case 'unknown':
            return {
              expr: 'JsonPrimitive("test")',
              imports: ['kotlinx.serialization.json.JsonPrimitive'],
            };
          default:
            return null;
        }
      case 'literal':
        if (typeof ref.value === 'string') {
          return { expr: ktStringLiteral(ref.value), queryValue: ref.value };
        }
        if (typeof ref.value === 'number') {
          return Number.isInteger(ref.value)
            ? { expr: `${ref.value}L`, queryValue: String(ref.value) }
            : { expr: String(ref.value), queryValue: String(ref.value) };
        }
        if (typeof ref.value === 'boolean') {
          return { expr: String(ref.value), queryValue: String(ref.value) };
        }
        return null;
      case 'enum': {
        const e = this.enumMap.get(ref.name);
        const first = e?.values[0]?.value;
        if (first === undefined) return null;
        const literal = typeof first === 'string' ? ktStringLiteral(first) : String(first);
        const enumType = typeName(ref.name);
        return {
          expr: `${enumType}.fromRawValue(${literal})`,
          pathValue: String(first),
          queryValue: String(first),
          imports: [`${subPackage(this.ctx, 'enums')}.${enumType}`],
        };
      }
      case 'array': {
        const inner = this.sampleForRef(ref.items, wire, 'body', depth + 1);
        if (!inner) return null;
        return { expr: `listOf(${inner.expr})`, imports: inner.imports };
      }
      case 'map': {
        const inner = this.sampleForRef(ref.valueType, wire, 'body', depth + 1);
        if (!inner) return null;
        return { expr: `mapOf("key" to ${inner.expr})`, imports: inner.imports };
      }
      case 'model': {
        // Construct the generated data class via its primary constructor:
        // required fields only, using named arguments so the emitted
        // required-first ordering cannot break the call.
        const model = this.modelMap.get(ref.name);
        if (!model) return null;
        const modelType = typeName(model.name);
        const imports = [`${subPackage(this.ctx, 'models')}.${modelType}`];
        if (model.fields.length === 0) return { expr: `${modelType}()`, imports };
        const args: string[] = [];
        for (const f of model.fields) {
          if (!f.required) continue;
          const inner = this.sampleForRef(f.type, f.name, 'body', depth + 1);
          if (!inner) return null;
          if (inner.imports) imports.push(...inner.imports);
          args.push(`${propertyName(f.domainName ?? f.name)} = ${inner.expr}`);
        }
        return { expr: `${modelType}(${args.join(', ')})`, imports };
      }
      default:
        // union bodies need variant selection — skip those operations.
        return null;
    }
  }

  /** Fixture JSON + decode assertions for the operation's response. */
  private responseFixture(
    resolved: ResolvedOperation,
  ): { json: string; binding: boolean; assertions: string[] } | null {
    const op = resolved.operation;
    const plan = planOperation(op);
    if (plan.isPaginated && plan.paginatedItemModelName) {
      const itemModel = this.modelMap.get(resolvePaginatedItemName(plan.paginatedItemModelName, this.ctx));
      if (!itemModel || itemModel.fields.length === 0) return null;
      const item = generateModelFixture(itemModel, this.modelMap, this.enumMap);
      const json = `{"data":[${JSON.stringify(item)}],"list_metadata":{"before":null,"after":null}}`;
      const assertions = [
        'assertEquals(1, result.data.size)',
        ...this.idAssertion(itemModel, item, 'result.data.first()'),
      ];
      return { json, binding: true, assertions };
    }
    if (plan.isArrayResponse && plan.responseModelName) {
      const model = this.modelMap.get(plan.responseModelName);
      if (!model || model.fields.length === 0) return null;
      const item = generateModelFixture(model, this.modelMap, this.enumMap);
      return { json: `[${JSON.stringify(item)}]`, binding: true, assertions: ['assertEquals(1, result.size)'] };
    }
    if (plan.responseModelName) {
      const model = this.modelMap.get(plan.responseModelName);
      if (!model) return null;
      const fixture = generateModelFixture(model, this.modelMap, this.enumMap);
      if (model.fields.length === 0) {
        this.imports.add('kotlin.test.assertNotNull');
        return { json: JSON.stringify(fixture), binding: true, assertions: ['assertNotNull(result)'] };
      }
      return {
        json: JSON.stringify(fixture),
        binding: true,
        assertions: this.idAssertion(model, fixture, 'result'),
      };
    }
    return { json: '{}', binding: false, assertions: [] };
  }

  /** Assert the decoded `id` when the model has a plain required string id. */
  private idAssertion(model: Model, fixture: Record<string, unknown>, target: string): string[] {
    const idField = model.fields.find(
      (f) => f.name === 'id' && f.required && f.type.kind === 'primitive' && f.type.type === 'string' && !f.type.format,
    );
    const value = fixture['id'];
    if (!idField || typeof value !== 'string') {
      this.imports.add('kotlin.test.assertNotNull');
      return [`assertNotNull(${target})`];
    }
    return [`assertEquals(${ktStringLiteral(value)}, ${target}.id)`];
  }
}

/**
 * Convert a Kotlin method identifier into a human-readable, backtick-safe test
 * label. Back-ticks are stripped (a reserved-word method name would otherwise
 * close the test function's own back-tick literal) and camelCase is split.
 */
function testLabel(method: string): string {
  return method
    .split('`')
    .join('')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();
}
