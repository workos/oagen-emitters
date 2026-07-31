import { describe, it, expect } from 'vitest';
import { NON_SPEC_SERVICES } from '../../src/shared/non-spec-services.js';
import { generateClient } from '../../src/android/client.js';
import type { ApiSpec, EmitterContext, Service } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';

/**
 * The Android emitter does NOT generate client accessors from NON_SPEC_SERVICES,
 * for the same reason the iOS and Kotlin emitters don't: its staging output has to
 * compile standalone (the smoke runner builds it via Gradle), so a generated
 * accessor referencing a hand-maintained type that only exists in the SDK repo
 * would break the build.
 *
 * Instead every non-spec service is mounted from a hand-maintained Kotlin file in
 * `helpers/` — same module, so a `val {Namespace}Client.passwordless` extension
 * property there is indistinguishable from a generated one at the call site.
 *
 * This test pins the set that hand-maintained layer is expected to cover. Adding an
 * entry to NON_SPEC_SERVICES fails this test until the matching Kotlin helper (and
 * this list) land in the same change.
 */
const ANDROID_HAND_MAINTAINED_COVERAGE = new Set([
  'passwordless', // helpers/Passwordless.kt (extension on the client)
  'webhook_verification', // helpers/WebhookVerification.kt (H01, H02) -- IMPLEMENTED
  'actions', // helpers/Actions.kt (H03) -- IMPLEMENTED
  'session_manager', // helpers/Iron.kt (H06) + helpers/Session.kt (H04, H05, H07) -- IMPLEMENTED
  'pkce', // helpers/Pkce.kt + AuthKit.kt + SSOAuthKit.kt + PublicClient.kt (H08, H10, H15, H19).
  // H16 is not implemented and will not be: POST /sso/token requires client_secret,
  // so a secret-less PKCE exchange is impossible from an app. See helpers/SSOAuthKit.kt.
]);

const emptySpec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: '',
  services: [],
  models: [],
  enums: [],
  sdk: defaultSdkBehavior(),
};

const service: Service = {
  name: 'Organizations',
  operations: [
    {
      name: 'list_organizations',
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
};

const ctx: EmitterContext = {
  namespace: 'workos',
  namespacePascal: 'WorkOS',
  spec: { ...emptySpec, services: [service] },
};

describe('android non-spec service coverage', () => {
  it('covers every NON_SPEC_SERVICES entry with a hand-maintained Kotlin helper', () => {
    const uncovered = NON_SPEC_SERVICES.map((s) => s.id).filter((id) => !ANDROID_HAND_MAINTAINED_COVERAGE.has(id));
    expect(
      uncovered,
      'New non-spec service(s) without an Android hand-maintained helper. Add the ' +
        'client extension in workos-android/src/main/kotlin/com/workos/android/helpers/ ' +
        'and update ANDROID_HAND_MAINTAINED_COVERAGE.',
    ).toEqual([]);
  });

  it('does not generate an accessor for any non-spec service', () => {
    // A generated accessor would reference a type that exists only in the SDK repo,
    // breaking the standalone staging build the smoke runner compiles.
    const accessors = generateClient(ctx)[0].content ?? '';
    for (const svc of NON_SPEC_SERVICES) {
      expect(accessors, `non-spec service '${svc.id}' must not get a generated accessor`).not.toMatch(
        new RegExp(`WorkOSClient\\.${svc.id.replace(/_(.)/g, (_, c: string) => c.toUpperCase())}\\b`, 'i'),
      );
    }
  });
});
