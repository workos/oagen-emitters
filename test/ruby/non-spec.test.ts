import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Service, Model } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateClient } from '../../src/ruby/client.js';
import { NON_SPEC_SERVICES } from '../../src/shared/non-spec-services.js';

/**
 * The Ruby emitter consumes NON_SPEC_SERVICES at generate time, but its
 * per-language wiring map (`NON_SPEC_ACCESSORS` in src/ruby/client.ts) SKIPS
 * ids it has no entry for. A new entry therefore produces no accessor and no
 * error — the same silent-drift failure mode the other nine languages are
 * guarded against.
 *
 * These tests close that hole behaviorally: every NON_SPEC_SERVICES id must
 * either show up as a generated `Client#accessor`, or be listed below as a
 * documented no-accessor case.
 */
const RUBY_NO_ACCESSOR = new Map([
  // Webhook verification extends the already-generated Webhooks service via
  // @oagen-ignore blocks, so it needs no dedicated Client accessor.
  ['webhook_verification', 'extends the generated Webhooks service via @oagen-ignore'],
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
  name: 'Test',
  version: '1.0.0',
  baseUrl: 'https://api.example.com',
  services,
  models,
  enums: [],
  sdk: defaultSdkBehavior(),
};

const ctx: EmitterContext = { namespace: 'workos', namespacePascal: 'WorkOS', spec };

function clientSource(): string {
  const client = generateClient(spec, ctx).find((f) => f.path === 'lib/workos/client.rb');
  if (!client) throw new Error('lib/workos/client.rb was not generated');
  return client.content;
}

describe('ruby non-spec service coverage', () => {
  it('emits an accessor for every NON_SPEC_SERVICES entry it claims to wire', () => {
    const content = clientSource();

    const uncovered = NON_SPEC_SERVICES.map((s) => s.id).filter((id) => {
      if (RUBY_NO_ACCESSOR.has(id)) return false;
      return !new RegExp(`\\n    def ${id}\\b`).test(content);
    });

    expect(
      uncovered,
      'New non-spec service(s) with no Ruby client accessor. Add an entry to ' +
        'NON_SPEC_ACCESSORS in src/ruby/client.ts (plus the hand-maintained class ' +
        'in workos-ruby), or document it in RUBY_NO_ACCESSOR here.',
    ).toEqual([]);
  });

  it('wires the currently expected accessors', () => {
    const content = clientSource();

    expect(content).toContain('@passwordless ||= WorkOS::Passwordless.new(self)');
    expect(content).toContain('@actions ||= WorkOS::Actions.new(self)');
    expect(content).toContain('@session_manager ||= WorkOS::SessionManager.new(self)');
    // PKCE is a module with module-level functions — returned directly.
    expect(content).toContain('@pkce ||= WorkOS::PKCE');
  });

  it('documents no-accessor ids that are still in NON_SPEC_SERVICES', () => {
    const known = new Set(NON_SPEC_SERVICES.map((s) => s.id));
    const stale = [...RUBY_NO_ACCESSOR.keys()].filter((id) => !known.has(id));

    expect(stale, 'RUBY_NO_ACCESSOR lists ids that no longer exist in NON_SPEC_SERVICES.').toEqual([]);
  });
});
