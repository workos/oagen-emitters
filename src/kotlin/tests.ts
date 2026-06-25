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
import {
  resolveApiClassName,
  packageSegment,
  resolveMethodName,
  ktStringLiteral,
  className,
  propertyName,
  domainPropertyName,
  buildExportedClassNameSet,
} from './naming.js';
import { mapTypeRef } from './type-map.js';
import {
  scopedMountGroups,
  lookupResolved,
  buildResolvedLookup,
  buildHiddenParams,
  collectGroupedParamNames,
  isModelInScope,
  isEnumInScope,
  fileExistsAfterRun,
} from '../shared/resolved-ops.js';
import { isListWrapperModel, isListMetadataModel } from '../shared/model-utils.js';
import { resolveWrapperParams } from '../shared/wrapper-utils.js';
import { isHandwrittenOverride } from './overrides.js';

const TEST_PREFIX = 'src/test/kotlin/';

// Per-item FILE paths (target-root-relative, matching the prior manifest) the
// model/enum emitters write. The whole-suite test aggregates below reference
// these classes by name, so they may only list an item whose file will EXIST
// on disk after the run (in-scope ∪ prior manifest) — otherwise a scoped
// (`--services`) run references a `Class::class.java` whose `.kt` was never
// emitted. Must stay in sync with the paths in `models.ts` / `enums.ts`.
const MODELS_FILE_PREFIX = 'src/main/kotlin/com/workos/models/';
const ENUMS_FILE_PREFIX = 'src/main/kotlin/com/workos/types/';

function modelFilePath(modelName: string): string {
  return `${MODELS_FILE_PREFIX}${className(modelName)}.kt`;
}

function enumFilePath(enumName: string): string {
  return `${ENUMS_FILE_PREFIX}${className(enumName)}.kt`;
}

/**
 * Mirror the ISO-8601 hint promotion the resource/model emitters use so tests
 * synthesize values whose Kotlin type matches the generated method signature.
 * Kept in sync with the helpers in `resources.ts` / `models.ts`; if the
 * detection rule changes, update all three.
 */
const ISO_8601_DESCRIPTION_RE = /\bISO[-_ ]?8601\b/i;

function looksLikeIso8601String(description: string | undefined): boolean {
  if (!description) return false;
  return ISO_8601_DESCRIPTION_RE.test(description);
}

function promoteIso8601TypeRef(type: TypeRef, description: string | undefined): TypeRef {
  if (!looksLikeIso8601String(description)) return type;
  const promote = (t: TypeRef): TypeRef => {
    if (t.kind === 'primitive' && t.type === 'string' && !t.format) {
      return { kind: 'primitive', type: 'string', format: 'date-time' };
    }
    if (t.kind === 'nullable') return { kind: 'nullable', inner: promote(t.inner) };
    return t;
  };
  return promote(type);
}

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
  const mountGroups = scopedMountGroups(ctx);
  const resolvedLookup = buildResolvedLookup(ctx);

  const exportedClasses = buildExportedClassNameSet(ctx);
  for (const [mountName, group] of mountGroups) {
    const content = generateServiceTestClass(mountName, group.operations, ctx, resolvedLookup);
    if (!content) continue;
    const pkg = packageSegment(mountName);
    files.push({
      path: `${TEST_PREFIX}com/workos/${pkg}/${resolveApiClassName(mountName, exportedClasses)}Test.kt`,
      content,
      overwriteExisting: true,
    });
  }

  const roundTripFile = generateModelRoundTripTest(spec, ctx);
  if (roundTripFile) files.push(roundTripFile);

  const forwardCompatFile = generateForwardCompatTest(spec, ctx);
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
  /** Wire field names that must NOT appear as query params (e.g. password on POST). */
  forbiddenQueryParams: string[];
  /** Assertions on response fields: { kotlinAccessor, expectedExpr }. */
  responseAssertions: { accessor: string; expectedExpr: string }[];
}

