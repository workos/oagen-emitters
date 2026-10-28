import { beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseSpec, type ApiSpec, type EmitterContext, type TypeRef } from '@workos/oagen';
import type { ApiSurface } from '@workos/oagen/compat';
import { generateResources } from '../../src/php/resources.js';
import { generateTests } from '../../src/php/tests.js';

let spec: ApiSpec;
beforeAll(async () => {
  spec = await parseSpec(resolve('test/fixtures/php-pipes-requests.yaml'));
  spec.services = [{ name: 'Pipes', operations: spec.services.flatMap((s) => s.operations) }];
});

// v9.4.0 parameter slots; '?' marks a defaulted argument. Unrelated fields omitted.
const oldMethods = {
  authorizeDataIntegration: [
    'slug',
    'userId',
    'organizationId?',
    'connectionOwner?',
    'returnTo?',
    'config?',
    'options?',
  ],
  updateDataIntegrationApiKey: [
    'slug',
    'userId',
    'secret',
    'organizationId?',
    'connectedAccountId?',
    'connectionOwner?',
    'options?',
  ],
  updateDataIntegrationClientCredentials: [
    'slug',
    'userId',
    'clientId',
    'clientSecret',
    'organizationId?',
    'connectedAccountId?',
    'connectionOwner?',
    'config?',
    'options?',
  ],
  createUserConnectedAccount: [
    'userId',
    'slug',
    'accessToken?',
    'refreshToken?',
    'expiresAt?',
    'scopes?',
    'state?',
    'options?',
  ],
};

function surface(methods: Record<string, string[]> = oldMethods): ApiSurface {
  return {
    language: 'php',
    extractedFrom: 'v9.4.0',
    extractedAt: '',
    classes: {
      Pipes: {
        name: 'Pipes',
        properties: {},
        constructorParams: [],
        methods: Object.fromEntries(
          Object.entries(methods).map(([name, params]) => [
            name,
            [
              {
                name,
                async: false,
                returnType: 'Reply',
                params: params.map((p) => ({ name: p.replace(/\?$/, ''), optional: p.endsWith('?'), type: 'mixed' })),
              },
            ],
          ]),
        ),
      },
    },
    interfaces: {},
    typeAliases: {},
    enums: {},
    exports: {},
  };
}

function context(input = spec, baseline: ApiSurface | undefined = surface()): EmitterContext {
  return { namespace: 'workos', namespacePascal: 'WorkOS', spec: input, apiSurface: baseline };
}

function resource(ctx = context()): string {
  return generateResources(ctx.spec.services, ctx).find((f) => f.path === 'lib/Service/Pipes.php')!.content;
}

function parameters(source: string, method: string): string[] {
  const signature = source.match(new RegExp(`public function ${method}\\(([\\s\\S]*?)\\n    \\):`))![1];
  return [...signature.matchAll(/\$(\w+)/g)].map((m) => m[1]);
}

