# lang-gen workspace: paths, commands, and invariants

Shared reference for the `prompt-1` … `prompt-5` skills. Read this once at the
start of any of them, then follow that skill's steps.

Every source of truth these skills depend on lives **inside this repo**. The only
external paths are the two that generation physically requires: the spec repo and
the target SDK repo. Both are resolvable and overridable — see below.

## Root resolution

```bash
EMITTERS="$(git rev-parse --show-toplevel)"     # this repo (oagen-emitters)
SPEC_REPO="${OAGEN_SPEC_REPO:-$(dirname "$EMITTERS")/openapi-spec}"
SDK_TARGET="${OAGEN_SDK_TARGET:-$(dirname "$EMITTERS")/backend/workos-{lang}}"
```

`$EMITTERS` must end in `oagen-emitters`; if it does not, you are in the wrong
repo — stop and say so.

`$SPEC_REPO` and `$SDK_TARGET` default to a sibling checkout layout. If either
does not exist, say which one is missing and how to point at it
(`OAGEN_SPEC_REPO=…`) rather than guessing at another location.

## Sources of truth (all in this repo)

| What                  | Where                                   | Notes                                                                                                                                                                                                        |
| --------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime contract      | `docs/lang-gen/sdk-runtime-contract.md` | The cross-language quality bar. 7 sections; §6 (generated test minimums) is the one emitters actually fail. `src/python/tests.ts` is the reference implementation — mirror it rather than inventing a shape. |
| Non-spec inventory    | `docs/lang-gen/non-spec-endpoints.md`   | The OAuth2 skip list, Passwordless, the Vault spec/crypto split, and the H01–H19 helper table with their verification rules.                                                                                 |
| Per-language design   | `docs/sdk-architecture/{lang}.md`       | File layout, generated vs. hand-maintained split, naming conventions. Authoritative for anything language-specific — **but it does not exist for every emitter**; see below.                                 |
| Non-spec service list | `src/shared/non-spec-services.ts`       | `NON_SPEC_SERVICES` — the canonical list of hand-maintained modules that get a generated client accessor. Its comments map each entry to helper IDs (H01–H19).                                               |
| Shared mount logic    | `src/shared/resolved-ops.ts`            | Mount target resolution; must not be reimplemented per language.                                                                                                                                             |
| Emitter source        | `src/{lang}/`                           | The only place to fix generated-output defects.                                                                                                                                                              |
| Emitter tests         | `test/{lang}/`                          | vitest unit tests, including the `non-spec.test.ts` coverage pins.                                                                                                                                           |

Emitters currently in `src/`: `android`, `dotnet`, `elixir`, `go`, `ios`, `kotlin`,
`node`, `php`, `python`, `ruby`, `rust`. Confirm with `ls src` rather than trusting
this list — and note that `compat`, `shared`, and `snippets` are also directories
under `src/` but are not emitters.

`android` and `kotlin` are both Kotlin emitters and are **not** interchangeable.
`kotlin` targets the JVM and uses Jackson; `android` uses kotlinx.serialization
(compile-time serializers, no reflection, no R8 keep rules) and emits `suspend`
methods. Pick by target runtime, not by language name.

`{lang}` is the **emitter identifier**, not the language name — `dotnet` emits C#
into `workos-dotnet`, `ios` emits Swift, `node` emits TypeScript.

### When `docs/sdk-architecture/{lang}.md` is missing

The design docs cover a subset of emitters (currently `android`, `dotnet`,
`elixir`, `go`, `ios`, `node`, `php`, `python`, `rust`; `kotlin` and `ruby` have
none). A missing
doc is not a reason to stop, and it is not a licence to guess — derive the same
facts from code and say that you did:

- **generated vs. hand-maintained split** — grep the target SDK for
  `@oagen-ignore-file`, and check which paths the emitter writes with
  `skipIfExists: true`.
- **file layout and naming convention** — read `src/{lang}/index.ts` and the
  existing generated output.
- **expected non-spec surface** — read `test/{lang}/non-spec.test.ts`, which pins
  it for most emitters (`go` and `php` currently have no pin).

Report which of these you fell back to, so the gap is visible rather than papered
over. Writing the missing design doc is a reasonable follow-up, not a prerequisite.

### Stale artifacts to ignore

`docs/archive/` holds frozen snapshots kept for history, including a node-only
endpoint-coverage table. Nothing keeps them current. Never treat anything in
`docs/archive/` as a source of truth, and never reconcile against it.

If `$SDK_TARGET` does not exist, this is a Scenario B (fresh) language whose repo
has not been created yet. Read `docs/sdk-architecture/{lang}.md` for the intended
repo shape and report what is missing instead of generating into a path that will
silently spring into existence.

## The operation table: derive it, never read a copy

There is no checked-in operation list, and you should not look for one. Resolve
the live table from the spec plus the consumer config:

