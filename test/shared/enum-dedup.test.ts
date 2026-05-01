import { describe, expect, it } from 'vitest';
import type { Enum } from '@workos/oagen';
import { baselineEnumNamesFrom, buildEnumAliasMap } from '../../src/shared/enum-dedup.js';

function makeEnum(name: string, values: string[]): Enum {
  return {
    name,
    values: values.map((v) => ({ name: v.toUpperCase(), value: v, description: undefined })),
  };
}

describe('shared/enum-dedup', () => {
  describe('buildEnumAliasMap', () => {
    it('returns empty map when every enum has a unique value set', () => {
      const enums: Enum[] = [makeEnum('Foo', ['a', 'b']), makeEnum('Bar', ['x', 'y'])];
      const aliases = buildEnumAliasMap(enums);
      expect(aliases.size).toBe(0);
    });

    it('groups value-equivalent enums and picks alphabetically-first canonical by default', () => {
      const enums: Enum[] = [
        makeEnum('Zeta', ['asc', 'desc']),
        makeEnum('Alpha', ['asc', 'desc']),
        makeEnum('Beta', ['asc', 'desc']),
      ];
      const aliases = buildEnumAliasMap(enums);
      expect(aliases.get('Beta')).toBe('Alpha');
      expect(aliases.get('Zeta')).toBe('Alpha');
      expect(aliases.has('Alpha')).toBe(false); // canonical isn't its own alias
    });

    it('reorders ignoring value order — same set, different order, still groups', () => {
      const enums: Enum[] = [makeEnum('A', ['desc', 'asc', 'normal']), makeEnum('B', ['normal', 'asc', 'desc'])];
      const aliases = buildEnumAliasMap(enums);
      expect(aliases.get('B')).toBe('A');
    });

    it('honors a custom selectCanonical for tie-breaking', () => {
      const enums: Enum[] = [makeEnum('LongName', ['x']), makeEnum('Short', ['x'])];
      // Pick shortest name as canonical instead of alphabetical default.
      const aliases = buildEnumAliasMap(enums, {
        selectCanonical: (group) => [...group].sort((a, b) => a.name.length - b.name.length)[0],
      });
      expect(aliases.get('LongName')).toBe('Short');
    });

    it('prefers a baseline canonical over the default selection', () => {
      const enums: Enum[] = [
        // Default heuristic (alphabetical) would pick "ApiKeysOrder" because
        // it sorts before "ApplicationsOrder". Baseline preference must
        // override that and keep the previously-canonical name.
        makeEnum('ApiKeysOrder', ['asc', 'desc', 'normal']),
        makeEnum('ApplicationsOrder', ['asc', 'desc', 'normal']),
      ];
      const aliases = buildEnumAliasMap(enums, {
        baselineCanonicalNames: new Set(['ApplicationsOrder']),
      });
      expect(aliases.get('ApiKeysOrder')).toBe('ApplicationsOrder');
      expect(aliases.has('ApplicationsOrder')).toBe(false);
    });

    it('prefers a baseline canonical even when the default heuristic picks a shorter name', () => {
      // The Vault BYOK regression: the new "Deleted" enum (shorter) was
      // taking canonical from the existing "VerificationCompleted" enum,
      // renaming a previously-canonical type and breaking SDK consumers.
      const enums: Enum[] = [
        makeEnum('VaultByokKeyDeletedDataKeyProvider', ['AWS_KMS', 'AZURE_KEY_VAULT', 'GCP_KMS']),
        makeEnum('VaultByokKeyVerificationCompletedDataKeyProvider', ['AWS_KMS', 'AZURE_KEY_VAULT', 'GCP_KMS']),
      ];
      const aliases = buildEnumAliasMap(enums, {
        baselineCanonicalNames: new Set(['VaultByokKeyVerificationCompletedDataKeyProvider']),
        // Mimic PHP/Kotlin's "shortest className" preference. Without
        // baseline awareness this would pick the new shorter name.
        selectCanonical: (group) => [...group].sort((a, b) => a.name.length - b.name.length)[0],
      });
      expect(aliases.get('VaultByokKeyDeletedDataKeyProvider')).toBe(
        'VaultByokKeyVerificationCompletedDataKeyProvider',
      );
    });

    it('breaks baseline ties alphabetically when multiple group members are in the baseline', () => {
      const enums: Enum[] = [makeEnum('Beta', ['x']), makeEnum('Alpha', ['x']), makeEnum('NotInBaseline', ['x'])];
      const aliases = buildEnumAliasMap(enums, {
        baselineCanonicalNames: new Set(['Beta', 'Alpha']),
      });
      // Both "Alpha" and "Beta" are baseline-canonical; alphabetical breaks the tie.
      expect(aliases.get('Beta')).toBe('Alpha');
      expect(aliases.get('NotInBaseline')).toBe('Alpha');
    });

    it('falls back to the default heuristic when no group member is in the baseline', () => {
      const enums: Enum[] = [makeEnum('Beta', ['x']), makeEnum('Alpha', ['x'])];
      const aliases = buildEnumAliasMap(enums, {
        baselineCanonicalNames: new Set(['SomeOtherEnum']),
      });
      expect(aliases.get('Beta')).toBe('Alpha');
    });

    it('uses classNameOf to compare IR names against baseline class names', () => {
      // IR uses "FooBar" but PHP renders as "FooBarEnum" in the baseline.
      const enums: Enum[] = [makeEnum('FooBar', ['x']), makeEnum('Other', ['x'])];
      const aliases = buildEnumAliasMap(enums, {
        baselineCanonicalNames: new Set(['FooBarEnum']),
        classNameOf: (irName) => `${irName}Enum`,
      });
      expect(aliases.get('Other')).toBe('FooBar');
    });
  });

  describe('baselineEnumNamesFrom', () => {
    it('returns undefined when surface is undefined', () => {
      expect(baselineEnumNamesFrom(undefined)).toBeUndefined();
    });

    it('returns undefined when surface has no enums', () => {
      expect(baselineEnumNamesFrom({ enums: {} })).toBeUndefined();
    });

    it('returns the set of enum class names from a populated surface', () => {
      const surface = { enums: { Foo: { name: 'Foo' }, Bar: { name: 'Bar' } } };
      const names = baselineEnumNamesFrom(surface);
      expect(names).toBeDefined();
      expect(names!.has('Foo')).toBe(true);
      expect(names!.has('Bar')).toBe(true);
      expect(names!.size).toBe(2);
    });
  });
});
