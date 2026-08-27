import type { EmitterContext } from '@workos/oagen';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Scoped-run reconciliation for whole-suite AGGREGATE test files (e.g. Kotlin's
 * `GeneratedModelRoundTripTest.kt`) that pack one per-model block into a single
 * file covering EVERY model.
 *
 * Such a file can't obey per-model scoping the way a per-model source file does:
 * it is one file, so emitting it in a scoped run either flushes on-disk drift
 * for out-of-scope models (noisy scoped PRs) or, if skipped wholesale, leaves an
 * IN-SCOPE model whose shape changed with a stale block — the latter is the bug
 * this fixes: a model regenerated this run (e.g. a data class the current spec
 * deduplicates into a `typealias` onto a wider model with an extra required
 * field) keeps a stale fixture that no longer deserializes.
 *
 * The fix mirrors {@link ../go/flat-merge.ts reconcileFlatBlocks}: reconcile the
 * freshly generated per-model blocks against the prior on-disk file so a scoped
 * run touches ONLY in-scope blocks:
 *   - IN-SCOPE                     → the freshly generated block (apply new spec).
 *   - out-of-scope, existed before → the PRIOR on-disk block, FROZEN byte-for-byte
 *                                    (an unrelated same-delta change to it never
 *                                    leaks into a scoped batch).
 *   - out-of-scope, brand-new      → dropped (its per-model file isn't emitted
 *                                    this run, so a block referencing it would
 *                                    dangle).
 * Prior blocks the new spec no longer produces are carried over verbatim —
 * EXCEPT for keys the caller reports as in scope (see `inScopeKeys`), which are
 * dropped instead: an in-scope model that produced no block was disqualified on
 * purpose, and its per-model file WAS regenerated, so the prior block asserts a
 * shape the fresh model no longer has.
 *
 * A full (non-scoped) run skips reconciliation and emits every fresh block.
 */

/** A single per-model block in a flat aggregate test file, keyed by a unique name. */
export interface AggregateBlock {
  /** Unique key for the block (e.g. the model's generated class name). */
  key: string;
  /** Verbatim block text (no surrounding blank lines). */
  text: string;
  /**
   * Whether the block's owning model is in scope this run. Set on freshly
   * generated blocks; omitted (treated as false) for blocks parsed from disk.
   */
  inScope?: boolean;
}

/**
 * Read the prior on-disk content of a generated file, or `null` when the file is
 * genuinely ABSENT (no output dir / not on disk) — the safe "no prior blocks"
 * signal.
 *
 * A read error on a file that DOES exist is NOT swallowed: it throws. Treating
 * an unreadable-but-present aggregate as empty would make the reconciler drop
 * every out-of-scope (frozen) block and overwrite the file with only fresh
 * in-scope blocks — silent data loss. Callers must let the throw prevent the
 * aggregate from being emitted (leaving the on-disk copy untouched) rather than
 * reconcile against an empty prior.
 */
export function readPriorFile(relPath: string, ctx: EmitterContext): string | null {
  if (!ctx.outputDir) return null;
  const abs = resolve(ctx.outputDir, relPath);
  if (!existsSync(abs)) return null;
  return readFileSync(abs, 'utf-8');
}

/**
 * Build the `inScopeKeys` set for {@link reconcileScopedBlocks} from every
 * (key, inScope) pair the caller considered.
 *
 * Block keys are NORMALIZED names (a generated class or file name), and two
 * distinct IR model names can collapse onto one — Kotlin and Ruby both carry an
 * explicit dedup for exactly that. A key is in scope when ANY model mapping to
 * it is in scope.
 *
 * "Any", not "every", because the key IS the generated artifact's identity: it
 * is the same normalized name that forms the file path each emitter writes
 * (`…/models/<className>.kt`, `lib/workos/<dir>/<fileName>.rb`,
 * `…/models/<fileName>.py` plus its flat fixture). Colliding owners therefore
 * do not have separate artifacts — they share ONE file, and a single in-scope
 * owner regenerates it. There is no out-of-scope coverage to preserve in that
 * case, only a prior block describing a shape the shared artifact no longer
 * has, so the key must be treated as in scope and the stale block dropped.
 */
export function keysWithInScopeOwner(owners: Iterable<{ key: string; inScope: boolean }>): Set<string> {
  const keys = new Set<string>();
  for (const { key, inScope } of owners) {
    if (inScope) keys.add(key);
  }
  return keys;
}

/**
 * Reconcile freshly generated per-model blocks against the prior on-disk blocks.
 * Returns the ordered block texts to emit (new-spec order, then carry-overs).
 *
 * @param newBlocks   Blocks the current spec produced (emit order), each tagged
 *                    with `inScope`. In a scoped run this should already be gated
 *                    to in-scope ∪ on-disk models.
 * @param priorBlocks Blocks parsed from the prior on-disk file (parser-specific).
 * @param scoped      Whether a scoped (`--services`) run is active.
 * @param inScopeKeys Keys the caller CONSIDERED that have at least one in-scope
 *                    owner, whether or not they produced a block — build it with
 *                    {@link keysWithInScopeOwner}. A key in this set that
 *                    produced no block was disqualified on purpose
 *                    (e.g. the model gained an optional field and no longer
 *                    satisfies the round-trip fixture gate), so its prior block
 *                    is dropped rather than carried over — the freshly
 *                    regenerated model would fail the stale assertion. Omit to
 *                    keep the pre-existing carry-over-everything behavior.
 */
export function reconcileScopedBlocks(
  newBlocks: AggregateBlock[],
  priorBlocks: AggregateBlock[],
  scoped: boolean,
  inScopeKeys?: ReadonlySet<string>,
): string[] {
  // Full run: emit everything the new spec produced, unchanged.
  if (!scoped) return newBlocks.map((b) => b.text);

  const priorByKey = new Map(priorBlocks.map((b) => [b.key, b]));
  const out: string[] = [];
  const emitted = new Set<string>();

  for (const block of newBlocks) {
    if (block.inScope) {
      out.push(block.text);
      emitted.add(block.key);
      continue;
    }
    // Out of scope: freeze to the prior on-disk block so an unrelated change to
    // it in the same spec delta doesn't leak into a scoped batch. A brand-new
    // out-of-scope block (no prior) is dropped — its per-model file isn't emitted.
    const prior = priorByKey.get(block.key);
    if (prior && !emitted.has(prior.key)) {
      out.push(prior.text);
      emitted.add(prior.key);
    }
  }

  // Carry over prior blocks the new spec no longer produces at all (renamed /
  // removed models whose per-model file this run left untouched on disk).
  //
  // An in-scope key is NOT carried over: its per-model file WAS regenerated, so
  // "no fresh block" means the generator disqualified it deliberately and the
  // prior block now asserts a shape the new model can't produce. Carrying it
  // over resurrected the stale block at the end of the file and broke the build
  // (e.g. a model that gained an optional field: the frozen fixture omits it,
  // the regenerated model serializes it as null, and the round-trip assertion
  // fails).
  for (const block of priorBlocks) {
    if (emitted.has(block.key)) continue;
    if (inScopeKeys?.has(block.key)) continue;
    out.push(block.text);
    emitted.add(block.key);
  }

  return out;
}