```bash
cd "$SPEC_REPO"
npx oagen resolve --spec spec/open-api-spec.yaml --format json > /tmp/ops.json
```

Each entry has `service`, `method`, `path`, `derivedName`, `hintApplied`, and
`mountOn` — everything needed to check mount correctness and method naming.
`derivedName` is already post-hint, so it _is_ the expected method name (modulo
the language's casing convention); `hintApplied: false` marks an operation
running on the raw derivation with no override.

**Never assert a hardcoded operation count**, and never hardcode how many paths
match a given service. Both change as the spec moves. Count `/tmp/ops.json`.

The human-readable review table is produced on demand by the
`/oagen:review-operations` skill from this same resolve output. That skill ships
with the `oagen` package, so it is only invocable in a session where the oagen
plugin is installed — if it is not available, work from the JSON directly rather
than hunting for the table. Do not treat any saved rendering of it as current.

## Emitter health checks

```bash
cd "$EMITTERS"
npm run test        # vitest -- all pass
npm run typecheck   # tsc --noEmit -- zero errors
npm run lint        # oxlint -D warnings -- zero warnings
npm run format      # oxfmt --check
```

## Generation

Generation runs from the **spec repo**, which owns the consumer
`oagen.config.ts` (`operationHints` incl. `mountOn`, plus `mountRules`). The
emitters are consumed through `dist/`, so build first.

```bash
# 1. Build the emitters so local changes are visible
cd "$EMITTERS" && npm run build

# 2. Verify the dev link survives — a plain `npm install` in the spec repo
#    silently replaces it with the published tarball, which produces
#    "Unknown language: {lang}" for any emitter newer than the last release.
readlink "$SPEC_REPO/node_modules/@workos/oagen-emitters" || {
  cd "$EMITTERS" && npm link
  cd "$SPEC_REPO" && npm link @workos/oagen-emitters
}

# 3. Generate
cd "$SPEC_REPO"
npm run sdk:generate -- --lang {lang} --output "$SDK_TARGET"
```

Must exit 0.

Notes:

- `scripts/sdk-generate.sh` accepts only `--lang`, `--output`, `--namespace`,
  `--services`. It hard-errors on anything else, including `--target`.
- It defaults `--namespace` to `WorkOS` for `php`, `ios`, and `android`, and
  `workos` elsewhere. Do not override unless the language design doc says to.
  `android` genuinely needs the cased form: the namespace becomes the client type
  prefix, so `workos` yields `WorkosClient` accessors that do not match the
  hand-maintained `WorkOSClient` and the SDK will not compile. One quirk remains in
  that branch, in the spec repo and out of scope here: `kotlin` is _not_ in the
  cased list even though the script's own comment says a Kotlin client class needs
  the cased form — so a kotlin run gets `workos`. If kotlin output looks wrong,
  check that first.
- The old `npm run sdk:generate:{lang}` scripts and the `--output` staging +
  `--target` live split are **gone**. If you need staging separate from the live
  repo, skip the wrapper and call the CLI directly:
  ```bash
  cd "$SPEC_REPO"
  npx oagen generate --lang {lang} --spec spec/open-api-spec.yaml \
    --namespace workos --output ../sdk-{lang} --target "$SDK_TARGET"
  ```
- Scoped generation: `--services Organizations,UserManagement`.

## Verifying the target SDK

```bash
cd "$SDK_TARGET"
script/ci
```

`script/ci` is the canonical entrypoint and codifies the full check set for that
SDK. **Read the file before quoting its commands** — they differ per language.
Some repos have no `script/ci` (currently `workos-node`, `workos-python`,
`workos-php-laravel`); there, run that language's lint, typecheck, and test
commands directly and say which you used.

## Persistence and idempotency — do this, not a reset

The criterion that matters is _regeneration does not overwrite hand-maintained
files_. Prove it **without** a reset:

```bash
cd "$SDK_TARGET" && git status --porcelain > /tmp/before.txt
# ...regenerate...
git status --porcelain > /tmp/after.txt   # hand-maintained files unchanged
git diff --stat                            # second consecutive run: zero changes
```

**Do not run `git checkout . && git clean -fd` in a target SDK** unless every
hand-maintained edit is committed first.

- `git clean -fd` deletes untracked `@oagen-ignore-file` files.
- `git checkout .` reverts uncommitted edits to tracked `@oagen-ignore-file`
  files (client, errors, runtime tests) — those losses are the expensive ones.

If a full-reset proof is genuinely required: commit the hand-maintained content
first, or snapshot it (`cp -R` into a scratch dir) so it can be restored. Reset
the target at most once, to establish a baseline, and never between iterations.

## The one rule that overrides convenience

Never hand-edit generated files in `$SDK_TARGET`. Fix `src/{lang}/` (or
`src/shared/` when the rule is cross-language) and regenerate. The exception is
files intentionally owned by the SDK repo via `@oagen-ignore-file` — edit those
in place.