describe('PHP request contracts', () => {
  it('projects all authorization alternatives without mutating the parsed spec', () => {
    const before = JSON.stringify(spec);
    const source = resource({ ...context(), apiSurface: undefined });
    for (const field of [
      'user_id',
      'organization_id',
      'connection_owner',
      'return_to',
      'config',
      'account_display_name',
      'connection_intent',
      'connected_account_id',
    ]) {
      expect(source).toContain(`'${field}' =>`);
    }
    expect(source).toContain('string $userId,');
    expect(source).toContain('?string $connectionIntent = null,');
    expect(source).toContain('?string $connectedAccountId = null,');
    expect(source).toContain('@param string $userId');
    expect(source).not.toContain("$connectionIntent = 'add'");
    expect(JSON.stringify(spec)).toBe(before);
  });

  it('keeps every existing slot and appends new optional inputs, including after options', () => {
    const source = resource();
    for (const [method, old] of Object.entries(oldMethods)) {
      expect(parameters(source, method).slice(0, old.length)).toEqual(old.map((p) => p.replace(/\?$/, '')));
    }
    expect(parameters(source, 'authorizeDataIntegration').slice(oldMethods.authorizeDataIntegration.length)).toEqual([
      'accountDisplayName',
      'connectionIntent',
      'connectedAccountId',
    ]);
  });

  it('generates union-body test inputs and assertions rather than a slug-only smoke test', () => {
    const source = generateTests(spec, context()).find((f) => f.path === 'tests/Service/PipesTest.php')!.content;
    expect(source).toContain("authorizeDataIntegration(slug: 'test_slug', userId: 'test_value')");
    expect(source).toContain(
      "updateDataIntegrationApiKey(slug: 'test_slug', userId: 'test_value', secret: 'test_value')",
    );
    expect(source).toContain("clientId: 'test_value', clientSecret: 'test_value'");
    expect(source).toContain("$this->assertSame('test_value', $body['user_id'])");
    expect(source).toContain("$this->assertSame('test_value', $body['secret'])");
  });

  it('uses one complete branch, including literal inputs, in generated tests', () => {
    const input = structuredClone(spec);
    const op = input.services[0].operations[0];
    if (op.requestBody?.kind !== 'union') throw new Error('fixture must be a union');
    op.requestBody.variants.reverse();
    const source = generateTests(input, context(input)).find((f) => f.path === 'tests/Service/PipesTest.php')!.content;
    expect(source).toContain("connectionIntent: 'reauthorize'");
    expect(source).toContain("connectedAccountId: 'test_value'");
    expect(source).toContain("$this->assertSame('reauthorize', $body['connection_intent'])");
  });

  it('does not move an existing required parameter when the schema makes it optional', () => {
    const input = structuredClone(spec);
    for (const model of input.models) {
      for (const field of model.fields) if (field.name === 'user_id') field.required = false;
    }
    const source = resource(context(input));
    expect(parameters(source, 'updateDataIntegrationApiKey').slice(0, 3)).toEqual(['slug', 'userId', 'secret']);
    expect(source).toMatch(
      /function updateDataIntegrationApiKey\(\s*string \$slug,\s*\?string \$userId,\s*string \$secret,/,
    );
  });

  it('keeps generated tests supplying parameters that the baseline still requires', () => {
    const input = structuredClone(spec);
    for (const model of input.models) {
      for (const field of model.fields) if (field.name === 'user_id') field.required = false;
    }
    const source = generateTests(input, context(input)).find((f) => f.path === 'tests/Service/PipesTest.php')!.content;
    expect(source).toContain("authorizeDataIntegration(slug: 'test_slug', userId: 'test_value')");
    expect(source).toContain(
      "updateDataIntegrationApiKey(slug: 'test_slug', userId: 'test_value', secret: 'test_value')",
    );
  });

  it('preserves an identical field-level union shared by every body alternative', () => {
    const input = structuredClone(spec);
    for (const model of input.models.filter((m) => m.name.startsWith('Authorize'))) {
      model.fields.push({
        name: 'label',
        required: false,
        type: {
          kind: 'union',
          variants: [
            { kind: 'primitive', type: 'string' },
            { kind: 'primitive', type: 'integer' },
          ],
        },
      });
    }
    expect(resource(context(input))).toContain('string|int|null $label = null');
  });

  it('uses the resolved mount and method name to find the baseline', () => {
    const input = structuredClone(spec);
    input.services[0].name = 'InternalPipes';
    const ctx = context(input);
    ctx.resolvedOperations = input.services[0].operations.map((operation) => ({
      operation,
      service: input.services[0],
      mountOn: 'Pipes',
      methodName: operation.name,
      defaults: {},
      inferFromClient: [],
      urlBuilder: false,
    }));
    expect(parameters(resource(ctx), 'authorizeDataIntegration').slice(0, 7)).toEqual(
      oldMethods.authorizeDataIntegration.map((p) => p.replace(/\?$/, '')),
    );
  });

  it('picks a test branch that supplies every baseline-required input', () => {
    const ctx = context(
      spec,
      surface({ authorizeDataIntegration: ['slug', 'userId', 'connectedAccountId', 'options?'] }),
    );
    expect(parameters(resource(ctx), 'authorizeDataIntegration').slice(0, 3)).toEqual([
      'slug',
      'userId',
      'connectedAccountId',
    ]);
    const tests = generateTests(spec, ctx).find((f) => f.path === 'tests/Service/PipesTest.php')!.content;
    expect(tests).toContain(
      "authorizeDataIntegration(slug: 'test_slug', userId: 'test_value', connectionIntent: 'reauthorize', connectedAccountId: 'test_value')",
    );
    expect(tests).toContain("$this->assertSame('reauthorize', $body['connection_intent'])");
  });

  it('fills baseline-required inputs that no single branch supplies', () => {
    const input = structuredClone(spec);
    input.models
      .find((m) => m.name === 'AuthorizeReauthorize')!
      .fields.push({
        name: 'return_to',
        required: false,
        type: { kind: 'primitive', type: 'string' },
      });
    const ctx = context(
      input,
      surface({ authorizeDataIntegration: ['slug', 'userId', 'returnTo', 'connectedAccountId', 'options?'] }),
    );
    const tests = generateTests(input, ctx).find((f) => f.path === 'tests/Service/PipesTest.php')!.content;
    const call = tests.match(/authorizeDataIntegration\((.*)\);/)![1];
    expect(call).toContain("returnTo: 'test_value'");
    expect(call).toContain("connectedAccountId: 'test_value'");
  });

  it('uses named path arguments in generated tests when the baseline order differs from the schema', () => {
    const ctx = context(spec, surface({ createUserConnectedAccount: ['slug', 'userId', 'options?'] }));
    expect(parameters(resource(ctx), 'createUserConnectedAccount').slice(0, 3)).toEqual(['slug', 'userId', 'options']);
    const tests = generateTests(spec, ctx).find((f) => f.path === 'tests/Service/PipesTest.php')!.content;
    expect(tests).toContain("createUserConnectedAccount(userId: 'test_user_id', slug: 'test_slug')");
  });

  it.each([
    ['a new required input', ['slug', 'options?'], /new parameter \$userId is required/],
    ['an optional input that became required', ['slug', 'userId?', 'options?'], /\$userId became required/],
    ['a removed baseline parameter', ['slug', 'userId', 'removed?', 'options?'], /\$removed was removed/],
  ])('emits the schema signature and warns when the baseline cannot be honored: %s', (_case, params, reason) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const withBaseline = resource(context(spec, surface({ authorizeDataIntegration: params })));
      const fresh = resource({ ...context(spec), apiSurface: undefined });
      expect(parameters(withBaseline, 'authorizeDataIntegration')).toEqual(
        parameters(fresh, 'authorizeDataIntegration'),
      );
      expect(parameters(withBaseline, 'authorizeDataIntegration').slice(0, 2)).toEqual(['slug', 'userId']);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Pipes\.authorizeDataIntegration/));
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(reason));
    } finally {
      warn.mockRestore();
    }
  });

  it.each<TypeRef>([
    { kind: 'primitive', type: 'string' },
    { kind: 'model', name: 'Missing' },
    { kind: 'nullable', inner: { kind: 'model', name: 'AuthorizeLegacy' } },
    { kind: 'union', variants: [] },
    {
      kind: 'union',
      variants: [
        { kind: 'model', name: 'AuthorizeLegacy' },
        { kind: 'primitive', type: 'boolean' },
      ],
    },
  ])('rejects unsupported request bodies rather than emitting an empty body: %j', (requestBody) => {
    const input = structuredClone(spec);
    input.services[0].operations[0].requestBody = requestBody;
    expect(() => resource({ ...context(input), apiSurface: undefined })).toThrow(/PHP.*POST.*authorize.*request body/i);
  });

  it('rejects conflicting field types across alternatives', () => {
    const input = structuredClone(spec);
    const model = input.models.find((m) => m.name === 'AuthorizeAdd')!;
    model.fields.find((f) => f.name === 'user_id')!.type = { kind: 'primitive', type: 'boolean' };
    expect(() => resource(context(input))).toThrow(/request body.*user_id/i);
  });

  it.each(['post', 'put', 'patch'] as const)('forwards query params alongside a %s body', (httpMethod) => {
    const input = structuredClone(spec);
    const op = input.services[0].operations.find((o) => o.name === 'createUserConnectedAccount')!;
    input.services[0].operations = [op];
    op.httpMethod = httpMethod;
    op.queryParams = [
      { name: 'organization_id', required: false, type: { kind: 'primitive', type: 'string' } },
      { name: 'supports_multiple_connections', required: false, type: { kind: 'primitive', type: 'boolean' } },
      { name: 'connected_account_id', required: false, type: { kind: 'primitive', type: 'string' } },
    ];
    const source = resource(context(input));
    expect(source).toContain('query: $query,');
    expect(source).toContain("'organization_id' => $organizationId");
    expect(source).toContain("'supports_multiple_connections' => $supportsMultipleConnections");
    expect(source).toContain("'connected_account_id' => $connectedAccountId");
    expect(source.match(/fn \(\$v\) => \$v !== null/g)).toHaveLength(2);
    if (!hasPhp) return;
    const result = spawnSync('php', ['-n'], {
      encoding: 'utf8',
      timeout: 15000,
      input: `<?php
namespace WorkOS;
class HttpClient {
    public array $requests = [];
    public function request(string $method, string $path, array $body, mixed $options = null, array $query = []): array {
        $this->requests[] = [$body, $query];
        return ['id' => 'reply'];
    }
}
namespace WorkOS\\Resource;
class Reply { public static function fromArray(array $data): self { return new self(); } }
${source}
namespace WorkOS;
$client = new HttpClient();
$pipes = new \\WorkOS\\Service\\Pipes($client);
$pipes->createUserConnectedAccount('user_01', 'github', 'access', organizationId: 'org_01', supportsMultipleConnections: false, connectedAccountId: 'ca_01');
$pipes->createUserConnectedAccount('user_01', 'github', 'access');
echo json_encode($client->requests, JSON_THROW_ON_ERROR);
`,
    });
    expect(result.status, result.stdout || result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      [
        { access_token: 'access' },
        { organization_id: 'org_01', supports_multiple_connections: false, connected_account_id: 'ca_01' },
      ],
      [{ access_token: 'access' }, []],
    ]);
  });

  it('gives a query param that collides with a path param or body field its own argument', () => {
    const input = structuredClone(spec);
    const op = input.services[0].operations.find((o) => o.name === 'createUserConnectedAccount')!;
    input.services[0].operations = [op];
    op.queryParams = [
      { name: 'slug', required: false, type: { kind: 'primitive', type: 'string' } },
      { name: 'access_token', required: false, type: { kind: 'primitive', type: 'string' } },
    ];
    const source = resource(context(input));
    expect(source).toContain('?string $querySlug = null');
    expect(source).toContain('?string $queryAccessToken = null');
    expect(source).toContain('@param string|null $querySlug');
    expect(source).toContain("'slug' => $querySlug,");
    expect(source).toContain("'access_token' => $queryAccessToken,");
    expect(source).not.toContain("'slug' => $slug,");
    const tests = generateTests(input, context(input)).find((f) => f.path === 'tests/Service/PipesTest.php')!.content;
    expect(tests).not.toMatch(/createUserConnectedAccount\([^)]*\bslug: [^)]*\bslug:/);
  });

  it('uses the same query argument names in generated tests as in the resource signature', () => {
    const input = structuredClone(spec);
    const op = input.services[0].operations.find((o) => o.name === 'createUserConnectedAccount')!;
    input.services[0].operations = [op];
    if (op.requestBody?.kind !== 'model') throw new Error('fixture must be a model body');
    const bodyName = op.requestBody.name;
    input.models
      .find((m) => m.name === bodyName)!
      .fields.push({
        name: 'label',
        required: false,
        type: { kind: 'primitive', type: 'string' },
      });
    op.queryParams = [{ name: 'label', required: true, type: { kind: 'primitive', type: 'string' } }];
    const ctx = { ...context(input), apiSurface: undefined };
    expect(resource(ctx)).toContain('string $queryLabel,');
    const tests = generateTests(input, ctx).find((f) => f.path === 'tests/Service/PipesTest.php')!.content;
    const call = tests.match(/createUserConnectedAccount\((.*)\);/)![1];
    expect(call).toContain("queryLabel: 'test_value'");
    expect(call).not.toMatch(/\blabel:/);
  });

  it('never declares the same argument twice when body fields collide with each other', () => {
    const input = structuredClone(spec);
    const op = input.services[0].operations.find((o) => o.name === 'createUserConnectedAccount')!;
    input.services[0].operations = [op];
    if (op.requestBody?.kind !== 'model') throw new Error('fixture must be a model body');
    const bodyName = op.requestBody.name;
    input.models
      .find((m) => m.name === bodyName)!
      .fields.push(
        { name: 'foo_bar', required: false, type: { kind: 'primitive', type: 'string' } },
        { name: 'fooBar', required: false, type: { kind: 'primitive', type: 'string' } },
      );
    op.queryParams = [{ name: 'body_foo_bar', required: false, type: { kind: 'primitive', type: 'string' } }];
    const source = resource({ ...context(input), apiSurface: undefined });
    const names = parameters(source, 'createUserConnectedAccount');
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(['fooBar', 'bodyFooBar', 'queryBodyFooBar']));
    expect(source).toContain("'foo_bar' => $fooBar,");
    expect(source).toContain("'fooBar' => $bodyFooBar,");
    expect(source).toContain("'body_foo_bar' => $queryBodyFooBar,");
  });

  it('also handles union request bodies on DELETE', () => {
    const input = structuredClone(spec);
    input.services[0].operations[0].httpMethod = 'delete';
    const source = resource(context(input));
    expect(source).toContain("method: 'DELETE'");
    expect(source).toContain("'connection_intent' => $connectionIntent");
    const tests = generateTests(input, context(input)).find((f) => f.path === 'tests/Service/PipesTest.php')!.content;
    expect(tests).toContain("$this->assertSame('test_value', $body['user_id'])");
  });
});

