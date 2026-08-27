import { describe, it, expect } from 'vitest';
import { reconcileScopedBlocks, type AggregateBlock } from '../../src/shared/scoped-aggregate-merge.js';

const fresh = (key: string, inScope: boolean): AggregateBlock => ({ key, text: `${key}:fresh`, inScope });
const prior = (key: string): AggregateBlock => ({ key, text: `${key}:prior` });

describe('reconcileScopedBlocks', () => {
  it('full run emits every fresh block unchanged', () => {
    const out = reconcileScopedBlocks([fresh('A', false), fresh('B', false)], [prior('A')], false);
    expect(out).toEqual(['A:fresh', 'B:fresh']);
  });

  it('scoped: refreshes in-scope blocks with fresh text', () => {
    const out = reconcileScopedBlocks([fresh('A', true)], [prior('A')], true);
    // A changed shape this run → its fixture must be the freshly generated one.
    expect(out).toEqual(['A:fresh']);
  });

  it('scoped: freezes an out-of-scope block to its prior on-disk text', () => {
    // B is out of scope; even though the new spec produced a fresh block for it,
    // an unrelated same-delta change must NOT leak into a scoped batch.
    const out = reconcileScopedBlocks([fresh('A', true), fresh('B', false)], [prior('A'), prior('B')], true);
    expect(out).toEqual(['A:fresh', 'B:prior']);
  });

  it('scoped: drops a brand-new out-of-scope block (no prior → its file is not emitted)', () => {
    const out = reconcileScopedBlocks([fresh('A', true), fresh('B', false)], [prior('A')], true);
    expect(out).toEqual(['A:fresh']);
  });

  it('scoped: carries over prior blocks the new spec no longer produces', () => {
    // C was renamed/removed from the spec but its file lingers on disk and may
    // still be referenced by un-regenerated out-of-scope code.
    const out = reconcileScopedBlocks([fresh('A', true)], [prior('A'), prior('C')], true);
    expect(out).toEqual(['A:fresh', 'C:prior']);
  });

  it('scoped: preserves new-spec order, then appends carry-overs', () => {
    const out = reconcileScopedBlocks(
      [fresh('A', true), fresh('B', false)],
      [prior('B'), prior('A'), prior('Z')],
      true,
    );
    expect(out).toEqual(['A:fresh', 'B:prior', 'Z:prior']);
  });

  it('scoped: drops the prior block of an IN-SCOPE model that no longer qualifies', () => {
    // D is in scope and its per-model file WAS regenerated, but the generator
    // disqualified it this run (e.g. it gained an optional field, so its
    // all-fields-required round-trip fixture no longer holds). Carrying the
    // prior block over resurrects a fixture the fresh model can't satisfy and
    // breaks the SDK build — drop it instead.
    const out = reconcileScopedBlocks([fresh('A', true)], [prior('A'), prior('D')], true, new Set(['A', 'D']));
    expect(out).toEqual(['A:fresh']);
  });

  it('scoped: still carries over a prior block whose model is out of scope', () => {
    // Same shape as above, but D is NOT in scope: its file was left untouched on
    // disk, so its coverage must survive the scoped run.
    const out = reconcileScopedBlocks([fresh('A', true)], [prior('A'), prior('D')], true, new Set(['A']));
    expect(out).toEqual(['A:fresh', 'D:prior']);
  });

  it('scoped: an in-scope key that DID produce a block is unaffected by the drop rule', () => {
    const out = reconcileScopedBlocks([fresh('A', true)], [prior('A')], true, new Set(['A']));
    expect(out).toEqual(['A:fresh']);
  });

  it('full run ignores inScopeKeys (no prior is consulted at all)', () => {
    const out = reconcileScopedBlocks([fresh('A', false)], [prior('A'), prior('D')], false, new Set(['A', 'D']));
    expect(out).toEqual(['A:fresh']);
  });
});
