import type {
  ApiSpec,
  EmitterContext,
  Enum,
  GeneratedFile,
  Model,
  Operation,
  Parameter,
  ResolvedOperation,
  ResolvedWrapper,
  TypeRef,
} from '@workos/oagen';
import { methodName, moduleName, typeName } from './naming.js';
import { groupByMount } from '../shared/resolved-ops.js';
import { exampleFor, generateFixtures } from './fixtures.js';
import { resolveWrapperParams } from '../shared/wrapper-utils.js';

/**
 * Generate integration tests under `tests/`. Each mount group gets one
 * `tests/{mount}_test.rs` file. Per operation the generator emits:
 *
 *   - `_round_trip`: happy-path 200 mock + call.
 *   - `_unauthorized`, `_not_found`, `_rate_limited`, `_server_error`: error
 *     paths for every HTTP-calling op.
 *   - `_bad_request`, `_unprocessable`: additional 4xx error paths for write
 *     ops (POST/PUT/PATCH/DELETE).
 *   - `_empty_page`: empty `data: []` response for paginated ops.
 *   - `_encodes_query_params`: outbound query-string assertion for ops with
 *     array query params (`explode: true` repeated keys, `explode: false`
 *     comma-joined).
 *
 * URL-builder ops (no HTTP call) only get the round-trip test.
 */
export function generateTests(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  files.push(...generateFixtures(spec));

  files.push({
    path: 'tests/common/mod.rs',
    content: renderCommon(ctx),
    overwriteExisting: true,
  });

  const groups = groupByMount(ctx);
  const modelMap = new Map(spec.models.map((m) => [m.name, m]));
  const enumMap = new Map(spec.enums.map((e) => [e.name, e]));

  for (const [mountName, group] of groups) {
    if (group.operations.length === 0) continue;
    files.push({
      path: `tests/${moduleName(mountName)}_test.rs`,
      content: renderMountTest(mountName, group.resolvedOps, ctx, modelMap, enumMap),
      overwriteExisting: true,
    });
  }

  return files;
}

function renderCommon(ctx: EmitterContext): string {
  const crate = crateName(ctx);
  const imports = [
    { path: 'wiremock::MockServer', sort: 'wiremock::MockServer' },
    { path: `${crate}::Client`, sort: `${crate}::Client` },
  ].sort((a, b) => a.sort.localeCompare(b.sort));

  const useLines = imports.map((i) => `use ${i.path};`).join('\n');

  return `#![allow(dead_code)]

${useLines}

pub async fn test_client(server: &MockServer) -> Client {
    Client::builder()
        .api_key("test_api_key")
        .base_url(server.uri())
        .max_retries(0)
        .build()
}
`;
}

function renderMountTest(
  mountName: string,
  resolvedOps: ResolvedOperation[],
  ctx: EmitterContext,
  modelMap: Map<string, Model>,
  enumMap: Map<string, Enum>,
): string {
  const accessor = moduleName(mountName);
  const crate = crateName(ctx);
  const lines: string[] = [];
  lines.push('mod common;');
  lines.push('');
  lines.push('use wiremock::matchers::{method, path as path_matcher};');
  lines.push('use wiremock::{Mock, MockServer, ResponseTemplate};');
  lines.push(`use ${crate}::Error;`);
  lines.push('');

  const seen = new Set<string>();

  for (const r of resolvedOps) {
    const op = r.operation;
    if ((r.wrappers?.length ?? 0) > 0) {
      for (const w of r.wrappers!) {
        const m = methodName(w.name);
        if (seen.has(m)) continue;
        seen.add(m);
        lines.push(...renderWrapperTest(op, w, ctx, accessor, crate, modelMap, enumMap));
        lines.push('');
      }
      continue;
    }
    const m = methodName(r.methodName);
    if (seen.has(m)) continue;
    seen.add(m);
    lines.push(...renderRegularTest(op, r, accessor, crate, modelMap, enumMap));
    lines.push('');
  }

  // Trim a trailing blank line.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  return lines.join('\n') + '\n';
}

/**
 * Bundle of inputs computed once per operation and reused across the various
 * test categories (round-trip, error tests, encoding tests). All test
 * categories share the same params construction, path, method, and accessor
 * call shape — the only thing that varies is the response template and the
 * assertion.
 */
