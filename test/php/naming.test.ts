import { describe, it, expect } from 'vitest';
import { className, fixtureName, snakeName } from '../../src/php/naming.js';

describe('fixtureName', () => {
  it('is the plain snake_case stem for an ordinary model', () => {
    expect(fixtureName('Organization')).toBe('organization');
    expect(fixtureName('OrganizationMembership')).toBe(snakeName('OrganizationMembership'));
    expect(fixtureName('ListWaitlistsResponse')).toBe('list_waitlists_response');
  });

  it('follows the reserved-name stepping of className', () => {
    // IR `List` is class `ListModel`; its fixture must not land on the
    // hand-maintained `list.json` in the SDK repo.
    expect(className('List')).toBe('ListModel');
    expect(fixtureName('List')).toBe('list_model');
    expect(className('Object')).toBe('ObjectModel');
    expect(fixtureName('Object')).toBe('object_model');
  });
});
