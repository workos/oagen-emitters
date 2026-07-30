---
name: prompt-5-sanity
description: 'Prompt 5 of the lang-gen sequence: run a blanket sanity pass proving a WorkOS SDK''s spec coverage, hand-maintained modules, docstrings, and deprecation markers are all simultaneously correct, and that emitter policy stays DRY across languages. Use when the user says "run prompt-5 for <lang>", "prompt 5 for kotlin", "blanket sanity pass", or asks to audit docstrings, Dto/Urn name leakage, or cross-language emitter drift. <lang> is an oagen emitter id (dotnet, elixir, go, ios, kotlin, node, php, python, ruby, rust).'
---

# Prompt 5: blanket sanity pass on the {lang} SDK and the emitter

Substitute `{lang}` with the emitter identifier the user named. If they did not
name one, ask which language first.

**Step 0.** Read `docs/lang-gen/workspace.md` in this repo for path resolution,
the generate command, and the persistence policy. Then read
`docs/lang-gen/sdk-runtime-contract.md` and treat it as part of the
acceptance criteria. Also read `docs/sdk-architecture/{lang}.md` if present.

## Goal

Prove all of the following **at the same time**:

1. Every spec endpoint from prompt-2 is still present, correctly documented, and
   covered by tests.
2. Every hand-maintained module from prompt-3 still exists, is publicly
   reachable, and survives regeneration.
3. Generated and hand-maintained documentation strings are correct:
   - no leaked spec-noise names like `Dto`, `DTO`, or `Urn` in public symbols or
     docstrings
   - docs are attached to the correct methods, models, fields, and enum values
   - deprecated operations, params, fields, and enum values emit the correct
     language-appropriate deprecation marker
   - copied comments do not describe the wrong endpoint or a neighboring method
4. Emitter logic stays DRY across languages: cross-language policy lives in
   shared code or shared config; language emitters differ only where syntax or
   runtime requirements actually differ.

## Key definitions

### "Documented and tested"

The prompt-2 guarantees still hold:

1. Every entry in the resolved operation table maps to a public SDK method on the
   resource named by its `mountOn`.
2. The generated surface carries spec descriptions wherever the language supports
   doc comments.
3. Every endpoint has at least one generated test exercising the wrapper and
   validating deserialization and request wiring.

### "Hand-maintained is maintained"

The prompt-3 and prompt-4 guarantees still hold:

1. Non-spec modules and helper entry points are still on the public surface.
2. Files meant to be hand-maintained still are — committed in the target SDK,
   protected by `@oagen-ignore-file` or `skipIfExists: true`, and not overwritten
   by regeneration.
3. Their tests still run and still pass.

### "Documentation strings are correct"

A doc block is correct only if all of these hold:

1. It describes the symbol directly below it, not one copied from elsewhere.
2. Parameter docs match the real parameter names and meanings.
3. Deprecation annotations are present whenever the IR marks the symbol
   deprecated.
4. Public names and docs do not leak spec-noise tokens like `Dto`, `DTO`, or
   `Urn` — unless the literal wire contract requires the exact token in a field,
   example, or quoted text.

Doc **fallback** text must interpolate the emitted symbol name, not the raw IR
name — a fallback that says the IR name is a defect even when a doc exists.

### "DRY across languages"

Cross-language policy should have one source of truth:

1. Mounting and resolved-operation lookup come from shared logic such as
   `src/shared/resolved-ops.ts`, not per-language copies.
2. Non-spec client wiring comes from shared data such as
   `src/shared/non-spec-services.ts`, not repeated per-emitter service lists.
3. Naming cleanup rules that apply to all languages come from shared config or
   shared helpers, not duplicated regex tables per emitter.
4. Rendered syntax may differ per language. The **policy** may not drift without
   a runtime-specific reason.

## Steps

### Step 1: Read the earlier inputs and shared sources of truth

Read all of:

- the `prompt-2-spec-endpoint-coverage`, `prompt-3-non-spec-endpoint-coverage`,
  and `prompt-4-cleanup` skills in `.claude/skills/`
- `docs/lang-gen/non-spec-endpoints.md` — the H01–H19 inventory prompt-3 checks
  against, so you can re-prove its guarantees without re-deriving the list
- the live operation table, resolved fresh:
  `cd "$SPEC_REPO" && npx oagen resolve --spec spec/open-api-spec.yaml --format json > /tmp/ops.json`
- `$SPEC_REPO/oagen.config.ts`
- `src/shared/resolved-ops.ts`
- `src/shared/non-spec-services.ts`

