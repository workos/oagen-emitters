import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

function run(runtime: string, filename: string, source: string, args: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'request-contract-'));
  try {
    const file = join(dir, filename);
    writeFileSync(file, source);
    return execFileSync(runtime, [...args, file], { encoding: 'utf8', timeout: 30000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const available = (runtime: string, flag = '--version') => spawnSync(runtime, [flag]).status === 0;

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

it.skipIf(!available('python3'))(
  'executes generated sync and async Python calls with exact legacy/selected bodies and const defaults',
  () => {
    // Strip package imports only: execute the actual generated classes with a
    // recording transport and response placeholders, not a serialization copy.
    const classes = output.python.slice(output.python.indexOf('class Pipes:'));
    const responses = spec.models
      .filter((m) => m.name.endsWith('Response'))
      .map((m) => `${m.name} = object`)
      .join('\n');
    run(
      'python3',
      'check.py',
      `from __future__ import annotations\nimport asyncio\n${responses}\nenum_value = lambda v: v\n${classes}
class Client:
    def request(self, **kwargs): return kwargs
class AsyncClient:
    async def request(self, **kwargs): return kwargs
async def check():
    for resource in [Pipes(Client()), AsyncPipes(AsyncClient())]:
        for suffix, credentials in [('api_key', {'secret': 'sk_test'}), ('client_credentials', {'client_id': 'client_test', 'client_secret': 'secret_test'})]:
            base = {'user_id': 'user_test', **credentials}
            for selectors in [{}, {'connected_account_id': 'data_installation_test'}, {'connected_account_id': 'data_installation_test', 'connection_intent': 'reauthorize'}]:
                request = getattr(resource, 'put_' + suffix)('github', **base, **selectors)
                if asyncio.iscoroutine(request): request = await request
                assert request['body'] == {**base, **selectors}, request
            request = getattr(resource, 'post_' + suffix)('github', **base)
            if asyncio.iscoroutine(request): request = await request
            assert request['body'] == {**base, 'connection_intent': 'add'}, request
            try:
                invalid = getattr(resource, 'post_' + suffix)('github', **base, connection_intent='test_value')
                if asyncio.iscoroutine(invalid): await invalid
                raise AssertionError('invalid constant accepted')
            except ValueError: pass
asyncio.run(check())
`,
    );
  },
);

it.skipIf(!available('ruby'))('executes generated Ruby named calls, preserving both reauthorization shapes', () => {
  run(
    'ruby',
    'check.rb',
    `require 'json'\n${output.ruby}
module WorkOS::Util
  def self.encode_path(value); value; end
end
class Recorder
  attr_reader :last
  def request(**kwargs)
    @last = kwargs
    throw :recorded
  end
end
client = Recorder.new
resource = WorkOS::Pipes.new(client)
[['api_key', {secret: 'sk_test'}], ['client_credentials', {client_id: 'client_test', client_secret: 'secret_test'}]].each do |suffix, credentials|
  base = {user_id: 'user_test', **credentials}
  [{}, {connected_account_id: 'data_installation_test'}, {connected_account_id: 'data_installation_test', connection_intent: 'reauthorize'}].each do |selectors|
    catch(:recorded) { resource.public_send("put_#{suffix}", slug: 'github', **base, **selectors) }
    expected = base.merge(selectors).transform_keys(&:to_s)
    raise client.last.inspect unless client.last[:body] == expected
  end
  catch(:recorded) { resource.public_send("post_#{suffix}", slug: 'github', **base) }
  raise client.last.inspect unless client.last[:body] == base.merge(connection_intent: 'add').transform_keys(&:to_s)
  begin
    resource.public_send("post_#{suffix}", slug: 'github', **base, connection_intent: 'test_value')
    raise 'invalid constant accepted'
  rescue ArgumentError
  end
end
`,
  );
});

it.skipIf(!available('go', 'version'))(
  'serializes generated Go params without losing selected targets and supplies valid creation constants',
  () => {
    const blocks = [...output.go.matchAll(/type (Pipes\w+Params) struct \{[\s\S]*?(?=\nfunc \(s \*)/g)]
      .map((m) => m[0])
      .join('\n');
    const enums = spec.enums.map((e) => `type ${e.name.replace(/Api/g, 'API')} string`).join('\n');
    run(
      'go',
      'request_test.go',
      `package workos
import ("encoding/json"; "fmt"; "testing")
${enums}
${blocks}
func TestRequest(t *testing.T) {
  target, intent := "data_installation_test", "reauthorize"
  for _, p := range []PipesPutAPIKeyParams{
    {UserID: "user_test", Secret: "sk_test"},
    {UserID: "user_test", Secret: "sk_test", ConnectedAccountID: &target},
    {UserID: "user_test", Secret: "sk_test", ConnectedAccountID: &target, ConnectionIntent: &intent},
  } {
    encoded, err := json.Marshal(p); if err != nil {t.Fatal(err)}
    var body map[string]any; json.Unmarshal(encoded, &body)
    if body["user_id"] != "user_test" || body["secret"] != "sk_test" {t.Fatal(string(encoded))}
    if p.ConnectedAccountID != nil && body["connected_account_id"] != target {t.Fatal(string(encoded))}
    if p.ConnectedAccountID == nil && body["connected_account_id"] != nil {t.Fatal(string(encoded))}
    if p.ConnectionIntent != nil && body["connection_intent"] != intent {t.Fatal(string(encoded))}
    if p.ConnectionIntent == nil && body["connection_intent"] != nil {t.Fatal(string(encoded))}
  }
  for _, p := range []any{PipesPostAPIKeyParams{UserID: "user_test", Secret: "sk_test"}, PipesPostClientCredentialsParams{UserID: "user_test", ClientID: "client_test", ClientSecret: "secret_test"}} {
    encoded, err := json.Marshal(p); if err != nil {t.Fatal(err)}
    var body map[string]any; json.Unmarshal(encoded, &body)
    if body["connection_intent"] != "add" {t.Fatal(string(encoded))}
  }
  if _, err := json.Marshal(PipesPostAPIKeyParams{ConnectionIntent: "test_value"}); err == nil {t.Fatal("invalid intent accepted")}
}
`,
      ['test'],
    );
  },
);

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

it.skipIf(!available('php'))(
  'executes generated PHP creation, union and mixed-location calls with exact payloads',
  () => {
    const files = php(spec.services, ctx);
    const classFor = (method: string) =>
      files.find((f) => f.content.includes(`function ${method}(`))!.content.match(/class (\w+)/)![1];
    const models = spec.models
      .filter((m) => m.name.endsWith('Response'))
      .map((m) => `class ${m.name} { public static function fromArray(array $data): self { return new self(); } }`)
      .join('\n');
    run(
      'php',
      'check.php',
      `<?php
${files.map((f) => f.content).join('\n')}
namespace WorkOS\\Resource;
${models}
namespace WorkOS;
class HttpClient {
    public array $last = [];
    public function request(...$args): array { $this->last = $args; return ['id' => 'test']; }
}
function same($actual, $expected): void {
    if ($actual !== $expected) throw new \\RuntimeException(json_encode([$actual, $expected]));
}
$client = new HttpClient();
$pipes = new \\WorkOS\\Service\\${classFor('putApiKey')}($client);
foreach ([['ApiKey', ['secret' => 'sk_test']], ['ClientCredentials', ['clientId' => 'client_test', 'clientSecret' => 'secret_test']]] as [$suffix, $credentials]) {
    $base = ['slug' => 'github', 'userId' => 'user_test'] + $credentials;
    $wire = ['user_id' => 'user_test'] + ($suffix === 'ApiKey' ? ['secret' => 'sk_test'] : ['client_id' => 'client_test', 'client_secret' => 'secret_test']);
    foreach ([[], ['connectedAccountId' => 'data_installation_test'], ['connectionIntent' => 'reauthorize', 'connectedAccountId' => 'data_installation_test']] as $selectors) {
        $pipes->{'put'.$suffix}(...($base + $selectors));
        $expected = $wire;
        if (isset($selectors['connectionIntent'])) $expected['connection_intent'] = $selectors['connectionIntent'];
        if (isset($selectors['connectedAccountId'])) $expected['connected_account_id'] = $selectors['connectedAccountId'];
        same($client->last['body'], $expected);
    }
    $pipes->{'post'.$suffix}(...$base);
    same($client->last['body'], $wire + ['connection_intent' => 'add']);
    try {
        $pipes->{'post'.$suffix}(...($base + ['connectionIntent' => 'test_value']));
        throw new \\RuntimeException('invalid constant accepted');
    } catch (\\InvalidArgumentException $e) {}
}
$orgs = new \\WorkOS\\Service\\${classFor('putOrganizationConnection')}($client);
$orgs->putOrganizationConnection(organizationId: 'org_test', slug: 'github', userId: 'user_test', accessToken: 'token', connectedAccountId: 'data_installation_test', connectionIntent: 'reauthorize', supportsMultipleConnections: false);
same($client->last['body'], ['access_token' => 'token', 'user_id' => 'user_test']);
same($client->last['query'], ['supports_multiple_connections' => false, 'connected_account_id' => 'data_installation_test', 'connection_intent' => 'reauthorize']);
$users = new \\WorkOS\\Service\\${classFor('putUserConnection')}($client);
$users->putUserConnection(userId: 'user_test', slug: 'github', accessToken: 'token', connectedAccountId: 'data_installation_test', connectionIntent: 'reauthorize');
same($client->last['body'], ['access_token' => 'token']);
same($client->last['query'], ['connected_account_id' => 'data_installation_test', 'connection_intent' => 'reauthorize']);
$users->postUserConnection(userId: 'user_test', slug: 'github', accessToken: 'token', organizationId: 'org_test');
same($client->last['body'], ['access_token' => 'token']);
same($client->last['query'], ['organization_id' => 'org_test']);
$users->postUserConnection(userId: 'user_test', slug: 'github', accessToken: 'token');
same($client->last['query'], []);
`,
    );
  },
);
