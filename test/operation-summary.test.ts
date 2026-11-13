import { describe, expect, it } from 'vitest';
import type { ApiSpec, EmitterContext, GeneratedFile, Service } from '@workos/oagen';
import { defaultSdkBehavior, resolveOperations } from '@workos/oagen';
import { generateResources as androidResources } from '../src/android/resources.js';
import { generateResources as dotnetResources } from '../src/dotnet/resources.js';
import { generateResources as elixirResources } from '../src/elixir/resources.js';
import { generateResources as goResources } from '../src/go/resources.js';
import { generateResources as iosResources } from '../src/ios/resources.js';
import { generateResources as kotlinResources } from '../src/kotlin/resources.js';
import { generateResources as nodeResources } from '../src/node/resources.js';
import { generateResources as phpResources } from '../src/php/resources.js';
import { generateResources as pythonResources } from '../src/python/resources.js';
import { generateResources as rubyResources } from '../src/ruby/resources.js';
import { generateResources as rustResources } from '../src/rust/resources.js';
import { UnionRegistry } from '../src/rust/type-map.js';

// The IR carries an operation's `summary` apart from its `description`, so an
// emitter that reads the description alone drops the label each documented
// method opens with. Every emitter documents a method through
// `operationDoc`; this pins that for all of them.

const SUMMARY = 'Fetch a widget';
const DESCRIPTION = 'Returns the widget with its current configuration.';

function services(doc: { summary?: string; description?: string }): Service[] {
  return [
    {
      name: 'Widgets',
      operations: [
        {
          name: 'getWidget',
          httpMethod: 'get',
          path: '/widgets/{id}',
          pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
          queryParams: [],
          headerParams: [],
          response: { kind: 'model', name: 'Widget' },
          ...doc,
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    },
  ];
}

function context(svcs: Service[]): EmitterContext {
  const spec: ApiSpec = {
    name: 'Test',
    version: '1.0.0',
    baseUrl: '',
    services: svcs,
    models: [{ name: 'Widget', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] }],
    enums: [],
    sdk: defaultSdkBehavior(),
  };
  return { namespace: 'workos', namespacePascal: 'WorkOS', spec, resolvedOperations: resolveOperations(spec) };
}

const emitters: [string, (svcs: Service[], ctx: EmitterContext) => GeneratedFile[]][] = [
  ['android', androidResources],
  ['dotnet', dotnetResources],
  ['elixir', elixirResources],
  ['go', goResources],
  ['ios', iosResources],
  ['kotlin', kotlinResources],
  ['node', nodeResources],
  ['php', phpResources],
  ['python', pythonResources],
  ['ruby', rubyResources],
  ['rust', (svcs, ctx) => rustResources(svcs, ctx, new UnionRegistry())],
];

/** Generated resource source, lowercased: Go lowercases the summary's first word. */
function render(generate: (svcs: Service[], ctx: EmitterContext) => GeneratedFile[], svcs: Service[]): string {
  return generate(svcs, context(svcs))
    .map((file) => file.content)
    .join('\n')
    .toLowerCase();
}

describe('operation summary in method docs', () => {
  it.each(emitters)('%s leads the method doc with the summary', (lang, generate) => {
    const source = render(generate, services({ summary: SUMMARY, description: DESCRIPTION }));
    const summaryAt = source.indexOf(SUMMARY.toLowerCase());
    expect(summaryAt).toBeGreaterThan(-1);

    // Ruby documents a method with the lead line alone, so the summary takes
    // the place the description's first line would otherwise hold.
    if (lang === 'ruby') {
      expect(source).not.toContain(DESCRIPTION.toLowerCase());
      return;
    }
    expect(source.indexOf(DESCRIPTION.toLowerCase())).toBeGreaterThan(summaryAt);
  });

  it.each(emitters)('%s documents a summary-only operation with its summary', (_lang, generate) => {
    expect(render(generate, services({ summary: SUMMARY }))).toContain(SUMMARY.toLowerCase());
  });

  it.each(emitters)('%s documents a description-only operation with its description', (_lang, generate) => {
    const source = render(generate, services({ description: DESCRIPTION }));
    expect(source).toContain(DESCRIPTION.toLowerCase());
    expect(source).not.toContain(SUMMARY.toLowerCase());
  });
});
