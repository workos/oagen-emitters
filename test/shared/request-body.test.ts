import { beforeAll, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  parseSpec,
  resolveOperations,
  toSnakeCase,
  type ApiSpec,
  type EmitterContext,
  type Model,
} from '@workos/oagen';
import { resolveRequestBodyModel } from '../../src/shared/request-body.js';
import { generateResources as dotnet } from '../../src/dotnet/resources.js';
import { generateResources as go } from '../../src/go/resources.js';
import { generateResources as ios } from '../../src/ios/resources.js';
import { generateResources as kotlin } from '../../src/kotlin/resources.js';
import { generateResources as php } from '../../src/php/resources.js';
import { generateResources as python } from '../../src/python/resources.js';
import { generateResources as ruby } from '../../src/ruby/resources.js';
import { generateRbiFiles } from '../../src/ruby/rbi.js';
import { generateTests as phpTests } from '../../src/php/tests.js';
import { generateTests as goTests } from '../../src/go/tests.js';
import { generateTests as dotnetTests } from '../../src/dotnet/tests.js';
import { generateTests as kotlinTests } from '../../src/kotlin/tests.js';

// Reduced from workos/openapi-spec@0b0182d195a272be7528ca26c0ca7f936c8f789f:
// request schemas/constraints retained; prose and response schemas omitted.
const fixture = resolve('test/fixtures/pipes-request-contracts.json');
let spec: ApiSpec;
let ctx: EmitterContext;
const output: Record<string, string> = {};
beforeAll(async () => {
  spec = await parseSpec(fixture);
  ctx = {
    namespace: 'workos',
    namespacePascal: 'WorkOS',
    spec,
    resolvedOperations: resolveOperations(spec).map((r) => ({ ...r, methodName: toSnakeCase(r.operation.name) })),
  };
  for (const [lang, generate] of Object.entries({ dotnet, go, ios, kotlin, php, python, ruby })) {
    output[lang] = generate(spec.services, ctx)
      .filter((f) => f.path.toLowerCase().includes('pipes'))
      .map((f) => f.content)
      .join('\n');
  }
});

