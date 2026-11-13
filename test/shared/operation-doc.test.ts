import { describe, expect, it } from 'vitest';
import { operationDoc } from '../../src/shared/operation-doc.js';

describe('shared/operation-doc', () => {
  it('leads with the summary, then a blank line, then the description', () => {
    expect(operationDoc({ summary: 'List widgets', description: 'Returns every widget.\nNewest first.' })).toBe(
      'List widgets\n\nReturns every widget.\nNewest first.',
    );
  });

  it('returns whichever of the two is present', () => {
    expect(operationDoc({ summary: 'List widgets' })).toBe('List widgets');
    expect(operationDoc({ description: 'Returns every widget.' })).toBe('Returns every widget.');
  });

  it('writes text the summary and description share once', () => {
    expect(operationDoc({ summary: 'List widgets', description: 'List widgets' })).toBe('List widgets');
  });

  it('treats empty and whitespace-only text as absent', () => {
    expect(operationDoc({ summary: '  ', description: 'Returns every widget.' })).toBe('Returns every widget.');
    expect(operationDoc({ summary: 'List widgets', description: '\n' })).toBe('List widgets');
    expect(operationDoc({ summary: '', description: '' })).toBeUndefined();
    expect(operationDoc({})).toBeUndefined();
  });
});
