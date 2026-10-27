import { describe, it, expect, beforeEach } from 'vitest';
import { dotnetEmitter } from '../../src/dotnet/index.js';
import { discriminatedUnions } from '../../src/dotnet/type-map.js';
import type { EmitterContext, ApiSpec, Model } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';

const emptySpec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: '',
  services: [],
  models: [],
  enums: [],
  sdk: defaultSdkBehavior(),
};

describe('dotnet/reserved type names', () => {
  beforeEach(() => {
    // discriminatedUnions is module-global and accumulates across mapTypeRef calls.
    discriminatedUnions.clear();
  });

  it('declares a union converter under the stepped name its field references', () => {
    const models: Model[] = [
      {
        name: 'Envelope',
        fields: [
          {
            name: 'item',
            required: true,
            type: {
              kind: 'union',
              variants: [
                { kind: 'model', name: 'List' },
                { kind: 'model', name: 'Card' },
              ],
              discriminator: { property: 'kind', mapping: { list: 'List', card: 'Card' } },
            },
          },
        ],
      },
      { name: 'List', fields: [{ name: 'kind', type: { kind: 'literal', value: 'list' }, required: true }] },
      { name: 'Card', fields: [{ name: 'kind', type: { kind: 'literal', value: 'card' }, required: true }] },
    ];
    const ctx: EmitterContext = { namespace: 'workos', namespacePascal: 'WorkOS', spec: { ...emptySpec, models } };

    const files = dotnetEmitter.generateModels!(models, ctx);

    const converter = files.find((f) => f.path.endsWith('DiscriminatorConverter.cs'))!;
    expect(converter).toBeDefined();
    expect(converter.path.endsWith('/ListModelDiscriminatorConverter.cs')).toBe(true);
    expect(converter.content).toContain('public class ListModelDiscriminatorConverter');
    expect(converter.content).toContain('ToObject<ListModel>');
    const envelope = files.find((f) => f.path.endsWith('/Envelope.cs'))!;
    expect(envelope.content).toContain('typeof(ListModelDiscriminatorConverter)');
  });
});