interface CallShape {
  /** Operation method name, e.g. `list_events`. */
  methodIdent: string;
  /** Literal path with `{id}` placeholders substituted to `test_id`. */
  literalPath: string;
  /** Upper-case HTTP verb, e.g. `GET`. */
  httpMethod: string;
  /** The args passed to the SDK method call, joined with `, `. */
  callArgs: string;
  /** True when the op is a URL-builder (no HTTP call). */
  isUrlBuilder: boolean;
  /** True for HTTP methods that mutate state. */
  isWrite: boolean;
  /** True when the op declares cursor pagination. */
  isPaginated: boolean;
  /** When non-null, the op has a synthetic body group enum. */
  hasBodyGroup: boolean;
}

/** Test for a non-wrapper operation. */
function renderRegularTest(
  op: Operation,
  resolved: ResolvedOperation,
  accessor: string,
  crate: string,
  modelMap: Map<string, Model>,
  enumMap: Map<string, Enum>,
): string[] {
  const m = methodName(resolved.methodName);
  const literalPath = op.path.replace(/\{[^}]+\}/g, 'test_id');
  const httpMethod = op.httpMethod.toUpperCase();
  const responseExpr = responseBodyExpr(op.response, modelMap, enumMap);
  const isUrlBuilder = resolved.urlBuilder === true;

  const callArgs = buildCallArgs(op, resolved, crate, accessor, modelMap, enumMap).join(', ');
  const shape: CallShape = {
    methodIdent: m,
    literalPath,
    httpMethod,
    callArgs,
    isUrlBuilder,
    isWrite: isWriteMethod(op.httpMethod),
    isPaginated: !!op.pagination,
    hasBodyGroup: !!op.requestBody && hasBodyParameterGroup(op),
  };

  const lines: string[] = [];

  // Round-trip (happy path).
  lines.push('#[tokio::test]');
  lines.push(`async fn ${accessor}_${m}_round_trip() {`);
  if (isUrlBuilder) {
    // URL-builder ops don't issue HTTP requests; there's nothing to mock.
    lines.push('    let server = MockServer::start().await;');
    lines.push('    let client = common::test_client(&server).await;');
    lines.push(`    let _ = client.${accessor}().${m}(${callArgs});`);
  } else {
    lines.push('    let server = MockServer::start().await;');
    lines.push(`    Mock::given(method(${JSON.stringify(httpMethod)}))`);
    lines.push(`        .and(path_matcher(${JSON.stringify(literalPath)}))`);
    lines.push(`        .respond_with(ResponseTemplate::new(200).set_body_string(${responseExpr}))`);
    lines.push('        .expect(1)');
    lines.push('        .mount(&server)');
    lines.push('        .await;');
    lines.push('    let client = common::test_client(&server).await;');
    lines.push(`    let _ = client.${accessor}().${m}(${callArgs}).await;`);
  }
  // wiremock asserts on drop that the `.expect(1)` mock was matched once;
  // mismatched method/path produces a panic at end-of-test. We deliberately
  // ignore the deserialised response: stub fixtures cover the common path
  // (typed model deserialisation), but discriminated-union responses can't
  // always be reproduced from a generated fixture without bespoke schema
  // awareness, so a strict `is_ok()` would over-trigger.
  lines.push('}');

  if (isUrlBuilder) {
    // No HTTP call to mock — the round-trip is all we can sensibly emit.
    return lines;
  }

  // Error-path tests — same path/method, different response status.
  for (const errTest of standardErrorTests(shape, accessor)) {
    lines.push('');
    lines.push(...errTest);
  }

  if (shape.isWrite) {
    for (const errTest of writeErrorTests(shape, accessor)) {
      lines.push('');
      lines.push(...errTest);
    }
  }

  // Empty-page test for paginated list ops.
  if (shape.isPaginated) {
    const emptyTest = emptyPageTest(op, shape, accessor);
    if (emptyTest) {
      lines.push('');
      lines.push(...emptyTest);
    }
  }

  // Query-string encoding assertion when an array query param is present.
  const encodingTest = encodesQueryParamsTest(op, resolved, accessor, crate, modelMap, enumMap);
  if (encodingTest) {
    lines.push('');
    lines.push(...encodingTest);
  }

  return lines;
}

/**
 * Build the positional args for the resource method call: path-param literals,
 * then a single params struct (when the op has any), then a token-string for
 * non-bearer security overrides. This factors the constructor logic out of
 * the round-trip renderer so the error/encoding tests can reuse it verbatim
 * — every test category sends the same request, only the mocked response and
 * assertion differ.
 */
