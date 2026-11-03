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
