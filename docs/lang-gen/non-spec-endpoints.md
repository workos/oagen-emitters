# Non-spec endpoints and hand-maintained helpers

The inventory behind `prompt-3-non-spec-endpoint-coverage`. These capabilities
exist in the WorkOS API surface but are not (or not fully) generated from the
OpenAPI spec, so each SDK either hand-maintains them or deliberately skips them.

Read this together with `docs/lang-gen/workspace.md` (paths, generation, the
persistence proof) and `src/shared/non-spec-services.ts` (the machine-readable
list of modules that get a generated client accessor).

Nothing here asserts a count. Whether a path is in the spec changes over time, so
every "is this generated?" question is answered by re-resolving the live table:

```bash
cd "$SPEC_REPO"
npx oagen resolve --spec spec/open-api-spec.yaml --format json > /tmp/ops.json
```

## 1. OAuth2 protocol endpoints — skip

Standard OAuth 2.0 / OpenID Connect endpoints served by the WorkOS Connect
authorization server. These are not operations an SDK wraps: they are URLs a
browser redirects to, or that an OAuth library calls directly over plain HTTP. No
WorkOS SDK exposes them as methods, and none should start.

- `GET /.well-known/oauth-authorization-server` — OIDC discovery
- `GET /.well-known/openid-configuration` — OIDC discovery
- `GET /oauth2/authorize` — browser redirect (authorization code flow)
- `POST /oauth2/device_authorization` — device code grant initiation
- `POST /oauth2/introspection` — token introspection (RFC 7662)
- `POST /oauth2/token` — token exchange (authorization_code, client_credentials,
  refresh_token, device_code)
- `POST /oauth2/userinfo` — OIDC userinfo

Reference docs: <https://workos.com/docs/reference/workos-connect>

## 2. Passwordless — hand-maintained

Magic-link passwordless sessions, genuinely absent from the spec. Confirm that by
checking for zero `passwordless` paths in the resolved table rather than trusting
this file.

- `POST /passwordless/sessions` — create a passwordless session
- `POST /passwordless/sessions/:id/send` — email the magic link

Known homes: `src/workos/passwordless.py` (python, `create_session` /
`send_session`), `src/passwordless/passwordless.ts` (node, `createSession` /
`sendSession`). For other languages use `docs/sdk-architecture/{lang}.md`.

## 3. Vault — HTTP surface is spec-driven; local crypto is not

The Vault HTTP API (`/vault/v1/*`) landed in the spec, so newly generated SDKs get
those wrappers from oagen and they belong to **prompt-2**, not prompt-3.
Correspondingly, Vault has no entry in `NON_SPEC_SERVICES`.

What stays hand-maintained in every language is the client-side AES-GCM
`encrypt` / `decrypt` pair (`H18`) — it is pure local cryptography layered over
the data-key endpoints and has no HTTP endpoint of its own, so no amount of spec
coverage will generate it.

Verify the split instead of assuming it:

```bash
node -e "const o=require('/tmp/ops.json');console.log(o.filter(x=>x.path.includes('vault')).length)"
```

A non-zero result means the HTTP surface is generated and prompt-2 owns it. A zero
result means the spec regressed, the endpoint wrappers are back in prompt-3's
scope, and you should say so explicitly rather than quietly widening scope.

Older SDKs (python, node) predate spec coverage and still hand-maintain the whole
Vault module, wrappers included. Go and Elixir already have the split shape:
generated wrappers plus hand-maintained crypto (`vault_crypto.go`,
`lib/workos/vault/crypto.ex`).

## 4. Helper capabilities H01-H19

SDK conveniences, client-side utilities, and higher-level wrappers that are not
straightforward OpenAPI operation mappings. They form a hand-maintained layer that
is distinct from generated endpoint wrappers.

