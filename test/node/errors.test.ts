import { describe, it, expect } from 'vitest';
import { generateErrors } from '../../src/node/errors.js';

describe('generateErrors', () => {
  it('returns empty array without context', () => {
    expect(generateErrors()).toEqual([]);
  });
});
