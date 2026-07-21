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
});