function buildCallArgs(
  op: Operation,
  resolved: ResolvedOperation,
  crate: string,
  accessor: string,
  modelMap: Map<string, Model>,
  enumMap: Map<string, Enum>,
): string[] {
  const hidden = new Set<string>([...Object.keys(resolved.defaults ?? {}), ...(resolved.inferFromClient ?? [])]);
  // Names of query/header params that fold into a parameter-group enum and
  // therefore must not be passed individually to the params constructor.
  const groupedNames = new Set<string>();
  for (const g of op.parameterGroups ?? []) {
    for (const v of g.variants) for (const p of v.parameters) groupedNames.add(p.name);
  }
  const visibleQuery = op.queryParams.filter((p) => !hidden.has(p.name) && !groupedNames.has(p.name));
  const visibleHeader = op.headerParams.filter((p) => !hidden.has(p.name));
  const visibleParams = [...visibleQuery, ...visibleHeader];
  const requiredParams = visibleParams.filter((p) => p.required);
  const hasBody = op.requestBody !== undefined;
  const bodyRequired = hasBody && op.requestBody!.kind !== 'nullable';
  const queryNames = new Set(op.queryParams.map((p) => p.name));
  const requiredGroups = (op.parameterGroups ?? []).filter((g) => !g.optional);
  const requiredQueryGroups = requiredGroups.filter((g) =>
    g.variants.every((v) => v.parameters.every((p) => queryNames.has(p.name))),
  );
  const emptyParams = !hasBody && visibleParams.length === 0 && (op.parameterGroups?.length ?? 0) === 0;

  const callArgs: string[] = [];
  for (const _ of op.pathParams) callArgs.push('"test_id"');

  if (!emptyParams) {
    const paramsType = `${crate}::${accessor}::${typeName(resolved.methodName)}Params`;
    const noCtorRequired = requiredParams.length === 0 && !bodyRequired && requiredQueryGroups.length === 0;
    if (noCtorRequired) {
      callArgs.push(`${paramsType}::default()`);
    } else {
      const ctorArgs: string[] = [];
      for (const p of requiredParams) {
        ctorArgs.push(stubExpr(p.type, p.name, modelMap, enumMap));
      }
      for (const g of requiredQueryGroups) {
        ctorArgs.push(parameterGroupStubExpr(g, crate, accessor));
      }
      if (hasBody && bodyRequired) {
        const hasBodyGroup = hasBodyParameterGroup(op);
        if (hasBodyGroup) {
          ctorArgs.push(syntheticBodyStubExpr(op, resolved, crate, accessor, modelMap));
        } else {
          ctorArgs.push(stubExpr(op.requestBody!, 'body', modelMap, enumMap));
        }
      }
      callArgs.push(`${paramsType}::new(${ctorArgs.join(', ')})`);
    }
  }

  // Per-operation bearer override (e.g. `GET /sso/profile`) — append the
  // access-token positional arg before the awaiter.
  const tokenName = bearerOverrideTokenName(op);
  if (tokenName) {
    callArgs.push(`"stub_${tokenName}".to_string()`);
  }

  return callArgs;
}

/**
 * Build the four common-error test bodies (401/404/429/500). Each one mocks a
 * single response with the given status, calls the SDK method (which should
 * fail), and asserts on the unwrapped `Error::Api` payload.
 */
function standardErrorTests(shape: CallShape, accessor: string): string[][] {
  const tests: string[][] = [];
  tests.push(errorTestBody(shape, accessor, 'unauthorized', 401, '{"message":"Unauthorized"}', undefined));
  tests.push(errorTestBody(shape, accessor, 'not_found', 404, '{"message":"Not found"}', undefined));
  tests.push(
    errorTestBody(shape, accessor, 'rate_limited', 429, '{"message":"Slow down"}', {
      retryAfterSeconds: 1,
      assertRetryAfter: true,
    }),
  );
  tests.push(errorTestBody(shape, accessor, 'server_error', 500, '{"message":"Internal error"}', undefined));
  return tests;
}

/** Build the two write-op-only error tests (400/422). */
function writeErrorTests(shape: CallShape, accessor: string): string[][] {
  return [
    errorTestBody(shape, accessor, 'bad_request', 400, '{"code":"validation_error","message":"Bad request"}', {
      assertCode: 'validation_error',
    }),
    errorTestBody(shape, accessor, 'unprocessable', 422, '{"message":"Unprocessable"}', undefined),
  ];
}

