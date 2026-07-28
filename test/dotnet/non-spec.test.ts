import { describe, it, expect } from 'vitest';
import { NON_SPEC_SERVICES } from '../../src/shared/non-spec-services.js';

/**
 * The .NET emitter does NOT generate client accessors from NON_SPEC_SERVICES:
 * the non-spec services are hand-maintained C# classes committed in
 * `workos-dotnet`, and `WorkOSClient` exposes them directly.
 *
 * This test pins the set of services that hand-maintained layer is known to
 * cover. When a new entry is added to NON_SPEC_SERVICES, it fails to force the
 * matching .NET class (and this list) to be updated in the same change.
 */
const DOTNET_HAND_MAINTAINED_COVERAGE = new Set([
  'passwordless', // src/WorkOS.net/Services/Passwordless/PasswordlessService.cs
  'webhook_verification', // src/WorkOS.net/Services/Webhooks/
  'actions', // src/WorkOS.net/Services/Actions/
  'session_manager', // src/WorkOS.net/Services/Session/ (SessionService + JwksConfigurationRetriever)
  'pkce', // src/WorkOS.net/Client/Utilities/PkceUtilities.cs
]);

describe('dotnet non-spec service coverage', () => {
  it('covers every NON_SPEC_SERVICES entry with a hand-maintained .NET class', () => {
    const uncovered = NON_SPEC_SERVICES.map((s) => s.id).filter((id) => !DOTNET_HAND_MAINTAINED_COVERAGE.has(id));
    expect(
      uncovered,
      'New non-spec service(s) without a .NET hand-maintained class. Add the ' +
        'class under workos-dotnet/src/WorkOS.net/ (and its accessor on WorkOSClient) ' +
        'and update DOTNET_HAND_MAINTAINED_COVERAGE.',
    ).toEqual([]);
  });
});
