/**
 * Non-spec services: hand-maintained modules that are wired into the
 * generated client class alongside the spec-driven service accessors.
 *
 * Each entry describes one hand-maintained module. Emitters translate these
 * to language-idiomatic class names, property names, and import paths.
 *
 * Adding a new non-spec service here is the *only* change needed in the
 * emitter repo — each language emitter reads this list and generates the
 * appropriate client accessor.
 */
export interface NonSpecService {
  /** Logical identifier (snake_case). Used as the canonical key. */
  id: string;

  /**
   * Human-readable description.  Not emitted anywhere — exists so that
   * someone reading this file understands what the service does.
   */
  description: string;

  /**
   * When true, the generated Client struct includes a cached field for this
   * service and a public accessor method — identical to spec-driven services.
   * The hand-written file must export the service type (e.g. PasswordlessService)
   * but should NOT define its own Client accessor (the generated code handles that).
   *
   * Defaults to false — most non-spec modules are standalone helpers, not
   * Client-mounted services.
   */
  hasClientAccessor?: boolean;
}

/**
 * The canonical list of non-spec services that every SDK must expose.
 *
 * Order here determines emission order in the generated client.
 *
 * Not every emitter consumes this list at generate time: emitters whose
 * non-spec surface is hand-maintained in the target SDK (ios, kotlin via
 * same-module extensions — a generated accessor would reference a
 * hand-maintained type that does not exist in staging — and elixir via
 * standalone modules) pin their coverage of this list with a unit test
 * (`test/ios/non-spec.test.ts`, `test/kotlin/non-spec.test.ts`,
 * `test/elixir/non-spec.test.ts`; php pins via `test/php/client.test.ts`)
 * so adding an entry here fails their build until the helper exists.
 */
export const NON_SPEC_SERVICES: readonly NonSpecService[] = [
  {
    id: 'passwordless',
    description: 'Passwordless (magic-link) session endpoints, not yet in the OpenAPI spec.',
    hasClientAccessor: true,
  },
  {
    id: 'webhook_verification',
    description: 'Webhook signature verification and event deserialization (H01/H02).',
  },
  {
    id: 'actions',
    description: 'AuthKit Actions request verification and response signing (H03).',
  },
  {
    id: 'session_manager',
    description: 'Sealed session cookies, JWT validation, JWKS helpers (H04-H07, H13).',
  },
  {
    id: 'pkce',
    description:
      'PKCE utilities, AuthKit/SSO PKCE URL builders, code exchange, public client factory (H08-H11, H15, H16, H19).',
  },
] as const;
