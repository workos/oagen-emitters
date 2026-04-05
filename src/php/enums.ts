import type { Enum, EmitterContext, GeneratedFile } from '@workos/oagen';
import { toPascalCase } from '@workos/oagen';
import { className } from './naming.js';

/**
 * Generate PHP enum files from IR enums.
 */
export function generateEnums(enums: Enum[], ctx: EmitterContext): GeneratedFile[] {
  if (enums.length === 0) return [];

  const files: GeneratedFile[] = [];

  for (const e of enums) {
    const name = className(e.name);
    const _isAllStrings = e.values.every((v) => typeof v.value === 'string');
    const isAllInts = e.values.every((v) => typeof v.value === 'number' && Number.isInteger(v.value));
    const backingType = isAllInts ? 'int' : 'string';

    const lines: string[] = [];
    // No <?php here — the file header from fileHeader() provides it
    lines.push(`namespace ${ctx.namespacePascal}\\Resource;`);
    lines.push('');
    lines.push(`enum ${name}: ${backingType}`);
    lines.push('{');

    // Deduplicate case names
    const usedNames = new Map<string, number>();
    for (const val of e.values) {
      let caseName = toPascalCase(val.name.toLowerCase());
      const baseName = caseName;
      const count = usedNames.get(baseName) ?? 0;
      if (count > 0) {
        caseName = `${baseName}${count + 1}`;
      }
      usedNames.set(baseName, count + 1);

      if (typeof val.value === 'string') {
        lines.push(`    case ${caseName} = '${val.value}';`);
      } else {
        lines.push(`    case ${caseName} = ${val.value};`);
      }
    }

    lines.push('}');

    files.push({
      path: `lib/Resource/${name}.php`,
      content: lines.join('\n'),
      overwriteExisting: true,
    });
  }

  return files;
}
