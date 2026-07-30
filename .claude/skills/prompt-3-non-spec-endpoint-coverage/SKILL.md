---
name: prompt-3-non-spec-endpoint-coverage
description: 'Prompt 3 of the lang-gen sequence: verify every non-spec endpoint and hand-maintained helper (Passwordless, Vault, and helpers H01-H19 — webhooks, actions, sessions, PKCE, AuthKit/SSO URL builders, JWKS) exists, is publicly reachable, is tested, and survives regeneration in a WorkOS SDK. Use when the user says "run prompt-3 for <lang>", "prompt 3 for kotlin", "check non-spec endpoint coverage", or asks about hand-maintained helpers or @oagen-ignore-file protection. <lang> is an oagen emitter id (dotnet, elixir, go, ios, kotlin, node, php, python, ruby, rust).'
---

# Prompt 3: verify non-spec endpoint coverage for {lang}

Substitute `{lang}` with the emitter identifier the user named. If they did not
name one, ask which language first.

**Step 0.** Read `docs/lang-gen/workspace.md` in this repo for path resolution,
the generate command, and the persistence policy. Then read
`docs/lang-gen/non-spec-endpoints.md` — it is the inventory this skill checks
against, covering the OAuth2 skip list, Passwordless, the Vault split, and the
full H01–H19 helper table with their per-helper requirements. Also read
`docs/sdk-architecture/{lang}.md` if present; if it is missing, use the fallbacks
in `workspace.md` and say which you used.

## Key definitions

### Categories of non-spec endpoints

Four categories, detailed in `docs/lang-gen/non-spec-endpoints.md`:

1. **OAuth2 protocol endpoints — SKIP.** Standard OAuth/OIDC URLs
   (`/.well-known/*`, `/oauth2/*`). SDKs do not wrap these.
2. **Passwordless — hand-maintained.** Two endpoints, genuinely absent from the
   spec.
3. **Vault — HTTP surface spec-driven, local crypto (H18) hand-maintained.**
4. **Helpers H01–H19 — hand-maintained.** Webhooks, actions, sessions, PKCE,
   AuthKit/SSO URL builders, JWKS, Vault crypto, public-client factory.

`src/shared/non-spec-services.ts` is the authority for **which modules get a
generated client accessor**. Read `NON_SPEC_SERVICES` in full — its entries carry
`id`, a description mapping it to helper IDs, and `hasClientAccessor`. Adding an
entry there is the only emitter-side change needed to wire a new non-spec module,
and its doc comment lists which emitters consume the list at generate time vs.
pin their coverage in `test/{lang}/non-spec.test.ts`. Where the source file and any
prose disagree, the source file wins.

Which category a path falls into is a **live** question, not a fixed one: paths
migrate into the spec over time and then become prompt-2's scope. Decide from the
resolved table, never from a remembered count. Vault is the current example —
re-resolve and check:

```bash
node -e "const o=require('/tmp/ops.json');console.log(o.filter(x=>x.path.includes('vault')).length)"
```

Non-zero means the HTTP wrappers are generated and prompt-2 owns them; only H18
is in scope here. Zero means the spec regressed, the wrappers are back in scope,
and you should say so explicitly rather than quietly widening scope.

Not every helper applies to every language. A helper that does not apply is not a
gap — record it as not-applicable with a reason rather than reporting it missing.

### "Available"

1. An implementation file exists in the SDK repo, not only in generated output.
2. The class/module is importable from the public SDK surface.
3. All documented methods exist as public methods.

### "Hand-maintained"

1. The file is not overwritten by oagen — either the emitter does not produce it,
   or it is produced with `skipIfExists: true`, or it carries
   `@oagen-ignore-file`.
2. The file is committed to git.
3. It survives regeneration.

## Steps

### Step 1: Read the inventory

Read four things and reconcile them:

1. `docs/lang-gen/non-spec-endpoints.md` — the capability inventory and the
   per-helper requirements.
2. `src/shared/non-spec-services.ts` — the canonical module list, and the
   authority when it disagrees with the doc.
