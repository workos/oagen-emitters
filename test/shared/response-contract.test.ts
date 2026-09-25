import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseSpec, resolveOperations, type ApiSpec, type EmitterContext, type GeneratedFile } from '@workos/oagen';
import { enrichModelsFromSpec } from '../../src/shared/model-utils.js';
import { pythonEmitter } from '../../src/python/index.js';
import { goEmitter } from '../../src/go/index.js';
import { dotnetEmitter } from '../../src/dotnet/index.js';
import { kotlinEmitter } from '../../src/kotlin/index.js';
import { iosEmitter } from '../../src/ios/index.js';
import { phpEmitter } from '../../src/php/index.js';
import { rubyEmitter } from '../../src/ruby/index.js';
import { rustEmitter } from '../../src/rust/index.js';

// Reduced from workos/openapi-spec@0b0182d195a272be7528ca26c0ca7f936c8f789f.
// All credential branch fields/constraints retained; descriptions/examples omitted.
const fixture = resolve('test/fixtures/pipes-response-contracts.json');
let spec: ApiSpec;
let ctx: EmitterContext;
let dir: string;
const previousSpecPath = process.env.OPENAPI_SPEC_PATH;
const output: Record<string, GeneratedFile[]> = {};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'response-contract-'));
  const raw = JSON.parse(readFileSync(fixture, 'utf8'));
  raw.components.schemas.ComposedChoice = {
    allOf: [
      { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      {
        oneOf: [
          {
            type: 'object',
            properties: { shared: { type: 'string' }, sometimes: { type: 'string' }, left: { type: 'string' } },
            required: ['shared', 'sometimes', 'left'],
          },
          {
            type: 'object',
            properties: { shared: { type: 'string' }, sometimes: { type: 'string' }, right: { type: 'string' } },
            required: ['shared'],
          },
        ],
      },
    ],
  };
  raw.components.schemas.ReferencedChoice = {
    oneOf: [
      { $ref: '#/components/schemas/ComposedChoice' },
      { type: 'object', properties: { id: { type: 'string' } } },
    ],
  };
  const specPath = join(dir, 'spec.json');
  writeFileSync(specPath, JSON.stringify(raw));
  process.env.OPENAPI_SPEC_PATH = specPath;
  spec = await parseSpec(specPath);
  ctx = { namespace: 'workos', namespacePascal: 'WorkOS', spec, resolvedOperations: resolveOperations(spec) };
  for (const emitter of [
    pythonEmitter,
    goEmitter,
    dotnetEmitter,
    kotlinEmitter,
    iosEmitter,
    phpEmitter,
    rubyEmitter,
    rustEmitter,
  ]) {
    output[emitter.language] = await emitter.generateModels(spec.models, ctx);
  }
});

afterAll(() => {
  if (previousSpecPath === undefined) delete process.env.OPENAPI_SPEC_PATH;
  else process.env.OPENAPI_SPEC_PATH = previousSpecPath;
  rmSync(dir, { recursive: true, force: true });
});

function credentialSource(language: string): string {
  return output[language]
    .filter((f) => /vended.?credential/i.test(f.path) || f.path === 'models.go')
    .map((f) => f.content)
    .join('\n');
}

