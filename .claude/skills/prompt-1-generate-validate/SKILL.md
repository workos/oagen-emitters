---
name: prompt-1-generate-validate
description: 'Prompt 1 of the lang-gen sequence: generate a WorkOS SDK for one language and validate it lints, typechecks, and tests clean, and satisfies the shared runtime contract. Use when the user says "run prompt-1 for <lang>", "prompt 1 for kotlin", "generate and validate the <lang> SDK", or asks whether an emitter produces a buildable SDK. <lang> is an oagen emitter id (dotnet, elixir, go, ios, kotlin, node, php, python, ruby, rust).'
---

# Prompt 1: generate the {lang} SDK and validate it

Substitute `{lang}` with the emitter identifier the user named. If they did not
name one, ask which language before doing anything else.

**Step 0.** Read `docs/lang-gen/workspace.md` in this repo for path resolution,
the generate command, and the persistence policy. Then read
`docs/lang-gen/sdk-runtime-contract.md` and treat it as part of the
acceptance criteria. Also read `docs/sdk-architecture/{lang}.md` if it exists —
it defines which files are generated vs. hand-maintained for this language.

## Step 1: Verify emitter health

```bash
cd "$EMITTERS"
npm run test
npm run typecheck
npm run lint
```

All three must pass before you generate anything. If any fail, fix
`src/{lang}/` (or `src/shared/`) first.

## Step 2: Generate the SDK

Build the emitters, check the dev link, then generate — see the Generation
section of `docs/lang-gen/workspace.md`.

Must exit 0. If three attempts do not produce a clean exit, stop and report the
failure rather than working around it.

## Step 3: Lint the generated SDK

In `$SDK_TARGET`, run that language's lint. Zero errors.

Lint failures mean the emitter produces malformed code. Fix the emitter,
regenerate, re-check.

## Step 4: Typecheck the generated SDK

In `$SDK_TARGET`, run the typecheck (or compile) step, where the
language has one. Zero errors.

Type errors mean the emitter produces invalid annotations. Fix the emitter,
regenerate, re-check.

## Step 5: Run the generated SDK tests

Run the full suite. All tests pass.

Steps 3–5 are usually all covered by `script/ci` — prefer it when the repo has
one, and report which commands actually ran.

## Step 6: Verify the runtime contract

Inspect the generated SDK against
`docs/lang-gen/sdk-runtime-contract.md`. At minimum confirm:

- client configuration is instance-scoped, not global mutable state
- per-request options are actually honored by the runtime
- typed SDK-native errors are thrown instead of raw transport-library exceptions
- pagination wrappers are fully wired, including auto-pagination across pages
- generated tests assert behavior, not just that a symbol exists

§6 (generated test minimums) is the section emitters fail most often. It forbids
existence-only assertions and requires each per-service test to assert response
type, a real field value, request method, and request path — plus suite-level
error-status, empty-page, round-trip, and query-encoding coverage. Mirror
`src/python/tests.ts`, the reference implementation, rather than inventing a new
shape.

Any gap here is a generator defect. Fix the emitter or the hand-maintained
runtime, regenerate, re-check.

## Acceptance criteria

All true simultaneously:

1. Emitter tests pass.
2. Emitter typecheck passes.
3. Emitter lint passes.
4. Generation exits 0.
5. Generated SDK lint: zero errors.
6. Generated SDK typecheck: zero errors (where the language has one).
7. Generated SDK tests: zero failures.
8. The SDK satisfies `sdk-runtime-contract.md`.

On failure, fix the root cause in `src/{lang}/` and re-run from Step 2.
Never hand-edit `workos-{lang}` except in files marked `@oagen-ignore-file`.

## Report

State which criteria pass and which fail, with the actual command output for any
failure. If you stopped early, say at which step and why.
