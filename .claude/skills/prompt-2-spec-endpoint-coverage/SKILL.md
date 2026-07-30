---
name: prompt-2-spec-endpoint-coverage
description: 'Prompt 2 of the lang-gen sequence: verify every OpenAPI spec operation is mounted on the right resource class, named correctly, publicly available, and covered by a generated test in a WorkOS SDK. Use when the user says "run prompt-2 for <lang>", "prompt 2 for kotlin", "check spec endpoint coverage", or asks about mount correctness, override names, or union-split wrapper methods. <lang> is an oagen emitter id (dotnet, elixir, go, ios, kotlin, node, php, python, ruby, rust).'
---

# Prompt 2: verify spec endpoint coverage for {lang}

Substitute `{lang}` with the emitter identifier the user named. If they did not
name one, ask which language first.

**Step 0.** Read `docs/lang-gen/workspace.md` in this repo for path resolution,
the generate command, and the persistence policy. Also read
`docs/sdk-architecture/{lang}.md` if present — it exists for a subset of emitters,
and `workspace.md` lists what to derive from code when it does not.

## Key definitions

### "Mounted correctly"

The operation table is **derived live**, never read from a saved copy:

```bash
cd "$SPEC_REPO"
npx oagen resolve --spec spec/open-api-spec.yaml --format json > /tmp/ops.json
```

Each entry has `service`, `method`, `path`, `derivedName`, `hintApplied`, and
`mountOn`. Count `/tmp/ops.json` for the total — do not assume one.

1. Each operation's method exists on the resource class named by `mountOn`.
2. The method name is `derivedName`, converted to the language convention by the
   emitter — camelCase for node/php/kotlin/ios, snake_case for
   python/ruby/rust/elixir, and so on per `docs/sdk-architecture/{lang}.md`.
   `derivedName` is already post-hint, so it _is_ the expected name;
   `hintApplied: false` flags an operation running on the raw derivation with no
   override, which is worth a second look.
3. Multiple IR services that mount to the same target merge into **one** resource
   class. `UserManagementUsers`, `UserManagementInvitations`,
   `UserManagementMagicAuth` and the rest all mount on `UserManagement`, so their
   methods must live on a single class rather than being scattered.
4. The mapping is configured in `$SPEC_REPO/oagen.config.ts`
   (`operationHints` with `mountOn`, plus `mountRules`), and resolved by the
   shared `src/shared/resolved-ops.ts`.

### "Every endpoint available"

Every row has a public SDK method that:

1. Issues an HTTP request to the correct path with the correct HTTP method.
2. Takes the correct parameters — path params, query params, body.
3. Union-split operations produce multiple wrapper methods. Confirm the current
   split set from the emitter/config rather than from memory; historically:
   - `POST /user_management/authenticate` → 8 wrappers
     (`authenticate_with_password`, `_code`, `_refresh_token`, `_magic_auth`,
     `_email_verification`, `_totp`, `_organization_selection`, `_device_code`)
   - `POST /connect/applications` → `create_oauth_application` and
     `create_m2m_application`
4. Carries through spec documentation wherever the language supports doc
   comments, including deprecation markers.

### "Tested"

Every endpoint method has at least one generated test that mocks the HTTP
response, calls the method, and asserts correct deserialization and request
wiring.

## Steps

### Step 1: Read the sources of truth

Resolve `/tmp/ops.json` as shown above and build a model of every operation, its
expected method name, its mount target, and the union-split variants. Then read
`operationHints` and `mountRules` in `$SPEC_REPO/oagen.config.ts` and
`src/shared/resolved-ops.ts`.

If you want the human-readable review table, invoke the
`/oagen:review-operations` skill — it renders this same resolve output. It ships
with the `oagen` package, so it is only available when the oagen plugin is
installed; if it is not, work from the JSON directly. Either way, do not go
looking for a checked-in copy of the table: there isn't one, `docs/archive/` holds
a frozen node-only snapshot that is not it, and any rendering you find elsewhere
is stale.

### Step 2: Generate the SDK

Per the Generation section of `docs/lang-gen/workspace.md`. Must exit 0.

### Step 3: Verify mount correctness

For each row in the operation table:

1. The method exists as a public method on the correct resource class.
2. The client file exposes the resource via the correct accessor — e.g.
   `src/workos.ts` for node, `src/workos/_client.py` for python,
   `lib/WorkOS.php` for php. Check `docs/sdk-architecture/{lang}.md` for this
   language's client file and accessor style; if there is no design doc, find the
   client by reading what `src/{lang}/client.ts` emits and say that is how you
   located it.
3. All operations sharing a mount target land on one class, not several.
4. Every `authenticate_with_*` variant exists on UserManagement.
5. Both connect-application wrappers exist on Connect.
6. Spec descriptions reach the generated surface where supported — endpoint
   methods have doc blocks, and models carry property/constructor docs.

Prefer a scripted cross-check (parse the table, grep the generated surface) over
eyeballing rows; report any row you could not verify mechanically.

### Step 4: Verify test coverage

Confirm a test exists per operation, in this language's test layout — e.g.
`src/<service-dir>/<service>.spec.ts` (node), `tests/test_<service>.py`
(python), `tests/Resources/<Service>Test.php` (php). Use
`docs/sdk-architecture/{lang}.md` for the actual convention.

### Step 5: Run the SDK tests

`script/ci` in `$SDK_TARGET` when it exists, otherwise the
language's test command. All must pass.

### Step 6: Persistence and idempotency

Follow the persistence section of `docs/lang-gen/workspace.md`: regenerate with
hand-maintained edits in place and confirm they are untouched, then generate a
second time and confirm `git diff --stat` shows zero changes. Do **not**
`git checkout . && git clean -fd` unless the hand-maintained content is committed
or snapshotted first.

## Acceptance criteria

1. Every operation in the resolved table has a corresponding SDK method.
2. Every method is on the resource class named by its `mountOn`.
3. Every method name matches its `derivedName` under the language's casing rule.
4. All `authenticate_with_*` variants exist on UserManagement.
5. Both connect-application wrappers exist on Connect.
6. Generated docs carry spec descriptions and deprecation signals where the
   language supports them.
7. Every operation has at least one generated test.
8. All tests pass.
9. Hand-maintained files survive regeneration.
10. A second consecutive generation produces no file changes.

On failure, fix `src/{lang}/` (or `src/shared/` when the rule is
cross-language) and repeat from Step 2. Never hand-edit `workos-{lang}` outside
`@oagen-ignore-file` files.

## Report

List missing, misnamed, or mis-mounted operations explicitly — one line each
with the expected name, expected class, and what was found. Do not summarize a
gap as "mostly covered".