interface ErrorOptions {
  retryAfterSeconds?: number;
  assertRetryAfter?: boolean;
  assertCode?: string;
}

function errorTestBody(
  shape: CallShape,
  accessor: string,
  category: string,
  status: number,
  body: string,
  opts: ErrorOptions | undefined,
): string[] {
  const lines: string[] = [];
  lines.push('#[tokio::test]');
  lines.push(`async fn ${accessor}_${shape.methodIdent}_${category}() {`);
  lines.push('    let server = MockServer::start().await;');
  lines.push(`    let template = ResponseTemplate::new(${status})`);
  if (opts?.retryAfterSeconds !== undefined) {
    lines.push(`        .insert_header("retry-after", ${JSON.stringify(String(opts.retryAfterSeconds))})`);
  }
  lines.push(`        .set_body_string(${JSON.stringify(body)});`);
  lines.push(`    Mock::given(method(${JSON.stringify(shape.httpMethod)}))`);
  lines.push(`        .and(path_matcher(${JSON.stringify(shape.literalPath)}))`);
  lines.push('        .respond_with(template)');
  lines.push('        .expect(1)');
  lines.push('        .mount(&server)');
  lines.push('        .await;');
  lines.push('    let client = common::test_client(&server).await;');
  lines.push(
    `    let err = client.${accessor}().${shape.methodIdent}(${shape.callArgs}).await.expect_err("expected error");`,
  );
  lines.push('    let api = match &err {');
  lines.push('        Error::Api(api) => api.as_ref(),');
  lines.push('        other => panic!("expected Error::Api, got {other:?}"),');
  lines.push('    };');
  lines.push(`    assert_eq!(api.status, ${status});`);
  if (opts?.assertRetryAfter) {
    lines.push(
      `    assert_eq!(api.retry_after, Some(std::time::Duration::from_secs(${opts.retryAfterSeconds ?? 0})));`,
    );
  }
  if (opts?.assertCode) {
    lines.push(`    assert_eq!(api.code.as_deref(), Some(${JSON.stringify(opts.assertCode)}));`);
  }
  lines.push('}');
  return lines;
}

/**
 * Return an `_empty_page` test for a paginated list op. Two shapes are
 * supported:
 *
 *  - Wrapper model: `{"data": [], "list_metadata": {...}}`, accessed via
 *    `resp.data` on the returned struct.
 *  - Bare array: `[]`, accessed via `resp.is_empty()` directly (the SDK
 *    returns `Vec<T>` for paginated ops without a wrapper model).
 *
 * Returns null when the response shape isn't recognised (e.g. a primitive
 * or unknown shape we can't safely assert against).
 */
function emptyPageTest(op: Operation, shape: CallShape, accessor: string): string[] | null {
  const responseKind = op.response.kind;
  let body: string;
  let dataAccessor: string;
  if (responseKind === 'array') {
    // Bare-array paginated response: SDK returns Vec<T>.
    body = '[]';
    dataAccessor = 'resp';
  } else if (responseKind === 'model') {
    // Wrapper-model paginated response: SDK returns the wrapper struct.
    // `list_metadata` is always an object — its required field set depends
    // on the response model, but for the empty case both `before` and `after`
    // are either present-as-null or absent. We emit both keys as null to
    // satisfy any shape with optional cursor fields without hard-coding
    // per-op knowledge.
    // The wrapper model has a required `object` discriminator field, e.g.
    // `"list"`. Include it so the response deserialises against any
    // generated wrapper struct.
    body = '{"object":"list","data":[],"list_metadata":{"before":null,"after":null}}';
    dataAccessor = 'resp.data';
  } else {
    return null;
  }
  const lines: string[] = [];
  lines.push('#[tokio::test]');
  lines.push(`async fn ${accessor}_${shape.methodIdent}_empty_page() {`);
  lines.push('    let server = MockServer::start().await;');
  lines.push(`    Mock::given(method(${JSON.stringify(shape.httpMethod)}))`);
  lines.push(`        .and(path_matcher(${JSON.stringify(shape.literalPath)}))`);
  lines.push(`        .respond_with(ResponseTemplate::new(200).set_body_string(${JSON.stringify(body)}))`);
  lines.push('        .expect(1)');
  lines.push('        .mount(&server)');
  lines.push('        .await;');
  lines.push('    let client = common::test_client(&server).await;');
  lines.push(
    `    let resp = client.${accessor}().${shape.methodIdent}(${shape.callArgs}).await.expect("expected success");`,
  );
  lines.push(`    assert!(${dataAccessor}.is_empty(), "expected empty data array");`);
  lines.push('}');
  return lines;
}

