import { afterEach, expect, it, vi } from 'vitest';
import { parseSpec, type EmitterContext } from '@workos/oagen';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { UnionRegistry } from '../../src/rust/type-map.js';

const fixture = resolve('test/fixtures/pipes-request-contracts.json');
afterEach(() => vi.unstubAllEnvs());

async function generate(specPath = fixture) {
  vi.resetModules();
  vi.stubEnv('OPENAPI_SPEC_PATH', specPath);
  const spec = await parseSpec(specPath);
  const ctx: EmitterContext = { namespace: 'workos', namespacePascal: 'WorkOS', spec };
  const { generateModels } = await import('../../src/rust/models.js');
  const files = generateModels(spec.models, ctx, new UnionRegistry());
  return { spec, ctx, files, generateModels };
}

it('recovers closed request variants from raw schemas after parseSpec drops additionalProperties', async () => {
  const { files, spec } = await generate();
  const op = spec.services.flatMap((s) => s.operations).find((o) => o.name === 'putApiKey')!;
  expect(op.requestBody?.kind).toBe('union');
  const closed = files.filter((f) => f.content.includes('#[serde(deny_unknown_fields)]'));
  expect(closed).toHaveLength(6);
  for (const file of closed) expect(file.path).not.toContain('response');
  expect(files.find((f) => f.path.endsWith('reauthorize_put_api_key_request.rs'))?.content).toContain(
    'deserialize_connection_intent',
  );
  expect(files.find((f) => f.path.endsWith('post_api_key_request.rs'))?.content).toContain(
    'serialize_connection_intent',
  );
});

it('does not impose request-only restrictions on response-shared models', async () => {
  const { spec, ctx, generateModels } = await generate();
  const op = spec.services.flatMap((s) => s.operations).find((o) => o.name === 'putApiKey')!;
  if (op.requestBody?.kind !== 'union') throw new Error('missing request union');
  op.response = op.requestBody.variants[0];
  const files = generateModels(spec.models, ctx, new UnionRegistry());
  expect(files.find((f) => f.path.endsWith('/put_api_key_request.rs'))?.content).not.toContain('deny_unknown_fields');
});

it('does not emit closed-object restrictions for open request variants', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rust-request-schema-'));
  try {
    const raw = readFileSync(fixture, 'utf8');
    expect(raw).toContain('"additionalProperties": false');
    const input = join(dir, 'spec.json');
    writeFileSync(input, raw.replaceAll('"additionalProperties": false', '"additionalProperties": true'));
    const { files } = await generate(input);
    for (const file of files) expect(file.content).not.toContain('#[serde(deny_unknown_fields)]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
