import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Service, Model } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateClient } from '../../src/python/client.js';
import { NON_SPEC_SERVICES } from '../../src/shared/non-spec-services.js';

/**
 * The Python emitter consumes NON_SPEC_SERVICES at generate time, but its
 * per-language wiring map (`PYTHON_NON_SPEC_WIRING` in src/python/client.ts)
 * SKIPS ids it has no entry for. A new entry therefore produces no accessor
 * and no error — the same silent-drift failure mode the other nine languages
 * are guarded against.
 *
 * These tests close that hole behaviorally: every NON_SPEC_SERVICES id must
 * either show up as a generated accessor, or be listed below as a documented
 * no-accessor case.
 */
const PYTHON_NO_ACCESSOR = new Map([
  // Webhook verification extends the generated Webhooks service in-place via
  // @oagen-ignore blocks (src/workos/webhooks/), so it needs no accessor.
  ['webhook_verification', 'extends the generated Webhooks service via @oagen-ignore'],
  // Sealed-session helpers hang off the UserManagement service and the
  // standalone src/workos/session.py module, not off the root client.
  ['session_manager', 'src/workos/session.py + UserManagement helpers'],
]);

const models: Model[] = [
  {
    name: 'Organization',
    fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
  },
];

const services: Service[] = [
  {
    name: 'Organizations',
    operations: [
      {
        name: 'listOrganizations',
        httpMethod: 'get',
        path: '/organizations',
        pathParams: [],
        queryParams: [],
        headerParams: [],
        response: { kind: 'model', name: 'Organization' },
        errors: [],
        injectIdempotencyKey: false,
      },
    ],
  },
];

const spec: ApiSpec = {
  name: 'TestAPI',
  version: '1.0.0',
  baseUrl: 'https://api.workos.com',
  services,
  models,
  enums: [],
  sdk: defaultSdkBehavior(),
};

const ctx: EmitterContext = { namespace: 'workos', namespacePascal: 'WorkOS', spec };

function clientSource(): string {
  const client = generateClient(spec, ctx).find((f) => f.path === 'src/workos/_client.py');
  if (!client) throw new Error('src/workos/_client.py was not generated');
  return client.content;
}

describe('python non-spec service coverage', () => {
  it('emits an accessor for every NON_SPEC_SERVICES entry it claims to wire', () => {
    const content = clientSource();

    const uncovered = NON_SPEC_SERVICES.map((s) => s.id).filter((id) => {
      if (PYTHON_NO_ACCESSOR.has(id)) return false;
      return !new RegExp(`\\n    def ${id}\\(`).test(content);
    });

    expect(
      uncovered,
      'New non-spec service(s) with no Python client accessor. Add an entry to ' +
        'PYTHON_NON_SPEC_WIRING in src/python/client.ts (plus the hand-maintained ' +
        'module in workos-python), or document it in PYTHON_NO_ACCESSOR here.',
    ).toEqual([]);
  });

  it('wires the currently expected accessors on both sync and async clients', () => {
    const content = clientSource();

    for (const id of ['passwordless', 'actions', 'pkce']) {
      expect(content).toContain(`    def ${id}(`);
    }
    // Passwordless has a distinct async class; PKCE is sync-only and reused.
    expect(content).toContain('from .passwordless import AsyncPasswordless, Passwordless');
    expect(content).toContain('from .pkce import PKCE');
  });

  it('documents no-accessor ids that are still in NON_SPEC_SERVICES', () => {
    const known = new Set(NON_SPEC_SERVICES.map((s) => s.id));
    const stale = [...PYTHON_NO_ACCESSOR.keys()].filter((id) => !known.has(id));

    expect(stale, 'PYTHON_NO_ACCESSOR lists ids that no longer exist in NON_SPEC_SERVICES.').toEqual([]);
  });
});
