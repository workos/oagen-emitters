import { afterEach, expect, it, vi } from 'vitest';
import { parseSpec, type EmitterContext, type GeneratedFile } from '@workos/oagen';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { UnionRegistry } from '../../src/rust/type-map.js';
import { generateEnums } from '../../src/rust/enums.js';
import { typeName } from '../../src/rust/naming.js';

const fixture = resolve('test/fixtures/pipes-request-contracts.json');
afterEach(() => vi.unstubAllEnvs());

async function generate(specPath = fixture) {
  vi.resetModules();
  vi.stubEnv('OPENAPI_SPEC_PATH', specPath);
  const spec = await parseSpec(specPath);
  const ctx: EmitterContext = { namespace: 'workos', namespacePascal: 'WorkOS', spec };
  const { generateModels } = await import('../../src/rust/models.js');
  const registry = new UnionRegistry();
  const files = generateModels(spec.models, ctx, registry);
  const unionTypes = new Map<string, string>();
  for (const service of spec.services) {
    for (const op of service.operations) {
      if (op.requestBody?.kind === 'union') unionTypes.set(op.name, registry.register(op.requestBody, op.name));
    }
  }
  files.push(...generateEnums(spec.enums, ctx));
  files.push({ path: 'src/models/_unions.rs', content: registry.render() });
  return { spec, ctx, files, unionTypes, generateModels };
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

// Offline opt-in: uses only cached serde/serde_json, never downloads dependencies.
// OAGEN_RUN_RUST_REQUEST_TESTS=1 npm test -- test/rust/request-contract.test.ts
it.skipIf(process.env.OAGEN_RUN_RUST_REQUEST_TESTS !== '1')(
  'round-trips generated Rust request unions without changing legacy, explicit, or implicit targets; open unions remain open',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rust-request-contract-'));
    try {
      const raw = JSON.parse(readFileSync(fixture, 'utf8'));
      raw.paths['/open'] = {
        post: {
          operationId: 'openUnion',
          tags: ['pipes'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
                    { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] },
                  ],
                },
              },
            },
          },
          responses: { 204: { description: 'OK' } },
        },
      };
      const input = join(dir, 'spec.json');
      writeFileSync(input, JSON.stringify(raw));
      const { spec, files, unionTypes } = await generate(input);
      const write = (file: GeneratedFile) => {
        const path = join(dir, file.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, file.content);
      };
      for (const file of files) write(file);
      writeFileSync(
        join(dir, 'Cargo.toml'),
        '[package]\nname = "request-contract"\nversion = "0.0.0"\nedition = "2021"\n[dependencies]\nserde = { version = "1", features = ["derive"] }\nserde_json = "1"\n',
      );
      const apiUnion = unionTypes.get('putApiKey');
      const clientUnion = unionTypes.get('putClientCredentials');
      const create = spec.services.flatMap((s) => s.operations).find((o) => o.name === 'postApiKey')!.requestBody!;
      if (create.kind !== 'model') throw new Error('missing creation body');
      write({
        path: 'src/lib.rs',
        content: `pub type SecretString = String;
pub mod enums;
pub mod models;
#[cfg(test)] mod tests {
    use super::models::*;
    use serde::{Serialize, de::DeserializeOwned};
    use serde_json::{json, Value};
    fn round_trip<T: Serialize + DeserializeOwned>(body: Value) {
        let parsed: T = serde_json::from_value(body.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), body);
    }
    #[test] fn requests() {
        for selectors in [json!({}), json!({"connected_account_id":"data_installation_test"}), json!({"connected_account_id":"data_installation_test","connection_intent":"reauthorize"})] {
            let mut api = json!({"user_id":"user_test","secret":"sk_test"});
            api.as_object_mut().unwrap().extend(selectors.as_object().unwrap().clone());
            round_trip::<${apiUnion}>(api);
            let mut client = json!({"user_id":"user_test","client_id":"client_test","client_secret":"secret_test"});
            client.as_object_mut().unwrap().extend(selectors.as_object().unwrap().clone());
            round_trip::<${clientUnion}>(client);
        }
        for body in [json!({"user_id":"u","secret":"s","connection_intent":"reauthorize"}), json!({"user_id":"u","secret":"s","connection_intent":"wrong","connected_account_id":"data_installation_test"}), json!({"user_id":"u","secret":"s","extra":"not_allowed"})] {
            assert!(serde_json::from_value::<${apiUnion}>(body).is_err());
        }
        let creation = json!({"user_id":"u","secret":"s","connection_intent":"add"});
        round_trip::<${typeName(create.name)}>(creation.clone());
        let mut invalid: ${typeName(create.name)} = serde_json::from_value(creation).unwrap();
        invalid.connection_intent = "wrong".to_string();
        assert!(serde_json::to_value(invalid).is_err());
        assert!(serde_json::from_value::<${unionTypes.get('openUnion')}>(json!({"value":"kept","extra":"accepted"})).is_ok());
    }
}
`,
      });
      const result = execFileSync(
        'cargo',
        ['test', '--offline', '--quiet', '--manifest-path', join(dir, 'Cargo.toml')],
        { encoding: 'utf8', timeout: 120000 },
      );
      expect(result).toContain('1 passed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  120000,
);