/**
 * Build an `_encodes_query_params` test when the op declares at least one
 * array query param. Constructs a params struct with a known Vec value on
 * each array field and asserts the actual outbound query string contains
 * either repeated keys (`events=foo&events=bar`, default for `explode: true`)
 * or a comma-joined value (`events=foo%2Cbar`, when `explode: false`).
 *
 * Returns null when no array query params apply — those ops have nothing
 * interesting to encode.
 */
function encodesQueryParamsTest(
  op: Operation,
  resolved: ResolvedOperation,
  accessor: string,
  crate: string,
  modelMap: Map<string, Model>,
  enumMap: Map<string, Enum>,
): string[] | null {
  const hidden = new Set<string>([...Object.keys(resolved.defaults ?? {}), ...(resolved.inferFromClient ?? [])]);
  const groupedNames = new Set<string>();
  for (const g of op.parameterGroups ?? []) {
    for (const v of g.variants) for (const p of v.parameters) groupedNames.add(p.name);
  }
  // Find at most one Vec<String> query param to drive the assertion. The
  // order is stable (it follows `op.queryParams`), and one is enough — the
  // encoder applies the same rule to every array field. We restrict the
  // assertion to string-element arrays because non-string arrays (e.g.
  // enums) require per-type constructors we can't reliably synthesise from
  // the IR alone, and serializing a Vec<EnumX> via vec!["foo".into(), ..]
  // wouldn't type-check.
  const arrayParams = op.queryParams.filter(
    (p) => !hidden.has(p.name) && !groupedNames.has(p.name) && isStringArrayParam(p),
  );
  if (arrayParams.length === 0) return null;
  const target = arrayParams[0];

  // The encoded form for both variants. The test inspects the literal query
  // string returned by wiremock; `assert!(query.contains(...))` matches the
  // serialized output regardless of where in the string the param sits, so
  // we don't need to predict the rest of the params' order.
  const exploded = (target as { explode?: boolean }).explode !== false;
  const expectedFragment = exploded ? `${target.name}=foo&${target.name}=bar` : `${target.name}=foo%2Cbar`;

  // For the call, we want to set `target` to ["foo", "bar"] on the params
  // struct. Build the standard call args, then mutate the params struct to
  // override the field.
  const callArgs = buildCallArgs(op, resolved, crate, accessor, modelMap, enumMap);
  // Locate which entry in callArgs is the params struct so we can mutate it
  // post-construction. The buildCallArgs result is:
  //   path_arg_1, path_arg_2, ..., paramsExpr, [token]
  // Path args are always `"test_id"` literals; the params expr is the first
  // entry past the path arg count.
  const pathArgCount = op.pathParams.length;
  const tokenName = bearerOverrideTokenName(op);
  const expectsParams = callArgs.length > pathArgCount && (tokenName ? callArgs.length > pathArgCount + 1 : true);
  if (!expectsParams) return null;

  // Build the test body. We materialise the params as a mutable local so we
  // can set the target array field, then pass it (by value) to the SDK call.
  const tokenArg = tokenName ? callArgs[callArgs.length - 1] : null;
  const paramsExpr = callArgs[pathArgCount];

  const lines: string[] = [];
  const respExpr = encodingResponseExpr(op, modelMap, enumMap);
  lines.push('#[tokio::test]');
  lines.push(`async fn ${accessor}_${methodName(resolved.methodName)}_encodes_query_params() {`);
  lines.push('    let server = MockServer::start().await;');
  lines.push(`    Mock::given(method(${JSON.stringify('GET'.replace('GET', op.httpMethod.toUpperCase()))}))`);
  lines.push(`        .and(path_matcher(${JSON.stringify(op.path.replace(/\{[^}]+\}/g, 'test_id'))}))`);
  lines.push(`        .respond_with(ResponseTemplate::new(200).set_body_string(${respExpr}))`);
  lines.push('        .mount(&server)');
  lines.push('        .await;');
  lines.push('    let client = common::test_client(&server).await;');
  // Clippy's `field_reassign_with_default` fires when fields are mutated on a
  // value created via `T::default()`. Use struct-update syntax in that case;
  // otherwise (`Type::new(...)` etc.), fall back to the mutable-binding form
  // since the lint doesn't apply.
  if (paramsExpr.endsWith('::default()')) {
    const ty = paramsExpr.slice(0, -'::default()'.length);
    lines.push(`    let params = ${ty} {`);
    lines.push(`        ${fieldIdent(target.name)}: Some(vec!["foo".to_string(), "bar".to_string()]),`);
    lines.push('        ..Default::default()');
    lines.push('    };');
  } else {
    lines.push(`    let mut params = ${paramsExpr};`);
    lines.push(`    params.${fieldIdent(target.name)} = Some(vec!["foo".to_string(), "bar".to_string()]);`);
  }
  // Drop the array param onto the params; ignore any required-cursor fields
  // — they're already populated by buildCallArgs.
  const passArgs: string[] = [];
  for (let i = 0; i < pathArgCount; i++) passArgs.push(callArgs[i]);
  passArgs.push('params');
  if (tokenArg) passArgs.push(tokenArg);
  lines.push(`    let _ = client.${accessor}().${methodName(resolved.methodName)}(${passArgs.join(', ')}).await;`);
  lines.push('    let received = server.received_requests().await.expect("recorded requests");');
  lines.push('    let request = received.first().expect("at least one request");');
  lines.push('    let query = request.url.query().unwrap_or("");');
  lines.push(
    `    assert!(query.contains(${JSON.stringify(expectedFragment)}), "expected query to contain {:?}, got {:?}", ${JSON.stringify(expectedFragment)}, query);`,
  );
  lines.push('}');
  return lines;
}