| ID  | Capability                       | Required public surface                                                                                   |
| --- | -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| H01 | `webhook_verify`                 | Verifies webhook signatures and returns a parsed/deserialized event payload                               |
| H02 | `webhook_signature_primitives`   | Lower-level signature parsing and/or computation used by webhook verification                             |
| H03 | `actions_helper`                 | AuthKit Actions request verification and response signing                                                 |
| H04 | `session_cookie_object`          | Session-cookie object that loads sealed session state, authenticates, refreshes, and derives logout info  |
| H05 | `session_cookie_inline`          | Direct convenience methods for common sealed-session operations, no manual object construction            |
| H06 | `session_cookie_raw_seal`        | Raw seal/unseal helpers for session payloads, or an explicitly named equivalent                           |
| H07 | `auth_response_session_sealing`  | Auth/token-exchange flows can return a sealed session artifact directly                                   |
| H08 | `pkce_utilities`                 | Code verifier generation, code challenge generation, and combined pair generation                         |
| H09 | `authkit_authorization_url`      | AuthKit authorization URL builder                                                                         |
| H10 | `authkit_pkce_authorization_url` | AuthKit auth URL that generates PKCE params and state automatically, not just accepts precomputed ones    |
| H11 | `authkit_pkce_code_exchange`     | AuthKit code exchange for PKCE/public-client flows, including `code_verifier`                             |
| H12 | `authkit_device_flow`            | Device authorization initiation plus device-code authentication/polling                                   |
| H13 | `jwks_helper`                    | Fetch JWKS and/or build the JWKS URL needed by token/session verification                                 |
| H14 | `sso_authorization_url`          | SSO authorization URL builder                                                                             |
| H15 | `sso_pkce_authorization_url`     | SSO auth URL that generates PKCE params and state automatically                                           |
| H16 | `sso_pkce_code_exchange`         | SSO token/profile exchange for PKCE/public-client flows, including `code_verifier`                        |
| H17 | `sso_logout_helper`              | SSO logout flow: logout-token generation/authorization and logout redirect URL building                   |
| H18 | `vault_local_crypto`             | Client-side Vault `encrypt` / `decrypt` over the data-key APIs                                            |
| H19 | `public_client_factory`          | Factory or preset for PKCE-only / public-client usage exposing only the helper surface valid in that mode |

### How the IDs map to modules

`NON_SPEC_SERVICES` groups most of these into five modules — `passwordless`,
`webhook_verification` (H01-H02), `actions` (H03), `session_manager` (H04-H07,
H13), and `pkce` (H08-H11, H15, H16, H19). The IDs outside those groups (H12, H14,
H17, H18) live in language-specific homes; find them via
`docs/sdk-architecture/{lang}.md` and `test/{lang}/non-spec.test.ts`.

Read `NON_SPEC_SERVICES` itself rather than this paragraph when the two disagree —
the source file is the authority, and adding an entry there is the only
emitter-side change needed to wire a new non-spec module.

### Requirements for every helper

1. The implementation is checked into the SDK repo. It cannot exist only as a
   local patch to generated output.
2. It lives in a hand-maintained file, a hand-maintained partial, or a
   generator-owned template/copy step that is itself checked in.
3. It is reachable from a stable public SDK surface, not only internal code.
4. It survives regeneration with the same public API.
5. It has an existence test asserting the public entry point, a behavior test
   exercising the happy path, and coverage by the persistence check below.

### Verifying a helper

Steps 1-3 are static; step 4 is the persistence proof.

1. The public entry point exists in the target SDK.
2. The implementation source is hand-maintained, not generated-only — the emitter
   does not write that path, or it writes it with `skipIfExists: true`, or the file
   carries `@oagen-ignore-file`.
3. At least one behavior test covers it, and it passes.
4. Regenerate and confirm the entry point, its file, and its test are unchanged;
   then generate a second time and confirm a zero diff.

Use the persistence procedure in `docs/lang-gen/workspace.md` for step 4. Do
**not** prove persistence with `git checkout . && git clean -fd` in a target SDK:
`git clean -fd` deletes untracked `@oagen-ignore-file` files and `git checkout .`
reverts uncommitted edits to tracked ones, so the "proof" destroys exactly the
hand-maintained work it is supposed to be checking. Commit or snapshot first if a
full-reset proof is genuinely required.

### Acceptance rules

- A language that cannot support the same API shape idiomatically must still
  expose the same capability under a stable, documented public name.
- Not every helper applies to every language. A helper that does not apply is not
  a gap — record it as not-applicable with a reason instead of reporting it
  missing.
- `workos-php-laravel` may delegate to `workos-php`, but the delegation surface
  must itself be checked in and survive regeneration.
- Generated files may call into the helper layer, but must not be the only place
  helper logic lives.
- If a helper spans multiple files, all of them are tracked and restored by the
  normal checkout/generation flow.

### Failure conditions

- The helper exists only in generated code.
- The helper exists in one SDK with no tracked parity task in the others.
- The helper disappears after regeneration.
- The helper exists internally but is not reachable from a stable public surface.
