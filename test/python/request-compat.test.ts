import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultSdkBehavior, type EmitterContext, type Field, type Model, type Operation } from '@workos/oagen';
import { generateResources } from '../../src/python/resources.js';
import { generateModels } from '../../src/python/models.js';
import { generateEnums } from '../../src/python/enums.js';

const string = { kind: 'primitive', type: 'string' } as const;
const field = (name: string, required = false): Field => ({ name, type: string, required });
const label: Field = { name: 'account_display_name', type: { kind: 'nullable', inner: string }, required: false };

// Same three branches as the current Pipes spec: compatibility, add/reauthorize,
// and exact-account selection. The authorize variants have DIFFERENT literals.
function context(): EmitterContext {
  const models: Model[] = [];
  const operations: Operation[] = [];
  for (const [name, fields, intents] of [
    ['authorizeDataIntegration', [field('user_id', true), field('return_to')], ['add', 'reauthorize']],
    ['updateDataIntegrationApiKey', [field('user_id', true), field('secret', true)], ['reauthorize']],
    [
      'updateDataIntegrationClientCredentials',
      [field('user_id', true), field('client_id', true), field('client_secret', true)],
      ['reauthorize'],
    ],
  ] as const) {
    const base = `${name}Request`;
    const shared = [...fields, label, field('organization_id')];
    models.push({ name: base, fields: shared });
    const variants = [{ kind: 'model' as const, name: base }];
    for (const intent of intents) {
      const variantName = `${name}${intent}Request`;
      models.push({
        name: variantName,
        fields: [
          ...shared,
          { name: 'connection_intent', required: true, type: { kind: 'literal', value: intent } },
          ...(intent === 'reauthorize' ? [field('connected_account_id', true)] : []),
        ],
      });
      variants.push({ kind: 'model', name: variantName });
    }
    operations.push({
      name,
      httpMethod: name.startsWith('authorize') ? 'post' : 'put',
      path: `/data-integrations/{slug}/${name}`,
      pathParams: [{ name: 'slug', type: string, required: true }],
      queryParams: [],
      headerParams: [],
      requestBody: { kind: 'union', variants },
      response: { kind: 'model', name: 'ConnectedAccountWriteResponse' },
      errors: [],
      injectIdempotencyKey: false,
    });
  }
  models.push({ name: 'ConnectedAccount', fields: [field('id', true), label] });
  models.push({
    name: 'ConnectedAccountWriteResponse',
    fields: [field('id', true), label, { name: 'warnings', type: { kind: 'array', items: string }, required: false }],
  });
  return {
    namespace: 'workos',
    namespacePascal: 'WorkOS',
    spec: {
      name: 'Pipes compatibility',
      version: '1',
      baseUrl: '',
      models,
      enums: [],
      services: [{ name: 'Pipes', operations }],
      sdk: defaultSdkBehavior(),
    },
  };
}

