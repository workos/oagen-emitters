import { describe, it, expect } from 'vitest';
import { NON_SPEC_SERVICES } from '../../src/shared/non-spec-services.js';

/**
 * The iOS emitter does NOT generate client accessors from NON_SPEC_SERVICES:
 * its staging output must build standalone (the smoke runner compiles it), so
 * a generated accessor referencing a hand-maintained type would break the
 * build. Instead, every non-spec service is mounted via a hand-maintained
 * `extension WorkOSClient` in `workos-ios/Sources/WorkOS/Helpers/` (same
 * module, identical public surface).
 *
 * This test pins the set of services that hand-maintained layer is known to
 * cover. When a new entry is added to NON_SPEC_SERVICES, it fails to force
 * the matching Swift helper (and this list) to be updated in the same change.
 */
const IOS_HAND_MAINTAINED_COVERAGE = new Set([
  'passwordless', // Helpers/Passwordless.swift (extension WorkOSClient)
  'webhook_verification', // Helpers/WebhookVerification.swift
  'actions', // Helpers/ActionsHelper.swift
  'session_manager', // Helpers/SessionHelpers.swift + SessionSealing.swift + JWKSHelpers.swift
  'pkce', // Helpers/PKCE.swift + AuthKitHelpers.swift + SSOHelpers.swift + PublicClient.swift
]);

describe('ios non-spec service coverage', () => {
  it('covers every NON_SPEC_SERVICES entry with a hand-maintained Swift helper', () => {
    const uncovered = NON_SPEC_SERVICES.map((s) => s.id).filter((id) => !IOS_HAND_MAINTAINED_COVERAGE.has(id));
    expect(
      uncovered,
      'New non-spec service(s) without an iOS hand-maintained helper. Add the ' +
        '`extension WorkOSClient` helper in workos-ios/Sources/WorkOS/Helpers/ ' +
        'and update IOS_HAND_MAINTAINED_COVERAGE.',
    ).toEqual([]);
  });
});