describe('request body field projection', () => {
  it('retains all complete branch fields without mutating models or requiring selectors for legacy requests', () => {
    const op = spec.services.flatMap((s) => s.operations).find((o) => o.name === 'putApiKey')!;
    expect(op.requestBody?.kind).toBe('union');
    const before = JSON.stringify(spec);
    const projected = resolveRequestBodyModel(op, spec.models)!;
    expect(projected.fields.map((f) => [f.name, f.required])).toEqual([
      ['user_id', true],
      ['organization_id', false],
      ['connection_owner', false],
      ['secret', true],
      ['connection_intent', false],
      ['connected_account_id', false],
    ]);
    expect(projected.fields.find((f) => f.name === 'connection_intent')?.type).toEqual({
      kind: 'literal',
      value: 'reauthorize',
    });
    expect(JSON.stringify(spec)).toBe(before);
  });

  it('does not project incompatible, unresolved, primitive, or discriminated unions', () => {
    const models: Model[] = [
      { name: 'A', fields: [{ name: 'value', required: true, type: { kind: 'primitive', type: 'string' } }] },
      { name: 'B', fields: [{ name: 'value', required: true, type: { kind: 'primitive', type: 'boolean' } }] },
    ];
    for (const variant of [
      { kind: 'model', name: 'B' },
      { kind: 'model', name: 'Missing' },
      { kind: 'primitive', type: 'string' },
    ] as const) {
      expect(
        resolveRequestBodyModel(
          { requestBody: { kind: 'union', variants: [{ kind: 'model', name: 'A' }, variant] } },
          models,
        ),
      ).toBeNull();
    }
    expect(
      resolveRequestBodyModel({ requestBody: { kind: 'nullable', inner: { kind: 'model', name: 'A' } } }, models),
    ).toBeNull();
    expect(
      resolveRequestBodyModel(
        {
          requestBody: {
            kind: 'union',
            discriminator: { property: 'kind', mapping: { a: 'A', b: 'B' } },
            variants: [
              { kind: 'model', name: 'A' },
              { kind: 'model', name: 'B' },
            ],
          },
        },
        models,
      ),
    ).toBeNull();
  });

  it.each(['dotnet', 'go', 'ios', 'kotlin', 'php', 'python', 'ruby'])(
    '%s exposes owner, credentials and both selectors',
    (lang) => {
      const source = output[lang];
      for (const field of ['user_id', 'secret', 'connection_intent', 'connected_account_id', 'client_secret']) {
        expect(source).toContain(
          lang === 'dotnet'
            ? field
                .split('_')
                .map((p) => p[0].toUpperCase() + p.slice(1))
                .join('')
            : field,
        );
      }
      expect(source).not.toContain('Body interface{}');
      if (lang === 'dotnet') expect(source).toContain('get => "add"');
      if (lang === 'kotlin') expect(source).toContain('connectionIntent: String = "add"');
      if (lang === 'ios') expect(source).toContain('connectionIntent: String = "add"');
      if (lang === 'python') expect(source).toContain('connection_intent: Literal["add"] = "add"');
    },
  );

  it('keeps Ruby RBI selectors and defaulted keywords in parity with runtime', () => {
    const rbi = generateRbiFiles(spec, ctx)
      .map((f) => f.content)
      .join('\n');
    expect(rbi).toContain('connected_account_id: T.nilable(String)');
    expect(rbi).toContain('connection_intent: T.nilable(String)');
    expect(rbi).toContain('connected_account_id: T.unsafe(nil)');
    expect(rbi).toContain('connection_intent: T.unsafe(nil)');
  });

  it('emits mixed PHP body/query transmission independently, preserving false and omitting only null', () => {
    const op = structuredClone(spec.services.flatMap((s) => s.operations).find((o) => o.name === 'postApiKey')!);
    op.queryParams = [
      { name: 'organization_id', type: { kind: 'primitive', type: 'string' }, required: false },
      { name: 'supports_multiple_connections', type: { kind: 'primitive', type: 'boolean' }, required: false },
    ];
    const services = [{ name: 'Mixed', operations: [op] }];
    const mixed = { ...spec, services };
    const source = php(services, { ...ctx, spec: mixed, resolvedOperations: resolveOperations(mixed) })[0].content;
    expect(source).toContain("'organization_id' => $organizationId");
    expect(source).toContain("'supports_multiple_connections' => $supportsMultipleConnections");
    expect(source).toContain('query: $query,');
    expect(source).toContain('body: $body,');
    expect(source.match(/fn \(\$v\) => \$v !== null/g)).toHaveLength(2);
  });

  it('seeds complete credential strings and asserts exact creation constants in generated tests', () => {
    const goSource = goTests(spec, ctx)
      .map((f) => f.content)
      .join('\n');
    expect(goSource).toContain('ClientSecret: "test_client_secret"');
    expect(goSource).toContain('ConnectionIntent: "add"');
    expect(goSource).toContain('require.Equal(t, "add", bodyMap["connection_intent"])');
    const csSource = dotnetTests(spec, ctx)
      .map((f) => f.content)
      .join('\n');
    expect(csSource).toContain('options.ClientSecret = "test_client_secret"');
    expect(csSource).toContain('options.ConnectionIntent = "add"');
    expect(csSource).toContain('AssertRequestBodyContainsAsync("connection_intent", "add")');
    const ktSource = kotlinTests(spec, ctx)
      .map((f) => f.content)
      .join('\n');
    expect(ktSource).toContain('matchingJsonPath("\\$.connection_intent", equalTo("add"))');
  });

  it('generates valid PHP const test inputs and exact const assertions', () => {
    const tests = phpTests(spec, ctx)
      .map((f) => f.content)
      .join('\n');
    expect(tests).toContain("connectionIntent: 'add'");
    expect(tests).toContain("$this->assertSame('add', $body['connection_intent'])");
    expect(tests).not.toContain("connectionIntent: 'test_value'");
  });
});

it('emits number-preserving Go JSON decoding when injecting request constants', () => {
  expect(output.go).toContain('"bytes"');
  expect(output.go).toContain('decoder := json.NewDecoder(bytes.NewReader(data))');
  expect(output.go).toContain('decoder.UseNumber()');
  expect(output.go).toContain('decoder.Decode(&m)');
  expect(output.go).not.toContain('json.Unmarshal(data, &m)');
});

it('uses the published mixed request locations for organization/user updates and user creation', () => {
  const files = php(spec.services, ctx);
  for (const name of ['putOrganizationConnection', 'putUserConnection', 'postUserConnection']) {
    const content = files.find((f) => f.content.includes(`function ${name}(`))!.content;
    const method = content.slice(content.indexOf(`function ${name}(`)).split('\n    }')[0];
    expect(method).toContain('body: $body,');
    expect(method).toContain('query: $query,');
    if (name.startsWith('put')) {
      expect(method).toContain("'connected_account_id' => $connectedAccountId");
      expect(method).toContain("'connection_intent' => $connectionIntent");
    } else {
      expect(method).toContain("'organization_id' => $organizationId");
    }
  }
});
