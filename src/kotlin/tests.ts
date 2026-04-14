import type {
  ApiSpec,
  EmitterContext,
  GeneratedFile,
  Operation,
  Service,
  Model,
  TypeRef,
  ResolvedOperation,
  ResolvedWrapper,
} from '@workos/oagen';
import { planOperation } from '@workos/oagen';
import { apiClassName, packageSegment, resolveMethodName, ktStringLiteral, className, propertyName } from './naming.js';
import { mapTypeRef } from './type-map.js';
import { groupByMount, lookupResolved, buildResolvedLookup, buildHiddenParams } from '../shared/resolved-ops.js';
import { isListWrapperModel, isListMetadataModel } from '../shared/model-utils.js';
import { resolveWrapperParams } from '../shared/wrapper-utils.js';
import { isHandwrittenOverride } from './overrides.js';

const TEST_PREFIX = 'src/test/kotlin/';

/**
 * Generate one JUnit 5 + WireMock test class per API mount group, plus a
 * cross-cutting model round-trip test.
 *
 * Per mount group the emitter produces:
 *  - A happy-path test for every operation whose required arguments can be
 *    synthesized (primitives, enums, arrays, maps). Deserializes a minimal
 *    JSON response and asserts a non-null result.
 *  - 401/404/429/500 error-mapping tests against one representative operation
 *    in the group.
 *
 * Operations with required arguments we can't synthesize (e.g. a required
 * model object in the request body) fall back to error-only coverage using
 * the representative operation.
 */
export function generateTests(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const mountGroups = groupByMount(ctx);
  const resolvedLookup = buildResolvedLookup(ctx);

  for (const [mountName, group] of mountGroups) {
    const content = generateServiceTestClass(mountName, group.operations, ctx, resolvedLookup);
    if (!content) continue;
    const pkg = packageSegment(mountName);
    files.push({
      path: `${TEST_PREFIX}com/workos/${pkg}/${apiClassName(mountName)}Test.kt`,
      content,
      overwriteExisting: true,
    });
  }

  const roundTripFile = generateModelRoundTripTest(spec);
  if (roundTripFile) files.push(roundTripFile);

  const forwardCompatFile = generateForwardCompatTest(spec);
  if (forwardCompatFile) files.push(forwardCompatFile);

  return files;
}

interface OpTest {
  method: string;
  httpMethod: string; // lowercase for WireMock
  pathForWireMock: string;
  callArgs: string;
  responseClass: string | null;
  minimalResponseBody: string;
  canEmitHappyPath: boolean;
  imports: Set<string>;
  /** Wire field names required in the request body — asserted via matchingJsonPath. */
  requiredBodyPaths: string[];
  /** `name=value` pairs required on the query string — asserted via matchingRegex. */
  requiredQueryAssertions: { name: string; valueRegex: string }[];
}

