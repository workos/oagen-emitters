import { describe, it, expect } from 'vitest';
import { NON_SPEC_SERVICES } from '../../src/shared/non-spec-services.js';

/**
 * The Elixir emitter does NOT generate client accessors from
 * NON_SPEC_SERVICES: Elixir resources are standalone modules that take the
 * client as their first argument, so there is nothing to wire into a client
 * class. Every non-spec service is instead a hand-maintained module committed
 * in `workos-elixir/lib/workos/` (marked `@oagen-ignore-file`).
 *
 * This test pins the set of services that hand-maintained layer is known to
 * cover. When a new entry is added to NON_SPEC_SERVICES, it fails to force
 * the matching Elixir helper (and this list) to be updated in the same change.
 */
const ELIXIR_HAND_MAINTAINED_COVERAGE = new Set([
  'passwordless', // lib/workos/passwordless.ex
  'webhook_verification', // lib/workos/webhooks/signature.ex
  'actions', // lib/workos/actions.ex
  'session_manager', // lib/workos/session.ex + jwks.ex
  'pkce', // lib/workos/pkce.ex + authkit.ex + sso/pkce.ex + public_client.ex
]);

describe('elixir non-spec service coverage', () => {
  it('covers every NON_SPEC_SERVICES entry with a hand-maintained Elixir module', () => {
    const uncovered = NON_SPEC_SERVICES.map((s) => s.id).filter((id) => !ELIXIR_HAND_MAINTAINED_COVERAGE.has(id));
    expect(
      uncovered,
      'New non-spec service(s) without an Elixir hand-maintained module. Add the ' +
        'module in workos-elixir/lib/workos/ (with @oagen-ignore-file) ' +
        'and update ELIXIR_HAND_MAINTAINED_COVERAGE.',
    ).toEqual([]);
  });
});