3. `docs/sdk-architecture/{lang}.md` — this language's expected file paths and
   hand-maintained set. Missing for some emitters; fall back per `workspace.md`.
4. `test/{lang}/non-spec.test.ts`, if it exists — the pin asserting this
   language's non-spec coverage. Emitters whose non-spec surface is
   hand-maintained in the target SDK rely on this instead of a generated
   accessor. A language with no pin has weaker guarantees; note that in the report.

Then resolve the operation table (see prompt-2, or
`npx oagen resolve --spec spec/open-api-spec.yaml --format json` from
`$SPEC_REPO`) so you can tell which endpoints are genuinely non-spec rather than
assuming from the inventory.

### Step 2: Verify Passwordless

Confirm the module exists at this language's expected path — e.g.
`src/passwordless/passwordless.ts` (node) exporting `createSession` and
`sendSession` and reachable from the main barrel, or
`src/workos/passwordless.py` (python) with `create_session` and `send_session`
importable from the package. Use `docs/sdk-architecture/{lang}.md` for the actual
path.

### Step 3: Verify Vault's client-side crypto

The Vault HTTP endpoints are spec-driven — prompt-2 covers them. Here, confirm
only that the client-side AES-GCM `encrypt` / `decrypt` pair (H18) exists on the
public surface, is hand-maintained, and is tested.

If the resolve check in the Vault note above returned zero spec paths, widen this
step to every Vault HTTP endpoint listed in
`docs/lang-gen/non-spec-endpoints.md` and flag the spec regression. Note that
older SDKs (python, node) predate spec coverage and still hand-maintain the whole
Vault module including wrappers — that is expected, not a defect.

### Step 4: Verify H01–H19

For each applicable Hxx:

1. **Exists** — a public entry point for the capability is reachable from the SDK
   surface.
2. **Hand-maintained** — the file is not generated-only. Verify oagen does not
   emit a file at that path, or that it uses `skipIfExists: true` /
   `@oagen-ignore-file`.
3. **Tested** — at least one test covers it.

Typical homes (confirm against the language design doc):

- node: `src/webhooks/` (H01–H02), `src/actions/` (H03), session module
  (H04–H07), `src/pkce/` (H08), `src/user-management/` (H09–H12), `src/common/`
  (H13), `src/sso/` (H14–H17), `src/vault/` (H18), a factory module (H19)
- python: `src/workos/webhooks/`, `src/workos/actions/`, `src/workos/session.py`,
  a pkce module, authkit helpers, a jwks module, sso helpers,
  `src/workos/vault.py`, a public-client module

### Step 5: Run the SDK tests

`script/ci` in `$SDK_TARGET` when it exists, otherwise the
language's test command. All tests pass, including those for hand-maintained
modules.

### Step 6: Persistence and idempotency

Follow the persistence section of `docs/lang-gen/workspace.md`. Regenerate with
hand-maintained edits in place, confirm every Passwordless method, Vault method,
and Hxx entry point still exists with the same public API, and confirm tests
still pass. Then generate a second time and confirm hand-maintained files show a
zero diff.

Do **not** `git checkout . && git clean -fd` unless the hand-maintained content
is committed or snapshotted first — `git clean` deletes untracked
`@oagen-ignore-file` files and `git checkout .` reverts uncommitted edits to
tracked ones.

## Acceptance criteria

1. Passwordless `create_session` and `send_session` exist and are publicly
   accessible.
2. Vault's client-side `encrypt` and `decrypt` exist and are publicly accessible
   (the Vault HTTP methods are prompt-2's scope, not this skill's).
3. For each applicable H01–H19: a public entry point exists, the implementation
   lives in a hand-maintained file, and at least one test covers it.
4. All SDK tests pass.
5. Non-spec implementations survive regeneration.
6. Tests still pass after regeneration.
7. A second generation produces no changes to hand-maintained files.

If a helper is missing, implement it in the SDK repo as a hand-maintained file
(marked `@oagen-ignore-file`), not in the emitter.

## Report

Name every missing item by its Hxx ID with what is needed, and name every helper
you determined does not apply to this language. A one-line status per ID beats a
prose summary.
