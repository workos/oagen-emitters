import { describe, it, expect } from 'vitest';
import { docCommentLines } from '../../src/rust/doc-comments.js';

describe('rust/doc-comments', () => {
  it('keeps a paragraph break after a Markdown list as a bare ///', () => {
    const text = [
      'Why the connection is in its current state:',
      '- `membership_ended`: The member left.',
      '',
      'Additional values may be added; treat an unrecognized value as unknown.',
    ].join('\n');
    expect(docCommentLines(text)).toEqual([
      '/// Why the connection is in its current state:',
      '/// - `membership_ended`: The member left.',
      '///',
      '/// Additional values may be added; treat an unrecognized value as unknown.',
    ]);
  });

  it('collapses runs of blank lines and drops leading/trailing ones', () => {
    expect(docCommentLines('\n\nFirst.\n\n\n\nSecond.\n\n')).toEqual(['/// First.', '///', '/// Second.']);
  });

  it('treats whitespace-only lines as blank', () => {
    expect(docCommentLines('A.\n   \nB.')).toEqual(['/// A.', '///', '/// B.']);
  });

  it('returns nothing for empty or whitespace-only text', () => {
    expect(docCommentLines('')).toEqual([]);
    expect(docCommentLines(' \n \n')).toEqual([]);
  });
});