Build a concrete checklist of every spec operation that must exist, every
hand-maintained module that must survive, and every shared source of truth that
should be preventing drift.

### Step 2: Verify emitter health and generate

```bash
cd "$EMITTERS"
npm run test
npm run typecheck
npm run lint
```

Then generate per the Generation section of `docs/lang-gen/workspace.md`. All
commands exit 0.

### Step 3: Re-run the prompt-2 checks

1. Every operation in the resolved table exists on the correct mounted resource.
2. Override names, union splits, and merged mount targets are still correct.
3. The client exposes the correct resource accessors.
4. Every endpoint method still has generated test coverage.
5. Endpoint and method docs still exist where the language supports them.

Do not assume prompt-2 still holds because it passed earlier. Re-check it.

### Step 4: Re-run the prompt-3 and prompt-4 checks

1. Passwordless, Vault, and all expected non-spec helpers still exist and are
   publicly reachable.
2. Hand-maintained runtime files and static test files are still protected from
   regeneration.
3. The base-runtime split from prompt-4 still holds: spec-dependent accessors
   remain generated, static runtime logic remains in `@oagen-ignore-file` files,
   and compat/non-spec accessors are still where the typechecker requires them.
4. Tests for those hand-maintained modules still exist and still pass.

### Step 5: Audit docstrings and public naming

Search both the emitter output and the generated SDK for doc/name regressions.
At minimum:

1. Search for `Dto`, `DTO`, and `Urn` in generated public files and inspect every
   hit.
2. Search for deprecation markers and verify one exists for every deprecated
   operation, param, field, and enum value.
3. Spot-check methods with similar names to catch stale copy-paste docs.
4. Confirm method comments describe the correct HTTP operation and parameters.
5. Confirm model, enum, and property docs align with the symbol directly below.
6. Confirm doc fallbacks interpolate the **emitted** symbol name, not the raw IR
   name.

When auditing field-level docs, replicate the emitter's dedup rules — deprecated
camelCase alias fields are shadowed by their snake_case twins, so a naive audit
reports phantom gaps.

If a hit is intentional because it reflects the literal wire contract, document
why. Otherwise treat it as a bug.

### Step 6: Audit the emitter for cross-language duplication

Inspect `src/{lang}/` alongside the other active emitter directories. Look for
logic that should be shared but is repeated with drift risk:

1. mount target resolution
2. non-spec service lists and accessor policy
3. naming cleanup rules such as stripping spec-noise suffixes
4. endpoint grouping or test coverage policy
5. doc and deprecation policy that should be uniform

If the same rule exists in more than one emitter and can be centralized in
`$SPEC_REPO/oagen.config.ts` or `src/shared/`, extract it
unless a language-specific constraint makes that impossible. Record any remaining
duplication that is deliberately language-specific.

Flag — do not silently "fix" — duplication whose consolidation would be a
breaking change to a published SDK's public names. Report it as a decision for
the user.

### Step 7: Target SDK validation and persistence

Run the full target SDK check set — `script/ci` when the repo has one, otherwise
the language's lint, typecheck, and test commands.

Then the persistence check from `docs/lang-gen/workspace.md`: regenerate with
hand-maintained edits in place and confirm they are untouched, then generate once
more and confirm the second run produces zero file changes. Do **not**
`git checkout . && git clean -fd` unless the hand-maintained content is committed
or snapshotted first.

## Acceptance criteria

All true simultaneously:

1. Emitter tests, typecheck, and lint pass.
2. Generation exits 0.
3. Every prompt-2 spec endpoint still exists on the correct resource with test
   coverage.
4. Every prompt-3 non-spec endpoint/helper still exists, is publicly reachable,
   and is still tested.
5. Hand-maintained files from prompt-3/4 survive regeneration.
6. Public names and docstrings do not leak `Dto`, `DTO`, or `Urn` unless the wire
   contract requires it and the exception is documented.
7. Comments and docstrings match the correct methods, params, fields, and enum
   values.
8. Every deprecated symbol emits the correct language-appropriate marker.
9. Cross-language emitter policy is DRY, with no accidental drift.
10. Target SDK lint, typecheck, and tests pass after regeneration.
11. A second consecutive generation produces no file changes.

On failure:

- Fix generated-surface defects in `src/{lang}/` or
  `src/shared/`.
- Fix hand-maintained runtime/test files in `workos-{lang}` only where they are
  intentionally owned there via `@oagen-ignore-file`.
- Re-run from Step 2.

## Report

Give a pass/fail line per acceptance criterion, with the failing output quoted.
Separate real defects from documented intentional exceptions, and list any
cross-language duplication you left in place along with the reason.