function generateServiceTestClass(
  mountName: string,
  operations: Operation[],
  ctx: EmitterContext,
  resolvedLookup: Map<string, ResolvedOperation>,
): string | null {
  const imports = new Set<string>();
  // Base JUnit/exception imports — always present.
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

  // Register request-verification imports only for operations that actually
  // emit verify() calls (i.e., have body/query assertions). This avoids
  // unused `*RequestedFor` and `urlPathMatching` imports in test files where
  // no happy-path test has scalar required params.
  const verifyMethods = new Set<string>();
  for (const t of uniqueTests) {
    if (!t.canEmitHappyPath) continue;
    if (t.requiredBodyPaths.length > 0 || t.requiredQueryAssertions.length > 0 || t.forbiddenQueryParams.length > 0) {
      verifyMethods.add(t.httpMethod);
    }
  }
  if (verifyMethods.size > 0) {
    imports.add('com.github.tomakehurst.wiremock.client.WireMock.urlPathMatching');
    for (const m of verifyMethods) {
      imports.add(`com.github.tomakehurst.wiremock.client.WireMock.${m}RequestedFor`);
    }
  }
  const anyBody = uniqueTests.some((t) => t.canEmitHappyPath && t.requiredBodyPaths.length > 0);
  const anyQuery = uniqueTests.some((t) => t.canEmitHappyPath && t.requiredQueryAssertions.length > 0);
  const anyForbidden = uniqueTests.some((t) => t.canEmitHappyPath && t.forbiddenQueryParams.length > 0);
  if (anyBody) imports.add('com.github.tomakehurst.wiremock.client.WireMock.matchingJsonPath');
  if (anyQuery) imports.add('com.github.tomakehurst.wiremock.client.WireMock.matching');
  if (anyForbidden) imports.add('com.github.tomakehurst.wiremock.client.WireMock.absent');
  // assertEquals is needed when any test has response field assertions.
  if (uniqueTests.some((t) => t.canEmitHappyPath && t.responseAssertions.length > 0)) {
    imports.add('org.junit.jupiter.api.Assertions.assertEquals');
  }

  const pkg = packageSegment(mountName);
  const apiCls = resolveApiClassName(mountName, buildExportedClassNameSet(ctx));

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
  const mountPackage = packageSegment(resolved?.mountOn ?? svc.name);

  const hidden = buildHiddenParams(resolved);

  // Build call args in the order expected by the generated method signature:
  //   pathParams ++ requiredQuery ++ requiredBodyFields
  const imports = new Set<string>();
  const argParts: string[] = [];
  const requiredBodyPaths: string[] = [];
  const requiredQueryAssertions: { name: string; valueRegex: string }[] = [];

  for (const _pp of op.pathParams) argParts.push(ktStringLiteral('sample-arg'));

  const groupedParamNames = collectGroupedParamNames(op);

  const queryFields = op.queryParams.filter((p) => !hidden.has(p.name) && !groupedParamNames.has(p.name));
  const sortedQuery = [...queryFields].sort((a, b) => (a.required === b.required ? 0 : a.required ? -1 : 1));
  const sharedQueryBodyParams = new Set<string>();
  const bodyModel = resolveBodyModel(op, ctx);
  for (const qp of queryFields) {
    const matchingBodyField = bodyModel?.fields.find((field) => field.name === qp.name);
    if (matchingBodyField && mapTypeRef(qp.type) === mapTypeRef(matchingBodyField.type)) {
      sharedQueryBodyParams.add(qp.name);
    }
  }
  for (const qp of sortedQuery) {
    if (!qp.required) break;
    const promotedType = promoteIso8601TypeRef(qp.type, qp.description);
    const val = synthValue(promotedType, ctx, imports);
    if (val === null) return null;
    argParts.push(val);
    // Best-effort wire assertion: for primitives/strings we know the synthesized
    // value so we can assert equality; otherwise just assert presence.
    const regex = queryValueRegexFor(promotedType);
    if (regex !== null) requiredQueryAssertions.push({ name: qp.name, valueRegex: regex });
  }

  // Parameter group args — emit as named args (they appear after optionals in the signature)
  const groupParamNames = assignGroupParameterNames(op, hidden, queryFields, bodyModel, groupedParamNames);
  for (const group of op.parameterGroups ?? []) {
    const variant = group.variants[0];
    const sealedName = sealedGroupName(group.name);
    const variantName = className(variant.name);
    const variantArgs = variant.parameters.map((_p) => ktStringLiteral('sample-arg')).join(', ');
    imports.add(`com.workos.${mountPackage}.${sealedName}`);
    argParts.push(`${groupParamNames.get(group.name)!} = ${sealedName}.${variantName}(${variantArgs})`);
  }

  if (bodyModel) {
    // Body fields always pass; colliding names are renamed (e.g. slug →
    // bodySlug) by the resources emitter, so every required body field still
    // needs a test argument here.
    const bodyFields = bodyModel.fields.filter((f) => !hidden.has(f.name) && !groupedParamNames.has(f.name));
    const sortedBody = [...bodyFields].sort((a, b) => (a.required === b.required ? 0 : a.required ? -1 : 1));
    for (const bf of sortedBody) {
      if (sharedQueryBodyParams.has(bf.name)) continue;
      if (!bf.required) break;
      const promotedType = promoteIso8601TypeRef(bf.type, bf.description);
      const val = synthValue(promotedType, ctx, imports);
      if (val === null) return null;
      argParts.push(val);
      // matchingJsonPath on an array/map body field fails on empty
      // synthesized collections because JsonPath returns an empty result
      // set.  Scalar fields always materialize with a concrete value, so
      // we only assert those paths.
      if (isScalarBodyField(promotedType)) requiredBodyPaths.push(bf.name);
    }
  }

  const plan2 = plan;
  const responseClass = plan2.isPaginated
    ? 'Page'
    : plan2.responseModelName
      ? className(plan2.responseModelName)
      : null;

  const minimalBody = buildResponseBody(plan2, ctx);

  // Void/delete methods don't need a response class or body — they succeed
  // when the call completes without throwing. We can emit a happy-path test
  // as long as we were able to synthesize all required arguments.
  const isVoidMethod = responseClass === null;
  const canEmitHappyPath = isVoidMethod || (responseClass !== null && minimalBody !== null);

  // Build response field assertions for non-paginated, non-array model responses.
  // Array responses return List<T>, so `result.field` doesn't compile.
  const responseAssertions =
    !plan2.isPaginated && !plan2.isArrayResponse && plan2.responseModelName
      ? buildResponseAssertions(plan2.responseModelName, ctx)
      : [];

  // For POST/PUT/PATCH with parameter groups, collect all wire field names
  // from the groups — these must NOT appear as query parameters.
  const forbiddenQueryParams: string[] = [];
  const httpUpper = op.httpMethod.toUpperCase();
  if (['POST', 'PUT', 'PATCH'].includes(httpUpper) && (op.parameterGroups?.length ?? 0) > 0) {
    for (const group of op.parameterGroups!) {
      for (const variant of group.variants) {
        for (const p of variant.parameters) {
          if (!forbiddenQueryParams.includes(p.name)) forbiddenQueryParams.push(p.name);
        }
      }
    }
  }

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
    forbiddenQueryParams,
    responseAssertions,
  };
}

