import type { Enum, EmitterContext, GeneratedFile } from '@workos/oagen';
import { className, ktStringLiteral } from './naming.js';

const KOTLIN_SRC_PREFIX = 'src/main/kotlin/';
const ENUMS_PACKAGE = 'com.workos.types';
const ENUMS_DIR = 'com/workos/types';

/**
 * Generate Kotlin `enum class` types from the IR enums. Each enum is emitted
 * to its own file under `com.workos.types`, annotated with Jackson
 * `@JsonValue` on the wire value. An `Unknown` sentinel is always the first
 * constant so that responses with new variants still deserialize instead of
 * throwing.
 */
export function generateEnums(enums: Enum[], _ctx: EmitterContext): GeneratedFile[] {
  if (enums.length === 0) return [];
  const files: GeneratedFile[] = [];

  for (const enumDef of enums) {
    if (enumDef.values.length === 0) continue;

    const typeName = className(enumDef.name);
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

    for (let i = 0; i < members.length; i++) {
      const isLast = i === members.length - 1;
      const line = members[i];
      const trimmedStart = line.trimStart();
      if (trimmedStart.startsWith('/**') || trimmedStart.startsWith('@')) {
        lines.push(line);
        continue;
      }
      lines.push(isLast ? line : `${line},`);
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

function escapeKdoc(s: string): string {
  return s.replace(/\*\//g, '*\u200b/');
}