/** Body expression for the encoding-test response (success, ignored). */
function encodingResponseExpr(op: Operation, modelMap: Map<string, Model>, enumMap: Map<string, Enum>): string {
  // For paginated ops we serve an empty page so the call succeeds. Use the
  // bare-array shape for `Vec<T>` responses, the wrapper shape otherwise.
  if (op.pagination) {
    if (op.response.kind === 'array') return JSON.stringify('[]');
    return JSON.stringify('{"object":"list","data":[],"list_metadata":{"before":null,"after":null}}');
  }
  return responseBodyExpr(op.response, modelMap, enumMap);
}

/**
 * True if `param.type` is `Vec<String>` (or `Option<Vec<String>>`). Restricts
 * the encoding test to string arrays because non-string arrays would need
 * per-type constructors we can't synthesise reliably.
 */
function isStringArrayParam(p: Parameter): boolean {
  let t: TypeRef = p.type;
  while (t.kind === 'nullable') t = t.inner;
  if (t.kind !== 'array') return false;
  let inner: TypeRef = t.items;
  while (inner.kind === 'nullable') inner = inner.inner;
  return inner.kind === 'primitive' && inner.type === 'string';
}

/** Snake-case field accessor matching the resources emitter's naming. */
function fieldIdent(name: string): string {
  // The Rust emitter snake-cases field names via `methodName`. Reuse it so
  // the generated field name matches the params struct.
  return methodName(name);
}

/** True for HTTP methods that mutate state and should retry-defensively. */
function isWriteMethod(method: string): boolean {
  return method !== 'get' && method !== 'head';
}

/** True when the op has at least one body-side parameter group. */
function hasBodyParameterGroup(op: Operation): boolean {
  const queryNames = new Set(op.queryParams.map((p) => p.name));
  return (op.parameterGroups ?? []).some((g) =>
    g.variants.every((v) => v.parameters.every((p) => !queryNames.has(p.name))),
  );
}

