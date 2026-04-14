import { describe, it, expect } from 'vitest';
import { dotnetEmitter } from '../../src/dotnet/index.js';

describe('dotnet/errors', () => {
  it('returns empty array (errors are hand-maintained in the target SDK)', () => {
    const files = dotnetEmitter.generateErrors!({} as any);
    expect(files).toHaveLength(0);
  });
});
