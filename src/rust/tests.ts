import type {
  ApiSpec,
  EmitterContext,
  Enum,
  GeneratedFile,
  Model,
  Operation,
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
 * `tests/{mount}_test.rs` file. Generated tests construct params, mock the
 * expected request, then call the SDK method and assert the request was sent
 * (`Mock::expect(1)`). JSON fixtures are emitted alongside.
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

  const hidden = new Set<string>([...Object.keys(resolved.defaults ?? {}), ...(resolved.inferFromClient ?? [])]);
  const visibleQuery = op.queryParams.filter((p) => !hidden.has(p.name));
  const visibleHeader = op.headerParams.filter((p) => !hidden.has(p.name));
  const visibleParams = [...visibleQuery, ...visibleHeader];
  const requiredParams = visibleParams.filter((p) => p.required);
  const hasBody = op.requestBody !== undefined;
  const bodyRequired = hasBody && op.requestBody!.kind !== 'nullable';
  const emptyParams = !hasBody && visibleParams.length === 0;

  const callArgs: string[] = [];
  for (const _ of op.pathParams) callArgs.push('"test_id"');

  if (!emptyParams) {
    const paramsType = `${crate}::${accessor}::${typeName(resolved.methodName)}Params`;
    if (requiredParams.length === 0 && !bodyRequired) {
      callArgs.push(`${paramsType}::default()`);
    } else {
      const ctorArgs: string[] = [];
      for (const p of requiredParams) {
        ctorArgs.push(stubExpr(p.type, p.name, modelMap, enumMap));
      }
      if (hasBody) {
        if (bodyRequired) {
          ctorArgs.push(stubExpr(op.requestBody!, 'body', modelMap, enumMap));
        }
      }
      callArgs.push(`${paramsType}::new(${ctorArgs.join(', ')})`);
    }
  }

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
  lines.push(`    let _ = client.${accessor}().${m}(${callArgs.join(', ')}).await;`);
  // wiremock asserts on drop that the `.expect(1)` mock was matched once;
  // mismatched method/path produces a panic at end-of-test. We deliberately
  // ignore the deserialised response: stub fixtures cover the common path
  // (typed model deserialisation), but discriminated-union responses can't
  // always be reproduced from a generated fixture without bespoke schema
  // awareness, so a strict `is_ok()` would over-trigger.
  lines.push('}');
  return lines;
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
  lines.push(`    let _ = client.${accessor}().${m}(${callArgs.join(', ')}).await;`);
  // Drop assertion on `Mock::expect(1)` validates path/method.
  lines.push('}');
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