function generateServiceTestClass(
  mountName: string,
  operations: Operation[],
  ctx: EmitterContext,
  resolvedLookup: Map<string, ResolvedOperation>,
): string | null {
  const imports = new Set<string>();
  // Base JUnit/WireMock/exception imports — always present.
  imports.add('com.github.tomakehurst.wiremock.client.WireMock.urlPathMatching');
  imports.add('com.workos.common.exceptions.GenericServerException');
  imports.add('com.workos.common.exceptions.NotFoundException');
  imports.add('com.workos.common.exceptions.RateLimitException');
  imports.add('com.workos.common.exceptions.UnauthorizedException');
  imports.add('com.workos.test.TestBase');
  imports.add('org.junit.jupiter.api.Assertions.assertNotNull');
  imports.add('org.junit.jupiter.api.Assertions.assertThrows');
  imports.add('org.junit.jupiter.api.Test');

  const opTests: OpTest[] = [];

  for (const op of operations) {
    if (isHandwrittenOverride(op)) continue;
    const resolved = lookupResolved(op, resolvedLookup);
    const wrappers = resolved?.wrappers ?? [];
    if (wrappers.length > 0) {
      // Union-split operation — emit one test per wrapper.
      for (const wrapper of wrappers) {
        const test = buildWrapperTest(op, wrapper, ctx);
        if (test) opTests.push(test);
      }
      continue;
    }

    const test = buildOperationTest(op, resolved, ctx);
    if (test) opTests.push(test);
  }

  if (opTests.length === 0) return null;

  // Deduplicate by method name (split operations map to distinct methods;
  // non-wrapper operations already have unique names).
  const seen = new Set<string>();
  const uniqueTests = opTests.filter((t) => {
    if (seen.has(t.method)) return false;
    seen.add(t.method);
    return true;
  });

  // Pick a "representative" op for error-mapping tests. Prefer the first op
  // that has no path params (simplest URL to stub). Fall back to the first.
  const repOp = uniqueTests.find((t) => !t.pathForWireMock.includes('sample-arg')) ?? uniqueTests[0];

  // Only register per-op imports for tests that will actually emit a body.
  // Ops that can't synthesize a happy path don't contribute to the file, so
  // their imports (HTTP methods, payload types) would be unused.
  const httpMethodsUsed = new Set<string>();
  for (const t of uniqueTests) {
    if (!t.canEmitHappyPath) continue;
    t.imports.forEach((i) => imports.add(i));
    httpMethodsUsed.add(t.httpMethod);
  }
  // The representative op is used for error-mapping tests regardless of its
  // happy-path status, so its type imports are always needed.
  repOp.imports.forEach((i) => imports.add(i));
  httpMethodsUsed.add(repOp.httpMethod);

  // Register request-verification imports when any operation contributes
  // body/query assertions.
  const anyBody = uniqueTests.some((t) => t.canEmitHappyPath && t.requiredBodyPaths.length > 0);
  const anyQuery = uniqueTests.some((t) => t.canEmitHappyPath && t.requiredQueryAssertions.length > 0);
  if (anyBody || anyQuery) {
    for (const m of httpMethodsUsed) {
      imports.add(`com.github.tomakehurst.wiremock.client.WireMock.${m}RequestedFor`);
    }
  }
  if (anyBody) imports.add('com.github.tomakehurst.wiremock.client.WireMock.matchingJsonPath');
  if (anyQuery) imports.add('com.github.tomakehurst.wiremock.client.WireMock.matching');

  const pkg = packageSegment(mountName);
  const apiCls = apiClassName(mountName);

  // If any operation would emit a disabled placeholder test, preregister
  // the `Disabled` import before we serialize the header.
  if (uniqueTests.some((t) => !t.canEmitHappyPath)) {
    imports.add('org.junit.jupiter.api.Disabled');
  }

  const lines: string[] = [];
  lines.push(`package com.workos.${pkg}`);
  lines.push('');
  for (const imp of [...imports].sort()) {
    lines.push(`import ${imp}`);
  }
  lines.push('');
  lines.push(`class ${apiCls}Test : TestBase() {`);
  lines.push(`  private fun api() = ${apiCls}(createWorkOSClient())`);

  for (const t of uniqueTests) {
    if (t.canEmitHappyPath) {
      emitHappyPathTest(lines, t);
    } else {
      // Previously these were silently dropped.  Emitting a disabled test
      // keeps the method visible in test reports so contributors know there
      // is intentionally no synthesized coverage, rather than being surprised
      // that the method has zero tests.
      emitDisabledHappyPathTest(lines, t);
    }
  }

  emitErrorTest(lines, '401', 'UnauthorizedException', repOp);
  emitErrorTest(lines, '404', 'NotFoundException', repOp);
  emitErrorTest(lines, '429', 'RateLimitException', repOp);
  emitErrorTest(lines, '500', 'GenericServerException', repOp);

  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

function buildOperationTest(
  op: Operation,
  resolved: ResolvedOperation | undefined,
  ctx: EmitterContext,
): OpTest | null {
  const svc = findService(ctx, op);
  if (!svc) return null;
  const method = resolveMethodName(op, svc, ctx);
  const plan = planOperation(op);

  const hidden = buildHiddenParams(resolved);

  // Build call args in the order expected by the generated method signature:
  //   pathParams ++ requiredQuery ++ requiredBodyFields
  const imports = new Set<string>();
  const argParts: string[] = [];
  const requiredBodyPaths: string[] = [];
  const requiredQueryAssertions: { name: string; valueRegex: string }[] = [];

  for (const _pp of op.pathParams) argParts.push(ktStringLiteral('sample-arg'));

  const queryFields = op.queryParams.filter((p) => !hidden.has(p.name));
  const sortedQuery = [...queryFields].sort((a, b) => (a.required === b.required ? 0 : a.required ? -1 : 1));
  for (const qp of sortedQuery) {
    if (!qp.required) break;
    const val = synthValue(qp.type, ctx, imports);
    if (val === null) return null;
    argParts.push(val);
    // Best-effort wire assertion: for primitives/strings we know the synthesized
    // value so we can assert equality; otherwise just assert presence.
    const regex = queryValueRegexFor(qp.type);
    if (regex !== null) requiredQueryAssertions.push({ name: qp.name, valueRegex: regex });
  }

  const bodyModel = resolveBodyModel(op, ctx);
  if (bodyModel) {
    // Body fields always pass; colliding names are renamed (e.g. slug →
    // bodySlug) by the resources emitter, so every required body field still
    // needs a test argument here.
    const bodyFields = bodyModel.fields.filter((f) => !hidden.has(f.name));
    const sortedBody = [...bodyFields].sort((a, b) => (a.required === b.required ? 0 : a.required ? -1 : 1));
    for (const bf of sortedBody) {
      if (!bf.required) break;
      const val = synthValue(bf.type, ctx, imports);
      if (val === null) return null;
      argParts.push(val);
      // matchingJsonPath on an array/map body field fails on empty
      // synthesized collections because JsonPath returns an empty result
      // set.  Scalar fields always materialize with a concrete value, so
      // we only assert those paths.
      if (isScalarBodyField(bf.type)) requiredBodyPaths.push(bf.name);
    }
  }

  const plan2 = plan;
  const responseClass = plan2.isPaginated
    ? 'Page'
    : plan2.responseModelName
      ? className(plan2.responseModelName)
      : null;

  const minimalBody = buildResponseBody(plan2, ctx);

  const canEmitHappyPath = responseClass !== null && minimalBody !== null;

  return {
    method,
    httpMethod: op.httpMethod.toLowerCase(),
    pathForWireMock: op.path.replace(/\{[^}]+\}/g, 'sample-arg'),
    callArgs: argParts.join(', '),
    responseClass,
    minimalResponseBody: minimalBody ?? '{}',
    canEmitHappyPath,
    imports,
    requiredBodyPaths,
    requiredQueryAssertions,
  };
}

