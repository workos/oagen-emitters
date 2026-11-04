import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { ApiSpec, EmitterContext, Model } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateModels } from '../../src/ruby/models.js';

const model: Model = {
  name: 'AuditLogEvent',
  fields: [
    { name: 'occurred_at', type: { kind: 'primitive', type: 'string' }, required: false },
    { name: 'clearable', type: { kind: 'nullable', inner: { kind: 'primitive', type: 'string' } }, required: false },
  ],
};
const spec: ApiSpec = {
  name: 'Test',
  version: '1',
  baseUrl: '',
  services: [],
  models: [model],
  enums: [],
  sdk: defaultSdkBehavior(),
};
const ctx: EmitterContext = { namespace: 'workos', namespacePascal: 'WorkOS', spec };

describe('ruby model field compatibility', () => {
  it('omits absent formerly-required fields and preserves explicit nullable fields', () => {
    const compatible = {
      ...ctx,
      emitterOptions: { modelRequiredFieldOrder: { AuditLogEvent: ['occurred_at', 'clearable'] } },
    };
    const content = generateModels([model], compatible)[0]!.content;
    expect(content).toContain('def to_h');
    expect(content).toContain('value.nil? && [:"occurred_at"].include?(key)');
    expect(content).not.toContain('[:"occurred_at", :"clearable"]');
  });

  it('leaves model serialization unchanged without compatibility configuration', () => {
    expect(generateModels([model], ctx)[0]!.content).not.toContain('def to_h');
  });
});

const hasRuby = spawnSync('ruby', ['--version'], { encoding: 'utf8' }).status === 0;

it('does not alias configured and unconfigured models with identical fields', () => {
  const models: Model[] = ['Alpha', 'Beta', 'Gamma'].map((name) => ({ ...model, name }));
  const compatible: EmitterContext = {
    ...ctx,
    spec: { ...spec, models },
    emitterOptions: { modelRequiredFieldOrder: { Beta: ['occurred_at'], Gamma: ['occurred_at'] } },
  };
  const files = generateModels(models, compatible);
  expect(files.find((f) => f.path.endsWith('/alpha.rb'))!.content).toContain('class Alpha');
  expect(files.find((f) => f.path.endsWith('/beta.rb'))!.content).toContain('class Beta');
  expect(files.find((f) => f.path.endsWith('/beta.rb'))!.content).toContain('def to_h');
  expect(files.find((f) => f.path.endsWith('/gamma.rb'))!.content).toContain('Gamma = Beta');
});

it.skipIf(!hasRuby)(
  'omits absent configured collections and preserves explicit empty collections and nullable behavior',
  () => {
    const collections: Model = {
      name: 'Collections',
      fields: [
        { name: 'items', type: { kind: 'array', items: { kind: 'primitive', type: 'string' } }, required: false },
        { name: 'labels', type: { kind: 'map', valueType: { kind: 'primitive', type: 'string' } }, required: false },
        {
          name: 'clearable',
          type: { kind: 'nullable', inner: { kind: 'map', valueType: { kind: 'primitive', type: 'string' } } },
          required: false,
        },
      ],
    };
    const compatible: EmitterContext = {
      ...ctx,
      spec: { ...spec, models: [collections] },
      emitterOptions: { modelRequiredFieldOrder: { Collections: ['items', 'labels', 'clearable'] } },
    };
    const content = generateModels([collections], compatible)[0]!.content;
    const script = `require 'json'
module WorkOS
  module Types
    class BaseModel
      def self.normalize(value); value; end
      def to_h
        self.class::HASH_ATTRS.to_h { |key, name| [key, instance_variable_get("@#{name}")] }
      end
    end
  end
end
${content}
puts JSON.generate([
  WorkOS::Collections.new({}).to_h,
  WorkOS::Collections.new({items: [], labels: {}, clearable: nil}).to_h,
  WorkOS::Collections.new({items: ['a'], labels: {key: 'value'}}).to_h
])`;
    const run = spawnSync('ruby', ['-e', script], { encoding: 'utf8' });
    expect(run.status, run.stderr || run.stdout).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual([
      { clearable: {} },
      { items: [], labels: {}, clearable: {} },
      { items: ['a'], labels: { key: 'value' }, clearable: {} },
    ]);
  },
);
