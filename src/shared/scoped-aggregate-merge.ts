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
 * Prior blocks the new spec no longer produces are carried over verbatim.
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
 * Reconcile freshly generated per-model blocks against the prior on-disk blocks.
 * Returns the ordered block texts to emit (new-spec order, then carry-overs).
 *
 * @param newBlocks   Blocks the current spec produced (emit order), each tagged
 *                    with `inScope`. In a scoped run this should already be gated
 *                    to in-scope ∪ on-disk models.
 * @param priorBlocks Blocks parsed from the prior on-disk file (parser-specific).
 * @param scoped      Whether a scoped (`--services`) run is active.
 */
export function reconcileScopedBlocks(
  newBlocks: AggregateBlock[],
  priorBlocks: AggregateBlock[],
  scoped: boolean,
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
  for (const block of priorBlocks) {
    if (!emitted.has(block.key)) {
      out.push(block.text);
      emitted.add(block.key);
    }
  }

  return out;
}