describe('credential response union contracts', () => {
  it('widens all auth methods and preserves required-in-every-branch fields without mutating the IR', () => {
    const before = JSON.stringify(spec);
    const models = enrichModelsFromSpec(spec.models, spec.enums);
    const credential = models.find((m) => m.name === 'DataIntegrationVendedCredential')!;
    expect(credential.fields.filter((f) => f.required).map((f) => f.name)).toEqual([
      'object',
      'auth_method',
      'value',
      'config',
    ]);
    expect(credential.fields.find((f) => f.name === 'auth_method')?.type).toEqual({
      kind: 'union',
      variants: ['oauth', 'api_key', 'client_credentials'].map((value) => ({ kind: 'literal', value })),
    });
    expect(credential.fields.find((f) => f.name === 'config')?.type).toEqual({
      kind: 'map',
      valueType: { kind: 'primitive', type: 'string' },
    });
    expect(credential.fields.find((f) => f.name === 'metadata')?.type).toEqual({
      kind: 'map',
      valueType: { kind: 'primitive', type: 'unknown' },
    });
    expect(JSON.stringify(spec)).toBe(before);
    expect(enrichModelsFromSpec(models, spec.enums)).toEqual(models);
    const response = models.find((m) => m.name === 'DataIntegrationCredentialsResponse')!;
    expect(response.fields.find((f) => f.name === 'active')).toMatchObject({
      required: true,
      type: {
        kind: 'union',
        variants: [
          { kind: 'literal', value: true },
          { kind: 'literal', value: false },
        ],
      },
    });
  });

  it('intersects required fields across alternatives but retains required allOf base fields', () => {
    const models = enrichModelsFromSpec([{ name: 'ComposedChoice', fields: [] }]);
    expect(models[0].fields.map((f) => [f.name, f.required])).toEqual([
      ['id', true],
      ['shared', true],
      ['sometimes', false],
      ['left', false],
      ['right', false],
    ]);
  });

  it('leaves intentional dispatchers and reference-based unions untouched', () => {
    const field = { name: 'id', required: true, type: { kind: 'primitive', type: 'string' } } as const;
    const referenced = { name: 'ReferencedChoice', fields: [field] };
    const dispatcher = {
      name: 'DataIntegrationVendedCredential',
      fields: [field],
      discriminator: { property: 'kind', mapping: { a: 'A' } },
    };
    const restored = enrichModelsFromSpec([referenced, dispatcher]);
    expect(restored[0]).toBe(referenced);
    expect(restored[1]).toBe(dispatcher);
  });

  it('emits Python types covering all auth methods and Go required strings without pointers', () => {
    const python = credentialSource('python');
    for (const value of ['oauth', 'api_key', 'client_credentials']) expect(python).toContain(`Literal["${value}"]`);
    expect(python).toContain('    value: str\n');
    expect(python).toContain('    config: Dict[str, str]\n');
    const go = credentialSource('go');
    expect(go).toMatch(/Value string `json:"value"`/);
    expect(go).toMatch(/AuthMethod string `json:"auth_method"`/);
  });

  it.each(['dotnet', 'kotlin', 'ios', 'php', 'ruby', 'rust'])(
    '%s retains every credential response field',
    (language) => {
      const source = credentialSource(language);
      expect(source).not.toBe('');
      for (const field of ['auth_method', 'value', 'expires_at', 'scopes', 'missing_scopes', 'config', 'metadata']) {
        expect(source).toMatch(new RegExp(field.split('_').join('_?'), 'i'));
      }
      const requiredValue: Record<string, string> = {
        dotnet: 'public string Value { get; set; }',
        kotlin: 'val value: String,',
        ios: 'public let value: String\n',
        php: 'public string $value,',
        rust: 'pub value: crate::SecretString,',
      };
      if (requiredValue[language]) expect(source).toContain(requiredValue[language]);
    },
  );

  it('generates Python regression tests for both omitted and explicit-null optional fields', async () => {
    const files = await pythonEmitter.generateTests!(spec, ctx);
    const tests = files
      .filter((f) => f.path.includes('models_round_trip'))
      .map((f) => f.content)
      .join('\n');
    expect(tests).toContain('assert "expires_at" not in serialized');
    expect(tests).toContain('assert serialized["expires_at"] is None');
  });

  it('emits distinct Python omission and explicit-null serialization paths', () => {
    const source = credentialSource('python');
    expect(source).toContain('expires_at: Union[str, None, NotGiven] = NOT_GIVEN');
    expect(source).toContain('if "expires_at" in data else NOT_GIVEN');
    expect(source).toContain('if not isinstance(self.expires_at, NotGiven):');
    expect(source).toContain('result["expires_at"] = None');
  });
});
