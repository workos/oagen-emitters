# oagen-emitters

Guidance for AI agents working in this repo. The README covers setup and the
emitter development loop; this file holds the rules that are easy to miss.

## Every emitter behaves the same

`src/<lang>/` holds one emitter per language, and they are parallel
implementations of one contract: the same spec must produce SDKs that behave
the same way, and the generated test suites must hold the same guarantees.
A bug found in one emitter is almost always present in its siblings, because
they were written from the same template.

When you change behavior in one emitter:

1. Grep every other emitter for the same pattern before you start
   (`grep -rn '<pattern>' src/*/`). Fixture builders, naming, scoping,
   barrel generation, compat aliases and test generation all have a
   counterpart in each `src/<lang>/` directory.
2. Apply the fix everywhere it applies. Put the shared logic in `src/shared/`
   and call it from each emitter instead of patching copies in place.
3. For every emitter you leave alone, be able to say why in the PR
   (for example: Rust already drops model-shaped examples; Elixir does not
   read examples at all). "Didn't look" is not a reason.
4. Add the regression test to each emitter you touched, not just the one
   that failed in CI.

## Verifying a change

- `npm run typecheck`, `npm run lint`, `npm test` must pass; hooks enforce
  lint and format on commit and the full suite on push. Never bypass them.
- Unit tests prove the emitter logic. Prove the generated SDK too: build this
  package, point the consumer project (`openapi-spec`) at the local `dist`,
  regenerate the SDK into a fresh worktree of its repo, and run that SDK's own
  `script/ci` (or equivalent). CI failures that reach the SDK's own test suite
  are only visible that way.
- A behavior that a generated SDK's CI exercises (round-trip fixtures,
  serializers, barrels) needs that end-to-end run for every language the
  change touches, not only the one that broke.