/** True if the synthesized body value serializes to a concrete JSON scalar. */
function isScalarBodyField(type: TypeRef): boolean {
  const inner = type.kind === 'nullable' ? type.inner : type;
  if (inner.kind === 'primitive') return inner.format !== 'binary';
  if (inner.kind === 'enum') return true;
  if (inner.kind === 'literal') return true;
  return false;
}

/**
 * When we can recognize the synthesized test value for a query param,
 * return a regex that matches the expected serialized form. Returns null
 * when the value is too complex to assert (e.g. arrays, models).
 */
function queryValueRegexFor(type: TypeRef): string | null {
  const inner = type.kind === 'nullable' ? type.inner : type;
  if (inner.kind === 'primitive') {
    if (inner.format === 'date-time') return null; // OffsetDateTime.now() — not reproducible
    switch (inner.type) {
      case 'string':
        return 'sample-arg';
      case 'integer':
        return '0';
      case 'number':
        return '0\\.0';
      case 'boolean':
        return 'false';
    }
    return null;
  }
  return null;
}

function buildResponseBody(plan: ReturnType<typeof planOperation>, ctx: EmitterContext): string | null {
  if (plan.isPaginated) {
    return `{"data": [], "list_metadata": {"before": null, "after": null}}`;
  }
  if (!plan.responseModelName) return null;
  const itemJson = synthJsonForModelName(plan.responseModelName, ctx, new Set());
  if (itemJson === null) return null;
  // For `type: array` responses, the Kotlin method returns `List<T>` and
  // Jackson expects a JSON array on the wire, not a single object.
  if (plan.isArrayResponse) return `[${itemJson}]`;
  return itemJson;
}

