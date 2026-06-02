#!/usr/bin/env node
/**
 * Smoke test for snippet emitters against a real OpenAPI spec.
 *
 * Usage:
 *   node scripts/smoke-snippets.mjs <path-to-spec> [language]
 *
 * Prints the first 3 generated snippets to stdout for visual inspection.
 * Not part of `npm test`; intended for ad-hoc validation against the WorkOS
 * spec in https://github.com/workos/openapi-spec.
 */
import { parseSpec, resolveOperations } from '@workos/oagen';
import { runSnippetEmitters, workosSnippetsPlugin } from '../dist/index.mjs';

const specPath = process.argv[2];
const langFilter = process.argv[3];
if (!specPath) {
  console.error('Usage: smoke-snippets.mjs <spec.yaml> [language]');
  process.exit(1);
}

const spec = await parseSpec(specPath);
const resolvedOperations = resolveOperations(spec);

const ctx = {
  namespace: 'workos',
  namespacePascal: 'WorkOS',
  spec,
  resolvedOperations,
};

const emitters = langFilter
  ? workosSnippetsPlugin.snippets.filter((e) => e.language === langFilter)
  : workosSnippetsPlugin.snippets;

if (emitters.length === 0) {
  console.error(`No snippet emitter for language: ${langFilter}`);
  process.exit(1);
}

const results = runSnippetEmitters(emitters, ctx);
console.log(`Generated ${results.length} snippets across ${emitters.length} languages.\n`);

for (const r of results.slice(0, 3)) {
  console.log(`---- ${r.language} / ${r.operationId} (${r.fileExtension}) ----`);
  console.log(r.content);
}
