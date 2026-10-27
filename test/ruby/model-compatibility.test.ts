import { spawnSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import type { ApiSpec, EmitterContext, Model } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateModels } from '../../src/ruby/models.js';
import { generateRbiFiles } from '../../src/ruby/rbi.js';

const account: Model = {
  name: 'ConnectedAccount',
  fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
};
const warning: Model = {
  name: 'ConnectedAccountWriteResponseWarning',
  fields: [{ name: 'code', type: { kind: 'primitive', type: 'string' }, required: true }],
};
const response: Model = {
  name: 'ConnectedAccountWriteResponse',
  fields: [
    ...account.fields,
    { name: 'warnings', type: { kind: 'array', items: { kind: 'model', name: warning.name } }, required: false },
  ],
};

function context(models: Model[] = [account, warning, response]): EmitterContext {
  const spec: ApiSpec = {
    name: 'Test',
    version: '1.0.0',
    baseUrl: '',
    services: [],
    models,
    enums: [],
    sdk: defaultSdkBehavior(),
  };
  return { namespace: 'workos', namespacePascal: 'WorkOS', spec };
}

const hasRuby = spawnSync('ruby', ['--version']).status === 0;

describe('ruby connected-account response compatibility', () => {
  it('declares the compatibility superclass in both runtime and RBI without losing warnings', () => {
    const ctx = context();
    const runtime = generateModels(ctx.spec.models, ctx);
    const rbi = generateRbiFiles(ctx.spec, ctx);
    for (const files of [runtime, rbi]) {
      const content = files.find((f) => /\/connected_account_write_response\.rb[i]?$/.test(f.path))!.content;
      expect(content).toContain('class ConnectedAccountWriteResponse < WorkOS::ConnectedAccount');
      expect(content).toContain('warnings');
    }
    expect(runtime.find((f) => f.path.endsWith('/connected_account.rb'))!.content).toContain(
      'class ConnectedAccount < WorkOS::Types::BaseModel',
    );
  });

  it('also emits the base model and RBI when only the write response is in scope', () => {
    const ctx = context();
    ctx.scopedServices = new Set(['Pipes']);
    ctx.scopedModelNames = new Set([response.name, warning.name]);
    for (const files of [generateModels(ctx.spec.models, ctx), generateRbiFiles(ctx.spec, ctx)]) {
      expect(files.some((f) => /\/connected_account\.rb[i]?$/.test(f.path))).toBe(true);
    }
  });

  it('does not reference a superclass absent from the input spec', () => {
    const ctx = context([warning, response]);
    expect(
      generateModels(ctx.spec.models, ctx).find((f) => f.path.endsWith('/connected_account_write_response.rb'))!
        .content,
    ).toContain('class ConnectedAccountWriteResponse < WorkOS::Types::BaseModel');
    expect(
      generateRbiFiles(ctx.spec, ctx).find((f) => f.path.endsWith('/connected_account_write_response.rbi'))!.content,
    ).not.toContain('< WorkOS::ConnectedAccount');
  });

  it.skipIf(!hasRuby)('hydrates the richer response as a ConnectedAccount and retains serialized warnings', () => {
    const ctx = context();
    const files = generateModels(ctx.spec.models, ctx);
    const result = spawnSync(
      'ruby',
      [
        '-rjson',
        '-e',
        `
module WorkOS
  module Types
    class BaseModel
      def self.normalize(json)
        json.is_a?(String) ? JSON.parse(json, symbolize_names: true) : json.transform_keys(&:to_sym)
      end
      def to_h
        self.class::HASH_ATTRS.transform_values { |name| public_send(name) }
      end
      def to_json(*)
        to_h.to_json
      end
    end
  end
end
JSON.parse(STDIN.read).each { |file| eval(file.fetch('content'), TOPLEVEL_BINDING, file.fetch('path')) }
value = WorkOS::ConnectedAccountWriteResponse.new(id: 'ca_1', warnings: [{code: 'test_warning'}])
raise 'nominal compatibility' unless value.is_a?(WorkOS::ConnectedAccount)
raise 'case compatibility' unless WorkOS::ConnectedAccount === value
raise 'field hydration' unless value.id == 'ca_1' && value.warnings.first.code == 'test_warning'
raise 'serialization' unless JSON.parse(value.to_json) == {'id' => 'ca_1', 'warnings' => [{'code' => 'test_warning'}]}
`,
      ],
      { input: JSON.stringify(files), encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 10000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });
});