function assignGroupParameterNames(
  op: Operation,
  hidden: Set<string>,
  queryFields: Operation['queryParams'],
  bodyModel: Model | null,
  groupedParamNames: Set<string> = new Set(),
): Map<string, string> {
  const occupiedNames = new Set<string>();

  for (const pp of op.pathParams) occupiedNames.add(propertyName(pp.name));
  for (const qp of queryFields) occupiedNames.add(propertyName(qp.name));

  for (const bf of bodyModel?.fields ?? []) {
    if (hidden.has(bf.name) || groupedParamNames.has(bf.name)) continue;
    const natural = propertyName(bf.name);
    if (occupiedNames.has(natural)) {
      occupiedNames.add(`body${natural.charAt(0).toUpperCase()}${natural.slice(1)}`);
    } else {
      occupiedNames.add(natural);
    }
  }

  const names = new Map<string, string>();
  for (const group of op.parameterGroups ?? []) {
    const natural = propertyName(sealedGroupName(group.name));
    const assigned = reserveUniqueGroupParameterName(natural, occupiedNames);
    names.set(group.name, assigned);
  }
  return names;
}

function sealedGroupName(name: string): string {
  const resolved = className(name);
  if (resolved === 'Password') return 'CreateUserPassword';
  if (resolved === 'Role') return 'CreateUserRole';
  return resolved;
}

function reserveUniqueGroupParameterName(base: string, occupiedNames: Set<string>): string {
  if (!occupiedNames.has(base)) {
    occupiedNames.add(base);
    return base;
  }

  const capitalized = `${base.charAt(0).toUpperCase()}${base.slice(1)}`;
  const prefixed = `group${capitalized}`;
  if (!occupiedNames.has(prefixed)) {
    occupiedNames.add(prefixed);
    return prefixed;
  }

  let index = 2;
  while (occupiedNames.has(`${prefixed}${index}`)) index += 1;
  const fallback = `${prefixed}${index}`;
  occupiedNames.add(fallback);
  return fallback;
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
    const promotedType = promoteIso8601TypeRef(rp.field.type, rp.field.description);
    const val = synthValue(promotedType, ctx, imports);
    if (val === null) return null;
    argParts.push(val);
  }

  const responseClass = wrapper.responseModelName ? className(wrapper.responseModelName) : null;
  const minimalBody = wrapper.responseModelName
    ? synthJsonForModelName(wrapper.responseModelName, ctx, new Set())
    : null;
  const isVoidMethod = responseClass === null;
  const canEmitHappyPath = isVoidMethod || (responseClass !== null && minimalBody !== null);
  const responseAssertions = wrapper.responseModelName ? buildResponseAssertions(wrapper.responseModelName, ctx) : [];

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
    forbiddenQueryParams: [],
    responseAssertions,
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

