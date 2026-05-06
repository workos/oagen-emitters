import type { Enum, EmitterContext, GeneratedFile } from '@workos/oagen';
import { className, ktStringLiteral } from './naming.js';

const KOTLIN_SRC_PREFIX = 'src/main/kotlin/';
const ENUMS_PACKAGE = 'com.workos.types';
const ENUMS_DIR = 'com/workos/types';

/**
 * Mapping from an IR enum name to its canonical enum name. When two enums
 * share identical sorted wire values the shorter-named one is canonical and
 * the others become `typealias` files. Downstream consumers (type-map,
 * resources) use this map to resolve references to the canonical class.
 */
export const enumCanonicalMap = new Map<string, string>();

/**
 * Generate Kotlin `enum class` types from the IR enums. Each enum is emitted
 * to its own file under `com.workos.types`, annotated with Jackson
 * `@JsonValue` on the wire value. An `Unknown` sentinel is always the first
 * constant so that responses with new variants still deserialize instead of
 * throwing.
 *
 * Enums with identical sets of wire values are deduplicated: the one with the
 * shortest PascalCase name becomes canonical and the rest emit `typealias`
 * files pointing at the canonical class.
 */
export function generateEnums(enums: Enum[], _ctx: EmitterContext): GeneratedFile[] {
  if (enums.length === 0) return [];

  // Reset the canonical map on every generation run (guards against re-entry).
  enumCanonicalMap.clear();

  // --- Dedup: group enums by a hash of their sorted wire values. ---
  const hashGroups = new Map<string, Enum[]>();
  for (const enumDef of enums) {
    if (enumDef.values.length === 0) continue;
    const hash = enumWireHash(enumDef);
    if (!hashGroups.has(hash)) hashGroups.set(hash, []);
    hashGroups.get(hash)!.push(enumDef);
  }

  // Within each group, pick the shortest className as canonical.
  const aliasOf = new Map<string, string>(); // enum name → canonical enum name
  for (const [, group] of hashGroups) {
    if (group.length <= 1) continue;
    if (group.every(isSharedSortOrderEnum)) {
      const [canonical, ...rest] = [...group].sort((a, b) => a.name.localeCompare(b.name));
      enumCanonicalMap.set(canonical.name, canonical.name);
      for (const enumDef of rest) enumCanonicalMap.set(enumDef.name, 'SortOrder');
      continue;
    }
    const sorted = [...group].sort(
      (a, b) =>
        className(a.name).length - className(b.name).length || className(a.name).localeCompare(className(b.name)),
    );
    const canonical = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      aliasOf.set(sorted[i].name, canonical.name);
      enumCanonicalMap.set(sorted[i].name, canonical.name);
    }
  }

  const files: GeneratedFile[] = [];

  for (const enumDef of enums) {
    if (enumDef.values.length === 0) continue;

    const typeName = canonicalEnumTypeName(enumDef);

    // Non-canonical enum: emit a typealias instead of a full enum class.
    const sharedSortEmitter = isSharedSortOrderEnum(enumDef) && enumCanonicalMap.get(enumDef.name) === enumDef.name;
    const canonicalName = sharedSortEmitter
      ? undefined
      : (aliasOf.get(enumDef.name) ?? enumCanonicalMap.get(enumDef.name));
    if (canonicalName) {
      const canonicalType = className(canonicalName);
      // Skip when different IR names collapse to the same output name
      if (typeName === canonicalType) continue;
      const aliasLine = `typealias ${typeName} = ${canonicalType}`;
      // ktlint enforces a 140-char max line length. When the typealias
      // exceeds that, add a @file:Suppress to avoid an unfixable violation.
      const suppressLine = aliasLine.length > 140 ? `@file:Suppress("ktlint:standard:max-line-length")\n\n` : '';
      const aliasContent = [
        `${suppressLine}package ${ENUMS_PACKAGE}`,
        '',
        `/** Alias for [${canonicalType}]. */`,
        aliasLine,
        '',
      ].join('\n');
      files.push({
        path: `${KOTLIN_SRC_PREFIX}${ENUMS_DIR}/${typeName}.kt`,
        content: aliasContent,
        overwriteExisting: true,
      });
      continue;
    }

    const lines: string[] = [];
    lines.push(`package ${ENUMS_PACKAGE}`);
    lines.push('');
    lines.push('import com.fasterxml.jackson.annotation.JsonEnumDefaultValue');
    lines.push('import com.fasterxml.jackson.annotation.JsonValue');
    lines.push('');
    // Replace the tautological "Foo enum." docstring with a slightly more
    // informative summary. `Unknown` is emitted as the forward-compatibility
    // sentinel for values the server introduces after this SDK was built.
    lines.push(`/** Enumeration of valid ${typeName} values returned or accepted by the API. */`);
    lines.push(`enum class ${typeName}(`);
    lines.push('  /** The wire value sent to and received from the API. */');
    lines.push('  @JsonValue val value: String');
    lines.push(') {');
    // `@JsonEnumDefaultValue` makes Jackson's
    // READ_UNKNOWN_ENUM_VALUES_USING_DEFAULT_VALUE feature map unrecognized
    // wire values onto `Unknown` instead of throwing — required for forward
    // compatibility when the API introduces new variants.
    lines.push('  @JsonEnumDefaultValue');
    lines.push(`  Unknown(${ktStringLiteral('unknown')}),`);

    const seenNames = new Set<string>(['Unknown']);
    const seenWire = new Set<string>(['unknown']);
    const members: string[] = [];

    for (const v of enumDef.values) {
      const wire = String(v.value);
      if (seenWire.has(wire)) continue;
      seenWire.add(wire);

      let memberName = className(wire);
      if (!memberName || /^[0-9]/.test(memberName)) memberName = `Value${memberName || wire}`;
      if (memberName === typeName || seenNames.has(memberName)) {
        let suffix = 2;
        while (seenNames.has(`${memberName}${suffix}`)) suffix += 1;
        memberName = `${memberName}${suffix}`;
      }
      seenNames.add(memberName);

      if (v.description?.trim()) {
        members.push(`  /** ${escapeKdoc(v.description.split('\n')[0].trim())} */`);
      }
      if (v.deprecated) {
        members.push('  @Deprecated("Deprecated enum value")');
      }
      members.push(`  ${memberName}(${ktStringLiteral(wire)})`);
    }

    // Track whether we are currently in a doc block leading up to the next
    // enum value declaration. When the upcoming case has KDoc, insert a blank
    // line before the doc comment for visual separation (skip for the very
    // first case so we don't open the block with a blank).
    let firstValueEmitted = false;
    for (let i = 0; i < members.length; i++) {
      const isLast = i === members.length - 1;
      const line = members[i];
      const trimmedStart = line.trimStart();
      const isDocStart = trimmedStart.startsWith('/**');
      const isAnnotation = trimmedStart.startsWith('@');
      if (isDocStart && firstValueEmitted) {
        lines.push('');
      }
      if (isDocStart || isAnnotation) {
        lines.push(line);
        continue;
      }
      lines.push(isLast ? line : `${line},`);
      firstValueEmitted = true;
    }

    lines.push('}');
    lines.push('');

    files.push({
      path: `${KOTLIN_SRC_PREFIX}${ENUMS_DIR}/${typeName}.kt`,
      content: lines.join('\n'),
      overwriteExisting: true,
    });
  }

  return files;
}

function canonicalEnumTypeName(enumDef: Enum): string {
  return isSharedSortOrderEnum(enumDef) ? 'SortOrder' : className(enumDef.name);
}

function isSharedSortOrderEnum(enumDef: Enum): boolean {
  const wireValues = [...new Set(enumDef.values.map((value) => String(value.value).toLowerCase()))].sort();
  return wireValues.length === 2 && wireValues[0] === 'asc' && wireValues[1] === 'desc';
}

/** Hash an enum by its sorted wire values so identical enums collide. */
function enumWireHash(enumDef: Enum): string {
  return [...enumDef.values]
    .map((v) => String(v.value))
    .sort()
    .join('|');
}

function escapeKdoc(s: string): string {
  return s.replace(/\*\//g, '*\u200b/');
}