const hasPhp = spawnSync('php', ['--version'], { timeout: 5000 }).status === 0;
it.skipIf(!hasPhp)(
  'executes legacy positional/named calls and both authorization selectors with the generated PHP',
  () => {
    const program = `<?php
declare(strict_types=1);
namespace WorkOS;
class RequestOptions { public string $id = 'options'; }
class HttpClient {
    public array $requests = [];
    public function request(string $method, string $path, array $body, ?RequestOptions $options = null): array {
        $this->requests[] = [$method, $path, json_decode(json_encode($body), true), $options?->id];
        return ['id' => 'reply'];
    }
}
namespace WorkOS\\Resource;
enum PipeOwnership: string { case User = 'user'; case Organization = 'organization'; }
class Reply { public static function fromArray(array $data): self { return new self(); } }
${resource()}
namespace WorkOS;
$client = new HttpClient();
$pipes = new \\WorkOS\\Service\\Pipes($client);
$options = new RequestOptions();
$owner = \\WorkOS\\Resource\\PipeOwnership::Organization;
$pipes->authorizeDataIntegration('github', 'user_01', 'org_01', $owner, 'https://example.test/cb', ['subdomain' => 'acme'], $options);
$pipes->authorizeDataIntegration(slug: 'github', userId: 'user_01');
$pipes->authorizeDataIntegration('github', 'user_01', connectionIntent: 'add');
$pipes->authorizeDataIntegration('github', 'user_01', connectionIntent: 'reauthorize', connectedAccountId: 'ca_01');
$pipes->updateDataIntegrationApiKey('openai', 'user_01', 'sk-secret', 'org_01', 'ca_01', $owner, $options);
$pipes->updateDataIntegrationApiKey(slug: 'openai', userId: 'user_01', secret: 'sk-secret');
$pipes->updateDataIntegrationClientCredentials('zendesk', 'user_01', 'client', 'secret', 'org_01', 'ca_01', $owner, ['subdomain' => 'acme'], $options);
$pipes->createUserConnectedAccount('user_01', 'github', 'access', 'refresh');
$pipes->createUserConnectedAccount(userId: 'user_01', slug: 'github', accessToken: 'access', accountDisplayName: 'label', accountIdentifier: 'identifier');
echo json_encode($client->requests, JSON_THROW_ON_ERROR);
`;
    const result = spawnSync('php', ['-n'], { input: program, encoding: 'utf8', timeout: 15000 });
    expect(result.stderr).toBe('');
    expect(result.status, result.stdout || result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      [
        'POST',
        'data-integrations/github/authorize',
        {
          user_id: 'user_01',
          organization_id: 'org_01',
          connection_owner: 'organization',
          return_to: 'https://example.test/cb',
          config: { subdomain: 'acme' },
        },
        'options',
      ],
      ['POST', 'data-integrations/github/authorize', { user_id: 'user_01' }, null],
      ['POST', 'data-integrations/github/authorize', { user_id: 'user_01', connection_intent: 'add' }, null],
      [
        'POST',
        'data-integrations/github/authorize',
        { user_id: 'user_01', connection_intent: 'reauthorize', connected_account_id: 'ca_01' },
        null,
      ],
      [
        'PUT',
        'data-integrations/openai/api-key',
        {
          user_id: 'user_01',
          secret: 'sk-secret',
          organization_id: 'org_01',
          connected_account_id: 'ca_01',
          connection_owner: 'organization',
        },
        'options',
      ],
      ['PUT', 'data-integrations/openai/api-key', { user_id: 'user_01', secret: 'sk-secret' }, null],
      [
        'PUT',
        'data-integrations/zendesk/client-credentials',
        {
          user_id: 'user_01',
          client_id: 'client',
          client_secret: 'secret',
          organization_id: 'org_01',
          connected_account_id: 'ca_01',
          connection_owner: 'organization',
          config: { subdomain: 'acme' },
        },
        'options',
      ],
      [
        'POST',
        'user_management/users/user_01/connected_accounts/github',
        { access_token: 'access', refresh_token: 'refresh' },
        null,
      ],
      [
        'POST',
        'user_management/users/user_01/connected_accounts/github',
        { access_token: 'access', account_display_name: 'label', account_identifier: 'identifier' },
        null,
      ],
    ]);
  },
);
