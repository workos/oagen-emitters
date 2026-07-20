import { describe, it, expect } from 'vitest';
import { iosEmitter } from '../../src/ios/index.js';

describe('ios/errors', () => {
  it('emits nothing — the error hierarchy is hand-maintained in the SDK repo', () => {
    // Same pattern as the Go emitter: the implementation ignores the context.
    const files = iosEmitter.generateErrors({} as never);
    expect(files).toEqual([]);
  });
});
