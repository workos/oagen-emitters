import { describe, it, expect } from 'vitest';
import { elixirEmitter } from '../../src/elixir/index.js';
import { makeSpec, makeCtx } from './helpers.js';

describe('elixir/emitter', () => {
  it('generateClient returns empty array (client, Cast, and Page are hand-maintained in the target SDK)', () => {
    const spec = makeSpec();
    expect(elixirEmitter.generateClient!(spec, makeCtx(spec))).toEqual([]);
  });

  it('generateErrors returns empty array (errors.ex is hand-maintained in the target SDK)', () => {
    expect(elixirEmitter.generateErrors!(makeCtx(makeSpec()))).toEqual([]);
  });
});
