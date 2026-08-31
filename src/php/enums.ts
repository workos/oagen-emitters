import type { Enum, EmitterContext, GeneratedFile } from '@workos/oagen';
import { toPascalCase } from '@workos/oagen';
import { className, guardEnumCaseName, resolveEnumName } from './naming.js';
import { phpDocComment } from './utils.js';
import { isEnumInScope } from '../shared/resolved-ops.js';

/**
 * Generate PHP enum files from IR enums.
 */
export function generateEnums(enums: Enum[], ctx: EmitterContext): GeneratedFile[] {
  if (enums.length === 0) return [];

  const files: GeneratedFile[] = [];
  const emittedCanonical = new Set<string>();

  for (const e of enums) {
    const canonical = resolveEnumName(e.name);
    if (emittedCanonical.has(canonical)) continue; // skip aliases
    emittedCanonical.add(canonical);

    // FR-1.4: write the per-enum FILE only when in scope. PHP dedupes
    // value-identical enums onto a single canonical class, so the canonical
    // file is needed when EITHER the canonical name OR any alias resolving to
    // it is reachable from the selected services. PSR-4 (one class per file
    // under lib/Resource/, no barrel) means an out-of-scope enum is simply
    // left untouched on disk and stays loadable.
    const enumInScope = enums.some(
      (other) => resolveEnumName(other.name) === canonical && isEnumInScope(other.name, ctx),
    );

    const name = className(canonical);
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
      let caseName = guardEnumCaseName(toPascalCase(val.name.toLowerCase()));
      const baseName = caseName;
      const count = usedNames.get(baseName) ?? 0;
      if (count > 0) {
        caseName = `${baseName}${count + 1}`;
      }
      usedNames.set(baseName, count + 1);

      if (val.description || val.deprecated) {
        const parts: string[] = [];
        if (val.description) parts.push(val.description);
        if (val.deprecated) parts.push('@deprecated');
        lines.push(...phpDocComment(parts.join('\n'), 4));
      }

      if (typeof val.value === 'string') {
        lines.push(`    case ${caseName} = '${val.value}';`);
      } else {
        lines.push(`    case ${caseName} = ${val.value};`);
      }
    }

    lines.push('}');

    if (enumInScope) {
      files.push({
        path: `lib/Resource/${name}.php`,
        content: lines.join('\n'),
        overwriteExisting: true,
      });
    }
  }

  return files;
}