// Execute the generated Python, not a reimplementation of its serializer.
// The SDK-owned runtime is reduced to the imports these fixtures need.
function runPython(ctx: EmitterContext, script: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'python-request-compat-'));
  try {
    const files = [
      ...generateResources(ctx.spec.services, ctx),
      ...generateModels(ctx.spec.models, ctx),
      ...generateEnums(ctx.spec.enums, ctx),
      {
        path: 'src/workos/_types.py',
        content: `from enum import Enum
class NotGiven:
    def __bool__(self): return False
NOT_GIVEN = NotGiven()
RequestOptions = dict
def enum_value(value): return value.value if isinstance(value, Enum) else value
def _raise_deserialize_error(name, error): raise ValueError(name) from error
`,
      },
      { path: 'src/workos/_pagination.py', content: 'class SyncPage: pass\nclass AsyncPage: pass\n' },
    ];
    for (const file of files) {
      const path = join(dir, file.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.content);
    }
    execFileSync('python3', ['-c', script], {
      env: { ...process.env, PYTHONPATH: join(dir, 'src'), PYTHONDONTWRITEBYTECODE: '1' },
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('Python request compatibility', () => {
  it('keeps old kwargs, current body calls, and both intent literals on sync and async resources', () => {
    runPython(
      context(),
      `
import asyncio
from workos.pipes._resource import Pipes, AsyncPipes
from workos.pipes.models import AuthorizeDataIntegrationRequest
class Client:
    def request(self, **request): return request['body']
class AsyncClient:
    async def request(self, **request): return request['body']

async def check(resource, is_async):
    async def call(method, **kwargs):
        result = getattr(resource, method)('github', **kwargs)
        return await result if is_async else result
    for method, payload in [
        ('authorize_data_integration', {'user_id': 'user_1'}),
        ('update_data_integration_api_key', {'user_id': 'user_1', 'secret': 'secret'}),
        ('update_data_integration_client_credentials', {'user_id': 'user_1', 'client_id': 'id', 'client_secret': 'secret'}),
    ]:
        assert await call(method, **payload) == payload
        assert await call(method, body=payload) == payload
        full = dict(payload, connected_account_id='ca_1', connection_intent='reauthorize', account_display_name=None)
        assert await call(method, **full) == full
        assert await call(method, body=full) == full
        assert await call(method, **payload, organization_id=None) == payload
        try:
            await call(method)
            raise AssertionError('missing required fields accepted')
        except TypeError:
            pass
        try:
            await call(method, body=payload, **payload)
            raise AssertionError('body mixed with kwargs accepted')
        except TypeError:
            pass
    assert await call('authorize_data_integration', user_id='user_1', connection_intent='add') == {'user_id': 'user_1', 'connection_intent': 'add'}
    assert await call('authorize_data_integration', body=AuthorizeDataIntegrationRequest(user_id='user_1')) == {'user_id': 'user_1'}

asyncio.run(check(Pipes(Client()), False))
asyncio.run(check(AsyncPipes(AsyncClient()), True))
`,
    );
  });

  it('omits unset nullable request fields, preserves explicit null, and leaves response defaults alone', () => {
    runPython(
      context(),
      `
from workos.pipes.models import AuthorizeDataIntegrationRequest
from workos.common.models import ConnectedAccount
from workos._types import NOT_GIVEN
request = AuthorizeDataIntegrationRequest(user_id='user_1')
assert request.account_display_name is NOT_GIVEN
assert request.to_dict() == {'user_id': 'user_1'}
assert AuthorizeDataIntegrationRequest.from_dict({'user_id': 'user_1'}).to_dict() == {'user_id': 'user_1'}
for label in [None, '', 'Production']:
    data = {'user_id': 'user_1', 'account_display_name': label}
    assert AuthorizeDataIntegrationRequest.from_dict(data).to_dict() == data
    assert AuthorizeDataIntegrationRequest(user_id='user_1', account_display_name=label).to_dict() == data
assert ConnectedAccount(id='ca_1').account_display_name is None
`,
    );
  });

  it('does not deduplicate nested response models into request models with different defaults', () => {
    const ctx = context();
    ctx.spec.models.push(
      { name: 'ARequestLabel', fields: [label] },
      { name: 'ZResponseLabel', fields: [label] },
      {
        name: 'ARequestContainer',
        fields: [{ name: 'label', type: { kind: 'model', name: 'ARequestLabel' }, required: true }],
      },
      {
        name: 'ZResponseContainer',
        fields: [{ name: 'label', type: { kind: 'model', name: 'ZResponseLabel' }, required: true }],
      },
    );
    ctx.spec.models[0].fields.push({
      name: 'details',
      type: { kind: 'model', name: 'ARequestContainer' },
      required: false,
    });
    ctx.spec.models
      .find((m) => m.name === 'ConnectedAccountWriteResponse')!
      .fields.push({ name: 'details', type: { kind: 'model', name: 'ZResponseContainer' }, required: false });
    runPython(
      ctx,
      `
from workos.pipes.models import ARequestLabel, ZResponseLabel, ARequestContainer, ZResponseContainer
from workos._types import NOT_GIVEN
assert ARequestLabel().account_display_name is NOT_GIVEN
assert ARequestLabel().to_dict() == {}
assert ZResponseLabel().account_display_name is None
assert ZResponseLabel().to_dict() == {'account_display_name': None}
assert ARequestContainer.from_dict({'label': {}}).to_dict() == {'label': {}}
assert ZResponseContainer.from_dict({'label': {}}).to_dict() == {'label': {'account_display_name': None}}
`,
    );
  });

  it('re-exports generated enum aliases even after operations stop referring to them directly', () => {
    const ctx = context();
    ctx.spec.enums.push(
      { name: 'CanonicalState', values: [{ name: 'Connected', value: 'connected' }] },
      { name: 'PipeConnectedAccountState', values: [{ name: 'Connected', value: 'connected' }] },
    );
    ctx.spec.models.push({
      name: 'PipeConnectedAccount',
      fields: [{ name: 'state', type: { kind: 'enum', name: 'PipeConnectedAccountState' }, required: true }],
    });
    runPython(
      ctx,
      `
from typing import get_args
from workos.common.models import PipeConnectedAccountState, PipeConnectedAccountStateLiteral
assert PipeConnectedAccountState is not None
assert get_args(PipeConnectedAccountStateLiteral) == ('connected',)
`,
    );
  });

  it('merges equivalent branch enums and leaves branch-only requirements optional', () => {
    const ctx = context();
    ctx.spec.enums.push(
      {
        name: 'Owner',
        values: [
          { name: 'User', value: 'user' },
          { name: 'Organization', value: 'organization' },
        ],
      },
      {
        name: 'AddOwner',
        values: [
          { name: 'Organization', value: 'organization' },
          { name: 'User', value: 'user' },
        ],
      },
    );
    ctx.spec.models[0].fields.push({
      name: 'connection_owner',
      type: { kind: 'enum', name: 'Owner' },
      required: false,
    });
    ctx.spec.models[1].fields.push({
      name: 'connection_owner',
      type: { kind: 'enum', name: 'AddOwner' },
      required: true,
    });
    runPython(
      ctx,
      `
from workos.pipes._resource import Pipes, Owner
class Client:
    def request(self, **request): return request['body']
pipes = Pipes(Client())
assert pipes.authorize_data_integration('github', user_id='user_1') == {'user_id': 'user_1'}
assert pipes.authorize_data_integration('github', user_id='user_1', connection_owner=Owner.USER) == {'user_id': 'user_1', 'connection_owner': 'user'}
`,
    );
  });

  it('keeps required nullable model fields required and does not rewrite shared response models', () => {
    const ctx = context();
    ctx.spec.models[0].fields.push({ name: 'required_nullable', type: label.type, required: true });
    runPython(
      ctx,
      `
from workos.pipes.models import AuthorizeDataIntegrationRequest
try:
    AuthorizeDataIntegrationRequest(user_id='user_1')
    raise AssertionError('missing required nullable field accepted')
except TypeError:
    pass
assert AuthorizeDataIntegrationRequest(user_id='user_1', required_nullable=None).to_dict() == {'user_id': 'user_1', 'required_nullable': None}
`,
    );
    ctx.spec.services[0].operations[0].response = { kind: 'model', name: ctx.spec.models[0].name };
    runPython(
      ctx,
      `
from workos.pipes.models import AuthorizeDataIntegrationRequest
assert AuthorizeDataIntegrationRequest(user_id='user_1', required_nullable=None).account_display_name is None
`,
    );
  });

  it('does not flatten non-object or incompatible unions', () => {
    const ctx = context();
    const op = ctx.spec.services[0].operations[0];
    op.requestBody = { kind: 'union', variants: [string, { kind: 'model', name: ctx.spec.models[0].name }] };
    let resource = generateResources(ctx.spec.services, ctx)[0].content;
    const signature = resource.slice(
      resource.indexOf('def authorize_data_integration('),
      resource.indexOf(') ->', resource.indexOf('def authorize_data_integration(')),
    );
    expect(signature).not.toContain('user_id:');
    op.requestBody = {
      kind: 'union',
      variants: [
        { kind: 'model', name: ctx.spec.models[0].name },
        { kind: 'model', name: 'IncompatibleRequest' },
      ],
    };
    ctx.spec.models.push({
      name: 'IncompatibleRequest',
      fields: [{ name: 'user_id', type: { kind: 'primitive', type: 'integer' }, required: true }],
    });
    resource = generateResources(ctx.spec.services, ctx)[0].content;
    expect(
      resource.slice(
        resource.indexOf('def authorize_data_integration('),
        resource.indexOf(') ->', resource.indexOf('def authorize_data_integration(')),
      ),
    ).not.toContain('user_id:');
  });
  it('sends explicit null for required nullable model fields passed as individual kwargs', () => {
    const ctx = context();
    ctx.spec.models.push({ name: 'Selector', fields: [field('id', true)] });
    const selector = { kind: 'model', name: 'Selector' } as const;
    for (const model of ctx.spec.models.slice(0, 3)) {
      model.fields.push(
        { name: 'selector', type: { kind: 'nullable', inner: selector }, required: true },
        { name: 'selectors', type: { kind: 'nullable', inner: { kind: 'array', items: selector } }, required: true },
      );
    }
    runPython(
      ctx,
      `
from workos.pipes._resource import Pipes
from workos.pipes.models import Selector
class Client:
    def request(self, **request): return request['body']
pipes = Pipes(Client())
assert pipes.authorize_data_integration('github', user_id='user_1', selector=None, selectors=None) == {'user_id': 'user_1', 'selector': None, 'selectors': None}
assert pipes.authorize_data_integration('github', user_id='user_1', selector=Selector(id='s_1'), selectors=[Selector(id='s_2')]) == {'user_id': 'user_1', 'selector': {'id': 's_1'}, 'selectors': [{'id': 's_2'}]}
`,
    );
  });

  it('keeps the body-only API when a body field collides with the auth override parameter', () => {
    const ctx = context();
    const op = ctx.spec.services[0].operations[0];
    op.security = [[{ schemeName: 'access_token', scopes: [] }]] as unknown as Operation['security'];
    for (const model of ctx.spec.models.slice(0, 3)) model.fields.push(field('access_token'));
    const resource = generateResources(ctx.spec.services, ctx)[0].content;
    const start = resource.indexOf('def authorize_data_integration(');
    const signature = resource.slice(start, resource.indexOf(') ->', start));
    expect(signature).not.toContain('user_id:');
    expect(signature.match(/access_token:/g)).toHaveLength(1);
    runPython(ctx, 'import workos.pipes._resource');
  });

  it('scoped runs only export alias literals from alias files they rewrite', () => {
    const ctx = context();
    ctx.spec.enums.push(
      { name: 'CanonicalState', values: [{ name: 'Connected', value: 'connected' }] },
      { name: 'PipeConnectedAccountState', values: [{ name: 'Connected', value: 'connected' }] },
    );
    ctx.spec.models.push({
      name: 'PipeConnectedAccount',
      fields: [{ name: 'state', type: { kind: 'enum', name: 'PipeConnectedAccountState' }, required: true }],
    });
    const barrel = (scopedEnumNames: string[]) => {
      const scoped = {
        ...ctx,
        scopedServices: new Set(['Pipes']),
        scopedModelNames: new Set<string>(),
        scopedEnumNames: new Set(scopedEnumNames),
        priorTargetManifestPaths: new Set([
          'src/workos/common/models/canonical_state.py',
          'src/workos/common/models/pipe_connected_account_state.py',
        ]),
      } as EmitterContext;
      return generateModels(ctx.spec.models, scoped).find((f) => f.path === 'src/workos/common/models/__init__.py')!
        .content;
    };
    const retained = barrel([]);
    expect(retained).toContain('PipeConnectedAccountState');
    expect(retained).toContain('CanonicalStateLiteral');
    expect(retained).not.toContain('PipeConnectedAccountStateLiteral');
    expect(barrel(['PipeConnectedAccountState'])).toContain('PipeConnectedAccountStateLiteral');
  });
});
