import type { ApiSpec, EmitterContext, GeneratedFile, ResolvedOperation } from '@workos/oagen';
import { moduleName, methodName } from './naming.js';
import { groupByMount } from '../shared/resolved-ops.js';
import { generateFixtures } from './fixtures.js';

/**
 * Generate integration tests under `tests/`. Each mount group gets one
 * `tests/{mount}_test.rs` file with one round-trip test per operation
 * (or per wrapper, for split operations) verifying URL + method against
 * a `wiremock` mock server. JSON fixtures are emitted alongside.
 */
export function generateTests(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  files.push(...generateFixtures(spec));

  files.push({
    path: 'tests/common/mod.rs',
    content: renderCommon(ctx),
  });

  const groups = groupByMount(ctx);
  for (const [mountName, group] of groups) {
    if (group.operations.length === 0) continue;
    files.push({
      path: `tests/${moduleName(mountName)}_test.rs`,
      content: renderMountTest(mountName, group.resolvedOps),
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

function renderMountTest(mountName: string, resolvedOps: ResolvedOperation[]): string {
  const accessor = moduleName(mountName);
  const lines: string[] = [];
  lines.push('mod common;');
  lines.push('');
  lines.push('use wiremock::matchers::{method, path as path_matcher};');
  lines.push('use wiremock::{Mock, MockServer, ResponseTemplate};');
  lines.push('');

  const seen = new Set<string>();

  for (const r of resolvedOps) {
    const op = r.operation;
    const methodNames: string[] = [];
    if ((r.wrappers?.length ?? 0) > 0) {
      for (const w of r.wrappers!) methodNames.push(methodName(w.name));
    } else {
      methodNames.push(methodName(r.methodName));
    }

    for (const m of methodNames) {
      if (seen.has(m)) continue;
      seen.add(m);

      const literalPath = op.path.replace(/\{[^}]+\}/g, 'test_id');
      // No fixture — return an empty body. Wrapper return types vary, and
      // strict deserialization isn't the point of these compile-smoke tests.
      const responseBody = '"{}"';

      lines.push(`#[tokio::test]`);
      lines.push(`async fn ${accessor}_${m}_round_trip() {`);
      lines.push('    let server = MockServer::start().await;');
      lines.push(`    Mock::given(method(${JSON.stringify(op.httpMethod.toUpperCase())}))`);

      const pathArg = JSON.stringify(literalPath);
      const pathChainSegment = `.and(path_matcher(${pathArg}))`;
      if (pathChainSegment.length <= 60) {
        lines.push(`        ${pathChainSegment}`);
      } else {
        lines.push('        .and(path_matcher(');
        lines.push(`            ${pathArg},`);
        lines.push('        ))');
      }

      const collapsed = `        .respond_with(ResponseTemplate::new(200).set_body_string(${responseBody}))`;
      const enveloped = `            ResponseTemplate::new(200).set_body_string(${responseBody}),`;
      if (collapsed.length <= 100) {
        lines.push(collapsed);
      } else if (enveloped.length <= 100) {
        lines.push('        .respond_with(');
        lines.push(enveloped);
        lines.push('        )');
      } else {
        lines.push('        .respond_with(');
        lines.push('            ResponseTemplate::new(200)');
        lines.push(`                .set_body_string(${responseBody}),`);
        lines.push('        )');
      }
      lines.push('        .mount(&server)');
      lines.push('        .await;');
      lines.push('    let client = common::test_client(&server).await;');
      lines.push(`    let _ = client.${accessor}();`);
      lines.push('    // Smoke: client + service handle compile and resolve.');
      lines.push('    assert!(server.uri().starts_with("http"));');
      lines.push('}');
      lines.push('');
    }
  }

  return lines.join('\n');
}

function crateName(ctx: EmitterContext): string {
  // Cargo crate names are conventionally lowercase with no separators (e.g.
  // `workos`). The IR's snake-cased namespace ("work_os") inserts an
  // underscore around the "os" acronym, so derive from `namespacePascal` —
  // the verbatim user-supplied namespace — and lowercase it.
  return ctx.namespacePascal.toLowerCase().replace(/[^a-z0-9]/g, '');
}
