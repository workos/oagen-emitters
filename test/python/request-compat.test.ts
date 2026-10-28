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
