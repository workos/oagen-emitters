import { describe, it, expect } from 'vitest';
import { NON_SPEC_SERVICES } from '../../src/shared/non-spec-services.js';

/**
 * The Rust emitter does NOT generate client accessors from NON_SPEC_SERVICES:
 * the non-spec services are hand-maintained modules under
 * `workos-rust/src/helpers/`, re-exported through `helpers/mod.rs`.
 *
 * This test pins the set of services that hand-maintained layer is known to
 * cover. When a new entry is added to NON_SPEC_SERVICES, it fails to force the
 * matching Rust module (and this list) to be updated in the same change.
 */
const RUST_HAND_MAINTAINED_COVERAGE = new Set([
  'passwordless', // src/helpers/passwordless.rs
  'webhook_verification', // src/helpers/webhook_verification.rs
  'actions', // src/helpers/actions.rs
  'session_manager', // src/helpers/session.rs + jwks.rs
  'pkce', // src/helpers/pkce.rs + authkit.rs + sso_helpers.rs + public_client.rs
]);

describe('rust non-spec service coverage', () => {
  it('covers every NON_SPEC_SERVICES entry with a hand-maintained Rust module', () => {
    const uncovered = NON_SPEC_SERVICES.map((s) => s.id).filter((id) => !RUST_HAND_MAINTAINED_COVERAGE.has(id));
    expect(
      uncovered,
      'New non-spec service(s) without a Rust hand-maintained module. Add the ' +
        'module under workos-rust/src/helpers/ (and re-export it from helpers/mod.rs) ' +
        'and update RUST_HAND_MAINTAINED_COVERAGE.',
    ).toEqual([]);
  });
});