function buildWrapperTest(op: Operation, wrapper: ResolvedWrapper, ctx: EmitterContext): OpTest | null {
  const method = propertyName(wrapper.name);
  const imports = new Set<string>();
  const argParts: string[] = [];

  for (const _pp of op.pathParams) argParts.push(ktStringLiteral('sample-arg'));

  const resolved = resolveWrapperParams(wrapper, ctx);
  for (const rp of resolved) {
    if (rp.isOptional) continue;
    if (!rp.field) {
      argParts.push(ktStringLiteral('sample-arg'));
      continue;
    }
    const val = synthValue(rp.field.type, ctx, imports);
    if (val === null) return null;
    argParts.push(val);
  }

  const responseClass = wrapper.responseModelName ? className(wrapper.responseModelName) : null;
  const minimalBody = wrapper.responseModelName
    ? synthJsonForModelName(wrapper.responseModelName, ctx, new Set())
    : null;
  const canEmitHappyPath = responseClass !== null && minimalBody !== null;

  return {
    method,
    httpMethod: op.httpMethod.toLowerCase(),
    pathForWireMock: op.path.replace(/\{[^}]+\}/g, 'sample-arg'),
    callArgs: argParts.join(', '),
    responseClass,
    minimalResponseBody: minimalBody ?? '{}',
    canEmitHappyPath,
    imports,
    requiredBodyPaths: [],
    requiredQueryAssertions: [],
  };
}

/** Synthesize a Kotlin expression for a typed value. Returns null if we cannot. */
function synthValue(type: TypeRef, ctx: EmitterContext, imports: Set<string>): string | null {
  if (type.kind === 'nullable') {
    return 'null';
  }
  if (type.kind === 'primitive') {
    if (type.format === 'binary') return 'ByteArray(0)';
    if (type.format === 'date-time') {
      imports.add('java.time.OffsetDateTime');
      return 'OffsetDateTime.now()';
    }
    switch (type.type) {
      case 'string':
        return '"sample-arg"';
      case 'integer':
        if (type.format === 'int64') return '0L';
        return '0';
      case 'number':
        return '0.0';
      case 'boolean':
        return 'false';
    }
    return null;
  }
  if (type.kind === 'enum') {
    const cls = className(type.name);
    imports.add(`com.workos.types.${cls}`);
    // Skip `Unknown` (index 0) — serializing the Unknown sentinel throws
    // because it exists only for forward-compat deserialization. Pick the
    // first concrete variant instead.
    return `${cls}.values().first { it != ${cls}.Unknown }`;
  }
  if (type.kind === 'array') {
    // Empty list of the right item type. Kotlin's List<T> is invariant.
    const itemType = renderTypeForSynthesis(type.items, ctx, imports);
    if (itemType === null) return null;
    return `emptyList<${itemType}>()`;
  }
  if (type.kind === 'map') {
    const valueType = renderTypeForSynthesis(type.valueType, ctx, imports);
    if (valueType === null) return null;
    return `emptyMap<String, ${valueType}>()`;
  }
  if (type.kind === 'literal') {
    if (typeof type.value === 'string') return ktStringLiteral(type.value);
    if (typeof type.value === 'number') return String(type.value);
    if (typeof type.value === 'boolean') return String(type.value);
    return 'null';
  }
  // model / union — too complex to synthesize generically.
  return null;
}

/**
 * Render a Kotlin type string for use as a generic type parameter in a
 * synthesized empty collection. Registers any required imports (enums,
 * models). Returns null when the type can't be reduced to a concrete
 * Kotlin class.
 */
function renderTypeForSynthesis(type: TypeRef, ctx: EmitterContext, imports: Set<string>): string | null {
  if (type.kind === 'model') {
    const cls = className(type.name);
    imports.add(`com.workos.models.${cls}`);
    return cls;
  }
  if (type.kind === 'enum') {
    const cls = className(type.name);
    imports.add(`com.workos.types.${cls}`);
    return cls;
  }
  if (type.kind === 'union') {
    // Unions render as Any; an empty list is still valid.
    return 'Any';
  }
  // For everything else (primitives, arrays, maps, literals) the IR mapping
  // produces a self-contained Kotlin type expression.
  return mapTypeRef(type);
}

function resolveBodyModel(op: Operation, ctx: EmitterContext): Model | null {
  const body = op.requestBody;
  if (!body) return null;
  if (body.kind !== 'model') return null;
  return ctx.spec.models.find((m) => m.name === body.name) ?? null;
}

/**
 * Build a minimal JSON string whose required fields satisfy the model's
 * contract. Nested model references are resolved recursively. Returns null
 * if a required field has a type we can't synthesize (e.g. open union).
 */
