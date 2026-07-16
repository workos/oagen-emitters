import { describe, it, expect } from 'vitest';
import { swiftRawString } from '../../src/ios/fixtures.js';

describe('ios/fixtures swiftRawString', () => {
  it('wraps plain JSON with a single-hash fence', () => {
    expect(swiftRawString('{"a":1}')).toBe('#"{"a":1}"#');
  });

  it('grows the fence when content could close the literal (`"#`)', () => {
    const json = JSON.stringify({ a: '"#' });
    expect(swiftRawString(json)).toBe(`##"${json}"##`);
  });

  it('does not grow the fence for the opening sequence (`#"`)', () => {
    const json = JSON.stringify({ a: 'x#' });
    expect(json).toContain('#"');
    expect(swiftRawString(json)).toBe(`#"${json}"#`);
  });

  it('grows the fence when content could begin an escape sequence (`\\#`)', () => {
    const json = JSON.stringify({ a: '\\#b' });
    expect(swiftRawString(json)).toBe(`##"${json}"##`);
  });
});
