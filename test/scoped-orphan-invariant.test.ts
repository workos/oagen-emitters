import { describe, it, expect } from 'vitest';
import type { ApiSpec, Service, HttpMethod } from '@workos/oagen';
import { generateFiles, defaultSdkBehavior } from '@workos/oagen';
import {
  nodeEmitter,
  pythonEmitter,
  phpEmitter,
  goEmitter,
  dotnetEmitter,
  kotlinEmitter,
  rubyEmitter,
  rustEmitter,
} from '../src/index.js';

/**
 * Cross-language invariant guarding the "scoped-generation orphan" bug class.
 *
 * In a scoped (`--services`) run the engine hands each emitter the emit SURFACE
 * (selected ∪ already-on-disk services). A service the spec HAS but this SDK
 * never generated (neither selected nor present) must NOT appear in any emitted
 * aggregate — a barrel, module index, root-client accessor, `.rbi` sig, or the
 * operations manifest. If it does, that aggregate references a resource/type
 * whose file is never emitted and isn't on disk → a dangling import / orphaned
 * module / undefined symbol / unresolved constant (a build break).
 *
 * `Zephyr` is that never-generated service. `Pipes` is the one selected service.
 * A distinctive name means any occurrence in emitted output is unambiguously an
 * orphan reference (it can't collide with emitter boilerplate).
 *
 * This is the durable guard: it would have caught every instance we found by
 * hand (rust resources barrel, rust resources_api client, rust manifest, ruby
 * client.rbi, node src/workos.ts) — and it will catch the next one, in any
 * language, without anyone having to remember to look.
 */
const NEVER = 'Zephyr';
const SELECTED = 'Pipes';

function op(path: string): Service['operations'][number] {
  return {
    name: `list_${path.replace(/\//g, '')}`,
    httpMethod: 'get' as HttpMethod,
    path,
    pathParams: [],
    queryParams: [],
    headerParams: [],
    response: { kind: 'primitive', type: 'unknown' },
    errors: [],
    injectIdempotencyKey: false,
  };
}
function svc(name: string): Service {
  return { name, operations: [op(`/${name.toLowerCase()}`)] };
}

const driftSpec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: 'https://api.workos.com',
  services: [svc(SELECTED), svc(NEVER)],
  models: [],
  enums: [],
  sdk: defaultSdkBehavior(),
};

const emitters = [
  ['rust', rustEmitter],
  ['ruby', rubyEmitter],
  ['node', nodeEmitter],
  ['python', pythonEmitter],
  ['go', goEmitter],
  ['kotlin', kotlinEmitter],
  ['dotnet', dotnetEmitter],
  ['php', phpEmitter],
] as const;

describe('scoped generation emits no orphan reference to a never-generated service', () => {
  for (const [lang, emitter] of emitters) {
    it(`${lang}: no aggregate references ${NEVER}`, () => {
      const { files, operations } = generateFiles(driftSpec, emitter, {
        namespace: lang === 'php' ? 'WorkOS' : 'workos',
        // Nonexistent → the node live-surface walk returns an empty (greenfield)
        // surface; no on-disk SDK is needed to exercise the scoped orphan path.
        outputDir: '/tmp/oagen-scoped-orphan-invariant-nonexistent',
        scopedServices: new Set([SELECTED]),
      });

      const needle = NEVER.toLowerCase();
      const hits = files.filter((f) => f.content.toLowerCase().includes(needle)).map((f) => f.path);
      // The operations map (rust records `service` here) is returned separately.
      if (operations && JSON.stringify(operations).toLowerCase().includes(needle)) {
        hits.push('<operations manifest>');
      }

      expect(hits, `${lang} referenced never-generated "${NEVER}" in: ${hits.join(', ') || '(none)'}`).toEqual([]);
    });
  }
});