/**
 * Build assertEquals assertions for required scalar fields on a response model.
 * Returns `{ accessor, expectedExpr }` pairs for fields whose JSON value we
 * synthesize and whose Kotlin type we can assert against.
 *
 * Only asserts fields present on ALL structurally-identical models in the
 * dedup group. This avoids broken assertions when the Kotlin class is a
 * typealias pointing at a canonical model with a different field set.
 * As a practical heuristic we restrict to fields that appear on the
 * response model itself (models that get deduplicated share the same fields).
 */
const MAX_RESPONSE_ASSERTIONS = 5;

function buildResponseAssertions(
  responseModelName: string | null,
  ctx: EmitterContext,
): { accessor: string; expectedExpr: string }[] {
  if (!responseModelName) return [];
  const model = ctx.spec.models.find((m) => m.name === responseModelName);
  if (!model) return [];

  const assertions: { accessor: string; expectedExpr: string }[] = [];
  for (const field of model.fields) {
    if (!field.required) continue;
    if (assertions.length >= MAX_RESPONSE_ASSERTIONS) break;
    // DOMAIN identifier: the property accessor on the deserialized model.
    // Honors a `domainName` override; the synthesized JSON above keys off
    // `field.name` (the wire key).
    const ktProp = domainPropertyName(field);
    const type = field.type;
    if (type.kind === 'primitive') {
      if (type.format === 'date-time') continue;
      switch (type.type) {
        case 'string':
          assertions.push({ accessor: ktProp, expectedExpr: '"sample"' });
          break;
        case 'integer':
          assertions.push({ accessor: ktProp, expectedExpr: type.format === 'int32' ? '0' : '0L' });
          break;
        case 'number':
          assertions.push({ accessor: ktProp, expectedExpr: '0.0' });
          break;
        case 'boolean':
          assertions.push({ accessor: ktProp, expectedExpr: 'false' });
          break;
      }
    } else if (type.kind === 'literal') {
      if (typeof type.value === 'string') {
        assertions.push({ accessor: ktProp, expectedExpr: ktStringLiteral(type.value) });
      } else if (typeof type.value === 'number') {
        assertions.push({ accessor: ktProp, expectedExpr: String(type.value) });
      } else if (typeof type.value === 'boolean') {
        assertions.push({ accessor: ktProp, expectedExpr: String(type.value) });
      }
    }
  }
  return assertions;
}