function synthJsonForModelName(name: string, ctx: EmitterContext, visited: Set<string>): string | null {
  if (visited.has(name)) return null;
  visited.add(name);
  const model = ctx.spec.models.find((m) => m.name === name);
  if (!model) return null;

  const entries: string[] = [];
  for (const field of model.fields) {
    if (!field.required) continue;
    const val = synthJsonValue(field.type, ctx, visited);
    if (val === null) {
      visited.delete(name);
      return null;
    }
    entries.push(`${JSON.stringify(field.name)}: ${val}`);
  }
  visited.delete(name);
  return `{${entries.join(', ')}}`;
}

/** Produce a JSON literal (string) for a given IR TypeRef, or null. */
function synthJsonValue(type: TypeRef, ctx: EmitterContext, visited: Set<string>): string | null {
  if (type.kind === 'nullable') return 'null';
  if (type.kind === 'primitive') {
    if (type.format === 'binary') return '""';
    if (type.format === 'date-time') return '"2024-01-01T00:00:00Z"';
    if (type.format === 'date') return '"2024-01-01"';
    switch (type.type) {
      case 'string':
        return '"sample"';
      case 'integer':
      case 'number':
        return '0';
      case 'boolean':
        return 'false';
    }
    return null;
  }
  if (type.kind === 'enum') {
    const em = ctx.spec.enums.find((e) => e.name === type.name);
    if (em && em.values.length > 0) {
      return JSON.stringify(String(em.values[0].value));
    }
    return '"unknown"';
  }
  if (type.kind === 'array') return '[]';
  if (type.kind === 'map') return '{}';
  if (type.kind === 'literal') {
    if (typeof type.value === 'string') return JSON.stringify(type.value);
    if (typeof type.value === 'number') return String(type.value);
    if (typeof type.value === 'boolean') return String(type.value);
    return 'null';
  }
  if (type.kind === 'model') {
    return synthJsonForModelName(type.name, ctx, visited);
  }
  if (type.kind === 'union') {
    // Try to pick a synthesizable variant.
    for (const v of type.variants) {
      const syn = synthJsonValue(v, ctx, visited);
      if (syn !== null) return syn;
    }
    return null;
  }
  return null;
}

function emitHappyPathTest(lines: string[], t: OpTest): void {
  lines.push('');
  lines.push(`  @Test`);
  lines.push(`  fun \`${t.method} returns a typed response\`() {`);
  const bodyString = ktStringLiteral(t.minimalResponseBody);
  const stubLine = `    stubResponse(${ktStringLiteral(t.httpMethod.toUpperCase())}, ${ktStringLiteral(t.pathForWireMock)}, 200, ${bodyString})`;
  if (stubLine.length <= KTLINT_MAX_LINE_LENGTH) {
    lines.push(stubLine);
  } else {
    lines.push('    stubResponse(');
    lines.push(`      ${ktStringLiteral(t.httpMethod.toUpperCase())},`);
    lines.push(`      ${ktStringLiteral(t.pathForWireMock)},`);
    lines.push('      200,');
    emitStubResponseBody(lines, '      ', t.minimalResponseBody);
    lines.push('    )');
  }
  emitCall(lines, '    ', `val result = api().${t.method}`, t.callArgs);
  lines.push('    assertNotNull(result)');

  // Verify the outbound request shape.  Body fields and query assertions
  // live on the `OpTest` and are only emitted when we know the synthesized
  // arguments produce a deterministic wire representation.
  if (t.requiredBodyPaths.length > 0 || t.requiredQueryAssertions.length > 0) {
    lines.push('    wireMockRule.verify(');
    lines.push(`      ${t.httpMethod}RequestedFor(urlPathMatching(${ktStringLiteral(t.pathForWireMock)}))`);
    for (const path of t.requiredBodyPaths) {
      lines.push(`        .withRequestBody(matchingJsonPath(${ktStringLiteral(`$.${path}`)}))`);
    }
    for (const qa of t.requiredQueryAssertions) {
      lines.push(`        .withQueryParam(${ktStringLiteral(qa.name)}, matching(${ktStringLiteral(qa.valueRegex)}))`);
    }
    lines.push('    )');
  }
  lines.push('  }');
}

/**
 * Emit a `@Disabled` placeholder for operations whose happy-path arguments
 * could not be synthesized (for example, a required body union that the
 * test generator cannot construct).  The disabled test keeps the method in
 * the test report so CI surfaces the coverage gap.
 */
