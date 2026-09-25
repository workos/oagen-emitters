import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

const available = (runtime: string) => spawnSync(runtime, [runtime === 'go' ? 'version' : '--version']).status === 0;

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

  it.skipIf(!available('python3'))(
    'executes generated Python round trips without inventing nullable variant fields',
    () => {
      const root = join(dir, 'python');
      for (const file of output.python.filter((f) => f.path.endsWith('.py') && !f.path.endsWith('__init__.py'))) {
        const path = join(root, file.path.replace(/^src\//, ''));
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, file.content);
      }
      // Same _types sentinel contract used by generated request resources.
      writeFileSync(
        join(root, 'workos/_types.py'),
        `class NotGiven:\n    pass\nNOT_GIVEN = NotGiven()\ndef _raise_deserialize_error(name, error):\n    raise ValueError(name) from error\n`,
      );
      const file = output.python.find((f) => f.path.endsWith('/data_integration_vended_credential.py'))!;
      const module = file.path
        .replace(/^src\//, '')
        .replace(/\.py$/, '')
        .replaceAll('/', '.');
      const script = `from ${module} import DataIntegrationVendedCredential as Credential
from workos._types import NOT_GIVEN
base = {"object": "credential", "value": "fake-secret", "config": {"account": "tenant"}}
api_key = dict(base, auth_method="api_key")
parsed = Credential.from_dict(api_key)
assert parsed.to_dict() == api_key, parsed.to_dict()
assert parsed.expires_at is NOT_GIVEN
for method in ["oauth", "client_credentials"]:
    for expiry in [None, "2025-12-31T23:59:59Z"]:
        payload = dict(base, auth_method=method, expires_at=expiry, scopes=[], missing_scopes=[])
        if method == "client_credentials":
            payload["metadata"] = {"instance_url": "https://example.test"}
        assert Credential.from_dict(payload).to_dict() == payload
# Constructor omission and an explicit None must remain distinct too.
assert Credential(**api_key).to_dict() == api_key
assert Credential(**api_key, expires_at=None).to_dict() == dict(api_key, expires_at=None)
for field in ["auth_method", "value", "config"]:
    missing = dict(api_key)
    del missing[field]
    try:
        Credential.from_dict(missing)
    except ValueError:
        pass
    else:
        raise AssertionError("accepted missing " + field)
print("credential response round trips passed")
`;
      expect(execFileSync('python3', ['-c', script], { cwd: root, encoding: 'utf8' })).toContain('round trips passed');
    },
  );

  it.skipIf(!available('go'))('compiles the generated Go credential with value-typed common fields', () => {
    const root = join(dir, 'go');
    mkdirSync(root);
    writeFileSync(join(root, 'go.mod'), 'module responsecontract\n\ngo 1.22\n');
    for (const file of output.go) writeFileSync(join(root, file.path), file.content);
    // Enum emission shares the model package and is needed by the outer response.
    for (const file of goEmitter.generateEnums(spec.enums, ctx) as GeneratedFile[])
      writeFileSync(join(root, file.path), file.content);
    writeFileSync(
      join(root, 'response_test.go'),
      `package workos
import ("encoding/json"; "testing")
func TestCredential(t *testing.T) {
    for _, method := range []string{"oauth", "api_key", "client_credentials"} {
        raw := []byte("{\\"object\\":\\"credential\\",\\"auth_method\\":\\"" + method + "\\",\\"value\\":\\"fake-secret\\",\\"config\\":{}}")
        var credential DataIntegrationVendedCredential
        if err := json.Unmarshal(raw, &credential); err != nil { t.Fatal(err) }
        var value string = credential.Value
        var authMethod string = credential.AuthMethod
        if value != "fake-secret" || authMethod != method { t.Fatalf("lost credential: %#v", credential) }
    }
}
`,
    );
    expect(execFileSync('go', ['test', './...'], { cwd: root, encoding: 'utf8', timeout: 60000 })).toContain('ok');
  });
});
