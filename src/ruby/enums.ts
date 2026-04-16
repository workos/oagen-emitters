import type { Enum, EmitterContext, GeneratedFile } from '@workos/oagen';
import { toUpperSnakeCase } from '@workos/oagen';
import { className, fileName } from './naming.js';

/**
 * Generate Ruby enum class files.
 *
 * Each enum becomes a class under `WorkOS::Types::` with uppercase constants
 * and a frozen `ALL` array of all values.
 */
export function generateEnums(enums: Enum[], ctx: EmitterContext): GeneratedFile[] {
  void ctx;
  if (enums.length === 0) return [];

  const files: GeneratedFile[] = [];
  const aliasOf = collectEnumAliasOf(enums);

  for (const enumDef of enums) {
    const cls = className(enumDef.name);

    // If this enum duplicates another (by value set), emit a Ruby constant
    // alias. Zeitwerk autoloads the canonical when the alias is first
    // referenced.
    const canonicalName = aliasOf.get(enumDef.name);
    if (canonicalName) {
      const canonicalCls = className(canonicalName);
      const lines: string[] = [];
      lines.push('module WorkOS');
      lines.push('  module Types');
      lines.push(`    ${cls} = ${canonicalCls}`);
      lines.push('  end');
      lines.push('end');
      files.push({
        path: `lib/workos/types/${fileName(enumDef.name)}.rb`,
        content: lines.join('\n'),
        integrateTarget: true,
        overwriteExisting: true,
      });
      continue;
    }

    // Deduplicate repeated string values.
    const seen = new Set<string>();
    const uniqueValues: typeof enumDef.values = [];
    for (const v of enumDef.values) {
      const str = String(v.value);
      if (!seen.has(str)) {
        seen.add(str);
        uniqueValues.push({ ...v, value: str });
      }
    }

    if (uniqueValues.length === 0) {
      // No values — emit a placeholder string-alias class.
      const lines: string[] = [];
      lines.push('module WorkOS');
      lines.push('  module Types');
      lines.push(`    class ${cls}`);
      lines.push('      ALL = [].freeze');
      lines.push('    end');
      lines.push('  end');
      lines.push('end');
      files.push({
        path: `lib/workos/types/${fileName(enumDef.name)}.rb`,
        content: lines.join('\n'),
        integrateTarget: true,
        overwriteExisting: true,
      });
      continue;
    }

    // Determine string vs integer enum.
    const allIntegers = uniqueValues.every((v) => typeof v.value === 'number' && Number.isInteger(v.value));

    // Reserve ALL for the frozen list constant at the bottom; any enum value
    // whose upper-snake form collides gets a VALUE_ prefix.
    const RESERVED_MEMBER_NAMES = new Set(['ALL']);
    const usedNames = new Set<string>();
    const memberLines: string[] = [];
    const allEntries: string[] = [];

    for (const v of uniqueValues) {
      let member = toUpperSnakeCase(String(v.value));
      // Ruby constants must start with an uppercase letter.
      if (!/^[A-Z]/.test(member)) member = `VALUE_${member}`;
      if (RESERVED_MEMBER_NAMES.has(member)) member = `VALUE_${member}`;
      if (usedNames.has(member)) {
        let suffix = 2;
        while (usedNames.has(`${member}_${suffix}`)) suffix++;
        member = `${member}_${suffix}`;
      }
      usedNames.add(member);
      const valueLit = allIntegers ? String(v.value) : `'${String(v.value).replace(/'/g, "\\'")}'`;
      if (v.deprecated) {
        memberLines.push(`      # @deprecated`);
      }
      memberLines.push(`      ${member} = ${valueLit}`);
      allEntries.push(member);
    }

    const lines: string[] = [];
    lines.push('module WorkOS');
    lines.push('  module Types');
    lines.push(`    class ${cls}`);
    lines.push(...memberLines);
    lines.push(`      ALL = [${allEntries.join(', ')}].freeze`);
    lines.push('    end');
    lines.push('  end');
    lines.push('end');

    files.push({
      path: `lib/workos/types/${fileName(enumDef.name)}.rb`,
      content: lines.join('\n'),
      integrateTarget: true,
      overwriteExisting: true,
    });
  }

  return files;
}

/**
 * Detect when two or more enums have the same value set — pick the lexicographically
 * first as canonical and return a map of aliasName -> canonicalName for the rest.
 */
function collectEnumAliasOf(enums: Enum[]): Map<string, string> {
  const hashGroups = new Map<string, string[]>();
  for (const e of enums) {
    const hash = [...e.values]
      .map((v) => String(v.value))
      .sort()
      .join('|');
    if (!hashGroups.has(hash)) hashGroups.set(hash, []);
    hashGroups.get(hash)!.push(e.name);
  }
  const aliasOf = new Map<string, string>();
  for (const names of hashGroups.values()) {
    if (names.length <= 1) continue;
    const sorted = [...names].sort();
    const canonical = sorted[0];
    for (let i = 1; i < sorted.length; i++) aliasOf.set(sorted[i], canonical);
  }
  return aliasOf;
}

/** Collect the set of enum names that were emitted. */
export function collectEnumSymbols(enums: Enum[]): string[] {
  return enums.map((e) => e.name);
}