function emitDisabledHappyPathTest(lines: string[], t: OpTest): void {
  lines.push('');
  lines.push(`  @Test`);
  lines.push(`  @Disabled("generator: could not synthesize required arguments for ${t.method}")`);
  lines.push(`  fun \`${t.method} returns a typed response\`() {`);
  lines.push(`    // Intentionally empty: the generator could not synthesize required arguments.`);
  lines.push('  }');
}

function emitErrorTest(lines: string[], status: string, exceptionName: string, t: OpTest): void {
  lines.push('');
  lines.push(`  @Test`);
  lines.push(`  fun \`${t.method} translates ${status} to ${exceptionName}\`() {`);
  lines.push(
    `    stubResponse(${ktStringLiteral(t.httpMethod.toUpperCase())}, ${ktStringLiteral(t.pathForWireMock)}, ${status})`,
  );
  lines.push(`    assertThrows(${exceptionName}::class.java) {`);
  emitCall(lines, '      ', `api().${t.method}`, t.callArgs);
  lines.push('    }');
  lines.push('  }');
}

/**
 * Emit the body argument for a multi-line `stubResponse(...)` call. When the
 * encoded literal fits on one line it is emitted directly; otherwise it is
 * broken into string-plus-string chunks joined with `+`.
 */
function emitStubResponseBody(lines: string[], indent: string, body: string): void {
  const encoded = ktStringLiteral(body);
  if (`${indent}${encoded}`.length <= KTLINT_MAX_LINE_LENGTH) {
    lines.push(`${indent}${encoded}`);
    return;
  }
  const continuationIndent = indent.length + 2;
  const maxChunkLineLen = KTLINT_MAX_LINE_LENGTH - continuationIndent - 2;
  const chunks = splitEscapedStringLiteral(encoded, maxChunkLineLen);
  for (let i = 0; i < chunks.length; i++) {
    const suffix = i === chunks.length - 1 ? '' : ' +';
    const prefix = i === 0 ? '' : '  ';
    lines.push(`${indent}${prefix}${chunks[i]}${suffix}`);
  }
}

/**
 * Split a Kotlin string literal (including its wrapping quotes) into
 * smaller literals such that each one is <= [maxChunkLen] characters. Splits
 * preferentially after commas or spaces, and never inside a `\X` escape
 * sequence.
 */
function splitEscapedStringLiteral(literal: string, maxChunkLen: number): string[] {
  // Strip the outer wrapping quotes.
  const inner = literal.slice(1, -1);
  const chunks: string[] = [];
  // Reserve 2 chars for the wrapping quotes of each output chunk.
  const target = Math.max(20, maxChunkLen - 2);
  let i = 0;
  while (i < inner.length) {
    if (inner.length - i <= target) {
      chunks.push(`"${inner.slice(i)}"`);
      break;
    }
    // Prefer a split right after a comma or space within the window. The
    // window is `[i, i + target - 1]` so `safeEnd = j + 1 <= i + target`,
    // keeping the emitted chunk content <= `target` characters long.
    const windowEnd = i + target - 1;
    let safeEnd = -1;
    for (let j = windowEnd; j > i; j--) {
      const ch = inner[j];
      if ((ch === ',' || ch === ' ') && !endsWithOddBackslash(inner, i, j)) {
        safeEnd = j + 1;
        break;
      }
    }
    if (safeEnd === -1) {
      // No comma/space — back up over any trailing backslash pair.
      let end = i + target;
      while (end > i && endsWithOddBackslash(inner, i, end)) end--;
      safeEnd = end;
    }
    chunks.push(`"${inner.slice(i, safeEnd)}"`);
    i = safeEnd;
  }
  return chunks;
}

/** True if the number of trailing `\` chars in `inner[start..pos-1]` is odd. */
function endsWithOddBackslash(inner: string, start: number, pos: number): boolean {
  let count = 0;
  for (let k = pos - 1; k >= start && inner[k] === '\\'; k--) count++;
  return count % 2 === 1;
}

/**
 * Emit `<prefix>(<args>)` either on a single line or, if that would exceed
 * ktlint's 140-char limit, broken across multiple lines with one argument
 * per line. [indent] is the leading whitespace on the expression line.
 *
 * When splitting a `val name = call.expr(...)` form, the assignment's RHS is
 * moved to its own line (ktlint: "A multiline expression should start on a
 * new line").
 */
