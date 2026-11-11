import { describe, expect, it } from 'vitest';
import { deprecationMessage } from '../../src/shared/deprecation.js';

describe('shared/deprecation', () => {
  it('lifts the clause after "Deprecated:" / "Deprecated."', () => {
    expect(
      deprecationMessage('List groups.\n  Deprecated: use `GET /directories/{id}/groups`\n  instead.', 'operation'),
    ).toBe('Deprecated. use `GET /directories/{id}/groups` instead.');
    expect(deprecationMessage('Deprecated. Use `domain_data` instead.', 'field')).toBe(
      'Deprecated. Use `domain_data` instead.',
    );
  });

  it('keeps periods inside replacement targets', () => {
    expect(deprecationMessage('Deprecated. Use `https://api.workos.com/v2` instead.', 'operation')).toBe(
      'Deprecated. Use `https://api.workos.com/v2` instead.',
    );
    expect(deprecationMessage('Deprecated. Use v1.2 instead. Removed in v2.', 'field')).toBe(
      'Deprecated. Use v1.2 instead.',
    );
    expect(deprecationMessage('Old. Use `v1.2` instead.', 'field')).toBe(
      'This field is deprecated. Use `v1.2` instead.',
    );
  });

  it('keeps the generic sentence intact before a "Use X instead" hint', () => {
    expect(deprecationMessage('Last update time. Use `updated_at` instead.', 'field')).toBe(
      'This field is deprecated. Use `updated_at` instead.',
    );
  });

  it('falls back to the generic message per kind', () => {
    expect(deprecationMessage(undefined, 'parameter')).toBe('This parameter is deprecated.');
    expect(deprecationMessage('Just a description.', 'value')).toBe('This value is deprecated.');
  });
});