function emitHappyPathTest(lines: string[], t: OpTest): void {
  lines.push('');
  lines.push(`  @Test`);
  const isVoid = t.responseClass === null;
  const testLabel = isVoid ? `${t.method} completes without throwing` : `${t.method} returns a typed response`;
  lines.push(`  fun \`${testLabel}\`() {`);

  // Void/delete methods don't return a body — stub with 200 and empty body.
  const statusCode = isVoid ? (t.httpMethod === 'delete' ? 204 : 200) : 200;
  if (isVoid) {
    lines.push(
      `    stubResponse(${ktStringLiteral(t.httpMethod.toUpperCase())}, ${ktStringLiteral(t.pathForWireMock)}, ${statusCode})`,
    );
  } else {
    const bodyString = ktStringLiteral(t.minimalResponseBody);
    const stubLine = `    stubResponse(${ktStringLiteral(t.httpMethod.toUpperCase())}, ${ktStringLiteral(t.pathForWireMock)}, ${statusCode}, ${bodyString})`;
    if (stubLine.length <= KTLINT_MAX_LINE_LENGTH) {
      lines.push(stubLine);
    } else {
      lines.push('    stubResponse(');
      lines.push(`      ${ktStringLiteral(t.httpMethod.toUpperCase())},`);
      lines.push(`      ${ktStringLiteral(t.pathForWireMock)},`);
      lines.push(`      ${statusCode},`);
      emitStubResponseBody(lines, '      ', t.minimalResponseBody);
      lines.push('    )');
    }
  }

  if (isVoid) {
    emitCall(lines, '    ', `api().${t.method}`, t.callArgs);
  } else {
    emitCall(lines, '    ', `val result = api().${t.method}`, t.callArgs);
    lines.push('    assertNotNull(result)');
    // Emit exact-value assertions for required scalar fields in the response.
    for (const a of t.responseAssertions) {
      lines.push(`    assertEquals(${a.expectedExpr}, result.${a.accessor})`);
    }
  }

  // Verify the outbound request shape.  Body fields and query assertions
  // live on the `OpTest` and are only emitted when we know the synthesized
  // arguments produce a deterministic wire representation.
  if (t.requiredBodyPaths.length > 0 || t.requiredQueryAssertions.length > 0 || t.forbiddenQueryParams.length > 0) {
    lines.push('    wireMockRule.verify(');
    lines.push(`      ${t.httpMethod}RequestedFor(urlPathMatching(${ktStringLiteral(t.pathForWireMock)}))`);
    for (const path of t.requiredBodyPaths) {
      lines.push(`        .withRequestBody(matchingJsonPath(${ktStringLiteral(`$.${path}`)}))`);
    }
    for (const qa of t.requiredQueryAssertions) {
      lines.push(`        .withQueryParam(${ktStringLiteral(qa.name)}, matching(${ktStringLiteral(qa.valueRegex)}))`);
    }
    // Assert sensitive fields from parameter groups never leak into the URL.
    for (const name of t.forbiddenQueryParams) {
      lines.push(`        .withQueryParam(${ktStringLiteral(name)}, absent())`);
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
 * Emit `val json = "..."` on a single line when it fits within KTLINT_MAX_LINE_LENGTH,
 * otherwise split the string literal across lines joined with `+`.
 */
function emitJsonVal(lines: string[], indent: string, rawJson: string): void {
  const encoded = ktStringLiteral(rawJson);
  const singleLine = `${indent}val json = ${encoded}`;
  if (singleLine.length <= KTLINT_MAX_LINE_LENGTH) {
    lines.push(singleLine);
    return;
  }
  // ktlint: "A multiline expression should start on a new line"
  lines.push(`${indent}val json =`);
  // ktlint indent rules (with indent_size=2, continuation_indent=2):
  //   first continuation after `=`:  indent + 2  (e.g. 6 spaces)
  //   subsequent `+` continuations:  indent + 4  (e.g. 8 spaces)
  const firstIndent = `${indent}  `;
  const restIndent = `${indent}    `;
  // Budget for the widest indent so every chunk fits.
  const maxChunkLineLen = KTLINT_MAX_LINE_LENGTH - restIndent.length - 2; // 2 for " +"
  const chunks = splitEscapedStringLiteral(encoded, maxChunkLineLen);
  for (let i = 0; i < chunks.length; i++) {
    const suffix = i === chunks.length - 1 ? '' : ' +';
    const lineIndent = i === 0 ? firstIndent : restIndent;
    lines.push(`${lineIndent}${chunks[i]}${suffix}`);
  }
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

/**
 * True when a TypeRef is safe for JSON round-trip testing: primitives,
 * nullable wrappers around primitives, literals, and empty arrays/maps.
 * Nested model and enum references are excluded because Jackson
 * reserializes them with additional optional-field defaults that weren't
 * in the original fixture JSON.
 */
function isRoundTripSafeType(ref: TypeRef): boolean {
  if (ref.kind === 'primitive') return true;
  if (ref.kind === 'literal') return true;
  if (ref.kind === 'nullable') return isRoundTripSafeType(ref.inner);
  if (ref.kind === 'array') return isRoundTripSafeType(ref.items);
  if (ref.kind === 'map') return isRoundTripSafeType(ref.valueType);
  return false;
}

function generateModelRoundTripTest(spec: ApiSpec, ctx: EmitterContext): GeneratedFile | null {
  // Collect round-trippable models: non-list-wrapper data classes for which
  // we can synthesize a complete JSON fixture (required fields only).
  // Uses synthJsonForModelName which handles primitives, enums, nested
  // models, arrays, maps, and literals — much broader than the old
  // primitives-only filter.
  const targets: { model: Model; json: string }[] = [];
  const seenModelClassNames = new Set<string>();
  for (const m of spec.models) {
    if (isListWrapperModel(m) || isListMetadataModel(m)) continue;
    if (m.fields.length === 0) continue;
    // AGGREGATE gate: this whole-suite test references `${cls}::class.java`. In a
    // scoped run only in-scope model files are emitted, so skip a brand-new
    // OUT-OF-SCOPE model whose `.kt` won't exist on disk. In-scope ∪ prior
    // manifest is retained; a full run keeps everything (gate is inert).
    if (!fileExistsAfterRun(modelFilePath(m.name), isModelInScope(m.name, ctx), ctx)) continue;
    const cls = className(m.name);
    if (seenModelClassNames.has(cls)) continue;
    seenModelClassNames.add(cls);
    // Only include models where ALL fields are required AND all types are
    // round-trip safe (primitives, nullable, literals, simple arrays/maps).
    // Nested model/enum references break round-trip because Jackson
    // reserializes with additional default fields not in the original JSON.
    if (!m.fields.every((f) => f.required && isRoundTripSafeType(f.type))) continue;
    const json = synthJsonForModelName(m.name, ctx, new Set());
    if (json !== null) targets.push({ model: m, json });
  }
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

  for (const { model, json } of targets) {
    const cls = className(model.name);
    lines.push('', '  @Test', `  fun \`${cls} round-trips through Jackson\`() {`);
    emitJsonVal(lines, '    ', json);
    lines.push(
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
 * Tests a representative set of enums (up to MAX_ENUM_FORWARD_COMPAT) and
 * the first synthesizable model.
 */
const MAX_ENUM_FORWARD_COMPAT = 15;

function generateForwardCompatTest(spec: ApiSpec, ctx: EmitterContext): GeneratedFile | null {
  // Select multiple enums for forward-compat testing, not just the first.
  // AGGREGATE gate: each selected enum is imported as `com.workos.types.X`. In a
  // scoped run only in-scope enum files are emitted, so skip a brand-new
  // OUT-OF-SCOPE enum whose `.kt` won't exist on disk (in-scope ∪ prior manifest
  // retained; full run keeps everything).
  const enumTargets = spec.enums
    .filter((e) => e.values.length > 0)
    .filter((e) => fileExistsAfterRun(enumFilePath(e.name), isEnumInScope(e.name, ctx), ctx))
    .slice(0, MAX_ENUM_FORWARD_COMPAT);
  const modelTarget = spec.models.find((m) => {
    if (isListWrapperModel(m) || isListMetadataModel(m)) return false;
    if (m.fields.length === 0) return false;
    // Same aggregate gate as the round-trip test: the model is referenced as
    // `${cls}::class.java`, so it must exist on disk after the run.
    if (!fileExistsAfterRun(modelFilePath(m.name), isModelInScope(m.name, ctx), ctx)) return false;
    return synthJsonForModelName(m.name, ctx, new Set()) !== null;
  });
  if (enumTargets.length === 0 && !modelTarget) return null;

  const enumImports = new Set<string>();
  for (const e of enumTargets) enumImports.add(`com.workos.types.${className(e.name)}`);

  const lines: string[] = [
    'package com.workos.models',
    '',
    'import com.fasterxml.jackson.core.type.TypeReference',
    'import com.workos.common.json.ObjectMapperFactory',
  ];
  for (const imp of [...enumImports].sort()) lines.push(`import ${imp}`);
  lines.push(
    'import org.junit.jupiter.api.Assertions.assertEquals',
    'import org.junit.jupiter.api.Assertions.assertNotNull',
    'import org.junit.jupiter.api.Test',
    '',
    'class GeneratedForwardCompatTest {',
    '  private val mapper = ObjectMapperFactory.create()',
  );

  for (const enumTarget of enumTargets) {
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
    const jsonLiteral = synthJsonForModelName(modelTarget.name, ctx, new Set())!;
    const jsonWithExtra = jsonLiteral.replace('{', '{"__oagen_future_field__": "ignored", ');
    lines.push('', `  @Test`, `  fun \`${modelCls} ignores unknown JSON fields\`() {`);
    emitJsonVal(lines, '    ', jsonWithExtra);
    lines.push(`    val parsed = mapper.readValue(json, ${modelCls}::class.java)`, '    assertNotNull(parsed)', '  }');
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

function findService(ctx: EmitterContext, op: Operation): Service | undefined {
  for (const service of ctx.spec.services) {
    if (service.operations.includes(op)) return service;
  }
  return undefined;
}
