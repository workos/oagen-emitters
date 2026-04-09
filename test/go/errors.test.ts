import { describe, it, expect } from 'vitest';
import { goEmitter } from '../../src/go/index.js';

describe('go/errors', () => {
  it('returns empty array (errors are hand-maintained in the target SDK)', () => {
    const files = goEmitter.generateErrors({} as any);
    expect(files).toHaveLength(0);
  });
});
