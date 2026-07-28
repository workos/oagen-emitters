import { describe, it, expect } from 'vitest';
import { NON_SPEC_SERVICES } from '../../src/shared/non-spec-services.js';

/**
 * The Node emitter does NOT generate client accessors from NON_SPEC_SERVICES:
 * `workos-node` is a Scenario A target whose root client (`src/workos.ts`) is
 * hand-maintained and preserved across regeneration via the `--api-surface`
 * compat overlay, so the accessors are already committed in the SDK repo.
 *
 * This test pins the set of services that hand-maintained layer is known to
 * cover. When a new entry is added to NON_SPEC_SERVICES, it fails to force the
 * matching Node module (and this list) to be updated in the same change.
 */
const NODE_HAND_MAINTAINED_COVERAGE = new Set([
  'passwordless', // src/passwordless/passwordless.ts
  'webhook_verification', // src/webhooks/webhooks.ts
  'actions', // src/actions/actions.ts
  'session_manager', // src/user-management/session.ts
  'pkce', // src/pkce/pkce.ts
]);

describe('node non-spec service coverage', () => {
  it('covers every NON_SPEC_SERVICES entry with a hand-maintained Node module', () => {
    const uncovered = NON_SPEC_SERVICES.map((s) => s.id).filter((id) => !NODE_HAND_MAINTAINED_COVERAGE.has(id));
    expect(
      uncovered,
      'New non-spec service(s) without a Node hand-maintained module. Add the ' +
        'module under workos-node/src/ (and its accessor on src/workos.ts) ' +
        'and update NODE_HAND_MAINTAINED_COVERAGE.',
    ).toEqual([]);
  });
});