/** Pick the snake_case token-arg name for an op with a non-bearer security override. */
function bearerOverrideTokenName(op: Operation): string | null {
  const override = op.security?.find((s) => s.schemeName !== 'bearerAuth');
  if (!override) return null;
  return override.schemeName.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`).replace(/^_/, '');
}

/**
 * Construct a synthetic body type via its `new(...)` constructor. The
 * resources emitter passes required flat fields and required flatten enums
 * positionally; mirror that ordering here so the stub compiles against the
 * generated `impl <Type> { fn new(...) }`.
 */
function syntheticBodyStubExpr(
  op: Operation,
  resolved: ResolvedOperation,
  crate: string,
  accessor: string,
  modelMap: Map<string, Model>,
): string {
  const bodyRef = op.requestBody!;
  const bodyName = `${typeName(resolved.methodName)}ParamsBody`;
  const fqn = `${crate}::${accessor}::${bodyName}`;
  const model = bodyRef.kind === 'model' ? (modelMap.get(bodyRef.name) ?? null) : null;
  const queryNames = new Set(op.queryParams.map((p) => p.name));
  const bodyGroupNames = new Set<string>();
  for (const g of op.parameterGroups ?? []) {
    if (g.variants.every((v) => v.parameters.every((p) => !queryNames.has(p.name)))) {
      for (const v of g.variants) for (const p of v.parameters) bodyGroupNames.add(p.name);
    }
  }
  // Iteration order must match resources.ts: required flat model fields, then
  // each parameter-group field (in the order returned by `op.parameterGroups`).
  const args: string[] = [];
  if (model) {
    for (const f of model.fields) {
      if (bodyGroupNames.has(f.name)) continue;
      const isRequired = !!f.required && f.type.kind !== 'nullable';
      if (!isRequired) continue;
      args.push(`${JSON.stringify(`stub_${f.name}`)}.to_string()`);
    }
  }
  for (const g of op.parameterGroups ?? []) {
    const isBodyGroup = g.variants.every((v) => v.parameters.every((p) => !queryNames.has(p.name)));
    if (!isBodyGroup) continue;
    if (g.optional) continue;
    args.push(parameterGroupStubExpr(g, crate, accessor));
  }
  return `${fqn}::new(${args.join(', ')})`;
}

/** First-variant stub for a parameter-group enum, fully crate-qualified. */
function parameterGroupStubExpr(
  group: import('@workos/oagen').ParameterGroup,
  crate: string,
  accessor: string,
): string {
  const enumName = group.name
    .split('_')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
  const firstVariant = group.variants[0];
  const variantName = firstVariant.name
    .split('_')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
  const fqn = `${crate}::${accessor}::${enumName}`;
  if (firstVariant.parameters.length === 0) return `${fqn}::${variantName}`;
  const fields = firstVariant.parameters
    .map((p) => `${p.name}: ${JSON.stringify(`stub_${p.name}`)}.to_string()`)
    .join(', ');
  return `${fqn}::${variantName} { ${fields} }`;
}

/** Test for a wrapper-method operation. */
function renderWrapperTest(
  op: Operation,
  wrapper: ResolvedWrapper,
  ctx: EmitterContext,
  accessor: string,
  crate: string,
  modelMap: Map<string, Model>,
  enumMap: Map<string, Enum>,
): string[] {
  const m = methodName(wrapper.name);
  const literalPath = op.path.replace(/\{[^}]+\}/g, 'test_id');
  const httpMethod = op.httpMethod.toUpperCase();
  // Wrapper response is the wrapper's responseModelName (or the operation's
  // declared response when none is overridden).
  const responseExpr = wrapper.responseModelName
    ? responseBodyExpr({ kind: 'model', name: wrapper.responseModelName }, modelMap, enumMap)
    : responseBodyExpr(op.response, modelMap, enumMap);

  const params = resolveWrapperParams(wrapper, ctx);
  const callArgs: string[] = [];
  for (const _ of op.pathParams) callArgs.push('"test_id"');

  const paramsType = `${crate}::${accessor}::${typeName(wrapper.name)}Params`;
  const requiredParams = params.filter((rp) => !rp.isOptional);

  if (requiredParams.length === 0) {
    callArgs.push(`${paramsType}::default()`);
  } else {
    const ctorArgs = requiredParams.map((rp) => {
      if (!rp.field) return `"stub_${rp.paramName}".to_string()`;
      return stubExpr(rp.field.type, rp.paramName, modelMap, enumMap);
    });
    callArgs.push(`${paramsType}::new(${ctorArgs.join(', ')})`);
  }

  const callArgsStr = callArgs.join(', ');

  const lines: string[] = [];
  lines.push('#[tokio::test]');
  lines.push(`async fn ${accessor}_${m}_round_trip() {`);
  lines.push('    let server = MockServer::start().await;');
  lines.push(`    Mock::given(method(${JSON.stringify(httpMethod)}))`);
  lines.push(`        .and(path_matcher(${JSON.stringify(literalPath)}))`);
  lines.push(`        .respond_with(ResponseTemplate::new(200).set_body_string(${responseExpr}))`);
  lines.push('        .expect(1)');
  lines.push('        .mount(&server)');
  lines.push('        .await;');
  lines.push('    let client = common::test_client(&server).await;');
  lines.push(`    let _ = client.${accessor}().${m}(${callArgsStr}).await;`);
  // Drop assertion on `Mock::expect(1)` validates path/method.
  lines.push('}');

  // Error tests for wrapper variants — same path/method, different response.
  const shape: CallShape = {
    methodIdent: m,
    literalPath,
    httpMethod,
    callArgs: callArgsStr,
    isUrlBuilder: false,
    isWrite: isWriteMethod(op.httpMethod),
    isPaginated: !!op.pagination,
    hasBodyGroup: false,
  };
  for (const errTest of standardErrorTests(shape, accessor)) {
    lines.push('');
    lines.push(...errTest);
  }
  if (shape.isWrite) {
    for (const errTest of writeErrorTests(shape, accessor)) {
      lines.push('');
      lines.push(...errTest);
    }
  }

  return lines;
}

/** Rust string-expression for the mock response body. */
function responseBodyExpr(ref: TypeRef | undefined, modelMap: Map<string, Model>, enumMap: Map<string, Enum>): string {
  if (!ref) return JSON.stringify('{}');
  if (ref.kind === 'primitive' && ref.type === 'unknown') return JSON.stringify('{}');
  if (ref.kind === 'model') {
    const m = modelMap.get(ref.name);
    if (!m || m.fields.length === 0 || m.fields.every((f) => !f.required)) {
      return JSON.stringify('{}');
    }
    return modelFixtureExpr(ref.name);
  }
  if (ref.kind === 'nullable') return responseBodyExpr(ref.inner, modelMap, enumMap);
  // For arrays/primitives/maps/enums/literals/unions, synthesise inline JSON.
  const example = exampleFor(ref, modelMap, enumMap, new Set(), 'value');
  return JSON.stringify(JSON.stringify(example));
}

/** `include_str!("fixtures/<snake>.json")` for a model name. */
function modelFixtureExpr(name: string): string {
  return `include_str!(${JSON.stringify(`fixtures/${moduleName(name)}.json`)})`;
}

/**
 * Rust expression for an instance of `type` that satisfies its declared shape.
 * Used to construct required constructor arguments at test-build time.
 *
 * For models we deserialize a JSON fixture; for everything else we synthesise
 * a small example with `serde_json::from_str`. `String` is the one exception:
 * the generator's `new(...)` constructor takes `impl Into<String>`, so we
 * pass a string literal directly to keep type inference happy.
 */
function stubExpr(ref: TypeRef, hint: string, modelMap: Map<string, Model>, enumMap: Map<string, Enum>): string {
  // Strings: emit `"stub_x".to_string()`. Works in struct-literal contexts
  // (which need `String`) as well as `new(...)` constructors that take
  // `impl Into<String>`. Avoiding `from_str` keeps type inference simple.
  if (ref.kind === 'primitive' && ref.type === 'string') {
    return `${JSON.stringify(`stub_${hint}`)}.to_string()`;
  }
  if (ref.kind === 'nullable') return stubExpr(ref.inner, hint, modelMap, enumMap);
  if (ref.kind === 'model') {
    // Fixture generator skips models with no required fields; fall back to
    // an inline `{}` so the test still compiles.
    const m = modelMap.get(ref.name);
    if (!m || m.fields.length === 0 || m.fields.every((f) => !f.required)) {
      return `serde_json::from_str("{}").expect("parse stub for ${ref.name}")`;
    }
    return `serde_json::from_str(${modelFixtureExpr(ref.name)}).expect("parse fixture for ${ref.name}")`;
  }
  // For other shapes, JSON-serialise an example value and deserialise at
  // runtime. The generator's constructors fully specify each parameter type,
  // so type inference flows from the constructor signature back into
  // `serde_json::from_str`.
  const example = exampleFor(ref, modelMap, enumMap, new Set(), hint);
  const json = JSON.stringify(example);
  return `serde_json::from_str(${JSON.stringify(json)}).expect("parse stub")`;
}

function crateName(ctx: EmitterContext): string {
  // Cargo crate names are conventionally lowercase with no separators (e.g.
  // `workos`). The IR's snake-cased namespace ("work_os") inserts an
  // underscore around the "os" acronym, so derive from `namespacePascal` —
  // the verbatim user-supplied namespace — and lowercase it.
  return ctx.namespacePascal.toLowerCase().replace(/[^a-z0-9]/g, '');
}