function emitCall(lines: string[], indent: string, prefix: string, args: string): void {
  const single = `${indent}${prefix}(${args})`;
  if (single.length <= KTLINT_MAX_LINE_LENGTH) {
    lines.push(single);
    return;
  }
  // If the prefix is an assignment (`val x = expr.call`), split the assignment
  // so the expression starts on its own line with an extra indent level.
  const assignMatch = /^((?:val|var) [^=]+=)\s*(.+)$/.exec(prefix);
  const exprPrefix = assignMatch ? assignMatch[2] : prefix;
  const exprIndent = assignMatch ? `${indent}  ` : indent;
  if (assignMatch) lines.push(`${indent}${assignMatch[1]}`);
  lines.push(`${exprIndent}${exprPrefix}(`);
  const argIndent = `${exprIndent}  `;
  const parts = splitTopLevelArgs(args);
  for (let i = 0; i < parts.length; i++) {
    const suffix = i === parts.length - 1 ? '' : ',';
    lines.push(`${argIndent}${parts[i]}${suffix}`);
  }
  lines.push(`${exprIndent})`);
}

const KTLINT_MAX_LINE_LENGTH = 140;

/** Split a call-argument string on top-level commas (ignoring nested parens/quotes). */
function splitTopLevelArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inString = false;
  let buf = '';
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (inString) {
      buf += ch;
      if (ch === '\\' && i + 1 < args.length) {
        buf += args[++i];
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      buf += ch;
      continue;
    }
    if (ch === '(' || ch === '<' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === '>' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      out.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function generateModelRoundTripTest(spec: ApiSpec): GeneratedFile | null {
  // Collect ALL round-trippable models: non-list-wrapper data classes whose
  // required fields are all primitive/nullable (so we can synthesize a JSON
  // literal without guessing nested model shapes).
  const targets = spec.models.filter(
    (m) =>
      !isListWrapperModel(m) &&
      !isListMetadataModel(m) &&
      m.fields.length > 0 &&
      m.fields.every((f) => f.required) &&
      m.fields.every((f) => f.type.kind === 'primitive' || f.type.kind === 'nullable'),
  );
  if (targets.length === 0) return null;

  const lines: string[] = [
    'package com.workos.models',
    '',
    'import com.workos.common.json.ObjectMapperFactory',
    'import org.junit.jupiter.api.Assertions.assertEquals',
    'import org.junit.jupiter.api.Test',
    '',
    'class GeneratedModelRoundTripTest {',
    '  private val mapper = ObjectMapperFactory.create()',
  ];

  for (const target of targets) {
    const cls = className(target.name);
    const jsonLiteral = buildTrivialJson(target);
    lines.push(
      '',
      '  @Test',
      `  fun \`${cls} round-trips through Jackson\`() {`,
      `    val json = ${ktStringLiteral(jsonLiteral)}`,
      `    val parsed = mapper.readValue(json, ${cls}::class.java)`,
      '    val reserialized = mapper.writeValueAsString(parsed)',
      '    val tree1 = mapper.readTree(json)',
      '    val tree2 = mapper.readTree(reserialized)',
      '    assertEquals(tree1, tree2)',
      '  }',
    );
  }

  lines.push('}', '');

  return {
    path: `${TEST_PREFIX}com/workos/models/GeneratedModelRoundTripTest.kt`,
    content: lines.join('\n'),
    overwriteExisting: true,
  };
}

/**
 * Emit a forward-compatibility suite that proves:
 *  - unrecognized enum wire values map to the `Unknown` sentinel rather
 *    than throwing (covers the Jackson @JsonEnumDefaultValue wiring);
 *  - unknown top-level JSON fields on a model do not fail deserialization
 *    (FAIL_ON_UNKNOWN_PROPERTIES=false);
 *  - ISO-8601 timestamps round-trip through `OffsetDateTime` without
 *    precision loss.
 *
 * The suite targets the first candidate enum in the spec (any enum with at
 * least one non-Unknown variant) and the first round-trippable model, so
 * one emitted test covers the pattern for all generated types.
 */
function generateForwardCompatTest(spec: ApiSpec): GeneratedFile | null {
  const enumTarget = spec.enums.find((e) => e.values.length > 0);
  const modelTarget = spec.models.find(
    (m) =>
      !isListWrapperModel(m) &&
      !isListMetadataModel(m) &&
      m.fields.length > 0 &&
      m.fields.every((f) => f.required) &&
      m.fields.every((f) => f.type.kind === 'primitive' || f.type.kind === 'nullable'),
  );
  if (!enumTarget && !modelTarget) return null;

  const lines: string[] = [
    'package com.workos.models',
    '',
    'import com.fasterxml.jackson.core.type.TypeReference',
    'import com.workos.common.json.ObjectMapperFactory',
  ];
  if (enumTarget) lines.push(`import com.workos.types.${className(enumTarget.name)}`);
  lines.push(
    'import org.junit.jupiter.api.Assertions.assertEquals',
    'import org.junit.jupiter.api.Assertions.assertNotNull',
    'import org.junit.jupiter.api.Test',
    '',
    'class GeneratedForwardCompatTest {',
    '  private val mapper = ObjectMapperFactory.create()',
  );

  if (enumTarget) {
    const enumCls = className(enumTarget.name);
    lines.push(
      '',
      `  @Test`,
      `  fun \`unknown ${enumCls} wire values deserialize to Unknown\`() {`,
      '    // Simulates a future server release that introduces a new enum variant.',
      `    val parsed = mapper.readValue(${ktStringLiteral('"__oagen_new_variant__"')}, ${enumCls}::class.java)`,
      `    assertEquals(${enumCls}.Unknown, parsed)`,
      '  }',
    );
  }

  if (modelTarget) {
    const modelCls = className(modelTarget.name);
    const jsonLiteral = buildTrivialJson(modelTarget);
    // Splice an extra unknown property into the JSON to prove the mapper
    // ignores it.  `buildTrivialJson` returns a single-line `{...}` literal
    // so a simple substring replacement is safe.
    const jsonWithExtra = jsonLiteral.replace('{', '{"__oagen_future_field__": "ignored", ');
    lines.push(
      '',
      `  @Test`,
      `  fun \`${modelCls} ignores unknown JSON fields\`() {`,
      `    val json = ${ktStringLiteral(jsonWithExtra)}`,
      `    val parsed = mapper.readValue(json, ${modelCls}::class.java)`,
      '    assertNotNull(parsed)',
      '  }',
    );
  }

  lines.push(
    '',
    '  @Test',
    '  fun `OffsetDateTime round-trips through the configured mapper`() {',
    '    val jsonIn = "\\"2024-01-15T12:34:56.789Z\\""',
    '    val parsed = mapper.readValue(jsonIn, object : TypeReference<java.time.OffsetDateTime>() {})',
    '    val reserialized = mapper.writeValueAsString(parsed)',
    '    // Jackson serializes OffsetDateTime as an ISO-8601 string when',
    '    // WRITE_DATES_AS_TIMESTAMPS is disabled. The wire form may choose a',
    '    // different offset representation (e.g. "+00:00" vs "Z") so compare',
    '    // logical equality of the parsed value rather than the raw string.',
    '    val reparsed = mapper.readValue(reserialized, object : TypeReference<java.time.OffsetDateTime>() {})',
    '    assertEquals(parsed.toInstant(), reparsed.toInstant())',
    '  }',
    '}',
    '',
  );

  return {
    path: `${TEST_PREFIX}com/workos/models/GeneratedForwardCompatTest.kt`,
    content: lines.join('\n'),
    overwriteExisting: true,
  };
}

function buildTrivialJson(model: Model): string {
  const entries: string[] = [];
  for (const field of model.fields) {
    const type = field.type;
    if (type.kind !== 'primitive') {
      entries.push(`${JSON.stringify(field.name)}: null`);
      continue;
    }
    switch (type.type) {
      case 'string':
        entries.push(`${JSON.stringify(field.name)}: "sample"`);
        break;
      case 'integer':
      case 'number':
        entries.push(`${JSON.stringify(field.name)}: 1`);
        break;
      case 'boolean':
        entries.push(`${JSON.stringify(field.name)}: true`);
        break;
      default:
        entries.push(`${JSON.stringify(field.name)}: null`);
    }
  }
  return `{${entries.join(', ')}}`;
}

function findService(ctx: EmitterContext, op: Operation): Service | undefined {
  for (const service of ctx.spec.services) {
    if (service.operations.includes(op)) return service;
  }
  return undefined;
}
