import { describe, it, expect } from 'vitest';
import { NON_SPEC_SERVICES } from '../../src/shared/non-spec-services.js';

/**
 * The Kotlin emitter does NOT generate client accessors from
 * NON_SPEC_SERVICES: its staging output must build standalone, so a generated
 * accessor referencing a hand-maintained type would break the build. Instead,
 * every non-spec service is mounted via hand-maintained files committed in
 * `workos-kotlin/src/main/kotlin/com/workos/` (same module, identical public
 * surface).
 *
 * This test pins the set of services that hand-maintained layer is known to
 * cover. When a new entry is added to NON_SPEC_SERVICES, it fails to force
 * the matching Kotlin helper (and this list) to be updated in the same change.
 */
const KOTLIN_HAND_MAINTAINED_COVERAGE = new Set([
  'passwordless', // passwordless/Passwordless.kt
  'webhook_verification', // webhooks/Webhooks.kt + Webhook.kt
  'actions', // actions/Actions.kt
  'session_manager', // session/Session.kt + Iron.kt
  'pkce', // pkce/PKCE.kt + usermanagement/AuthKitAuthUrls.kt + DeviceFlow.kt + sso/SSOAuthUrls.kt + PublicClient.kt
]);

describe('kotlin non-spec service coverage', () => {
  it('covers every NON_SPEC_SERVICES entry with a hand-maintained Kotlin helper', () => {
    const uncovered = NON_SPEC_SERVICES.map((s) => s.id).filter((id) => !KOTLIN_HAND_MAINTAINED_COVERAGE.has(id));
    expect(
      uncovered,
      'New non-spec service(s) without a Kotlin hand-maintained helper. Add the ' +
        'helper in workos-kotlin/src/main/kotlin/com/workos/ ' +
        'and update KOTLIN_HAND_MAINTAINED_COVERAGE.',
    ).toEqual([]);
  });
});
