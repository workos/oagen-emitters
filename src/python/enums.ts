import type { Enum, EmitterContext, GeneratedFile } from '@workos/oagen';
import { toUpperSnakeCase } from '@workos/oagen';
import { className, fileName, buildMountDirMap, dirToModule } from './naming.js';
import { computeSchemaPlacement } from './shared-schemas.js';

/**
 * Convert a PascalCase class name to a human-readable lowercase string,
 * preserving known acronyms instead of splitting them character-by-character.
 */
function humanizeClassName(name: string): string {
  // Insert spaces before uppercase runs, but keep acronyms together
  let result = name.replace(/([a-z])([A-Z])/g, '$1 $2');
  // Split consecutive uppercase letters from following lowercase: "SSOProvider" -> "SSO Provider"
  result = result.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return result.toLowerCase();
}

/**
 * Generate Python enum class files from IR Enum definitions.
 * Uses `(str, Enum)` for type-safe enum values (Python 3.10+).
 */
export function generateEnums(enums: Enum[], ctx: EmitterContext): GeneratedFile[] {
  if (enums.length === 0) return [];

  // Tests sometimes pass enums that aren't in ctx.spec.enums, so synthesize a
  // spec view with the passed-in enums to keep the placement logic accurate.
  const placementSpec = enums === ctx.spec.enums ? ctx.spec : { ...ctx.spec, enums };
  const placement = computeSchemaPlacement(placementSpec, ctx);
  const enumToService = placement.enumToService;
  const mountDirMap = buildMountDirMap(ctx);
  const resolveDir = (irService: string | undefined) =>
    irService ? (mountDirMap.get(irService) ?? 'common') : 'common';
  const files: GeneratedFile[] = [];
  const compatAliases = collectCompatEnumAliases(enums, ctx);

  const aliasOf = placement.enumAliases;

  for (const enumDef of enums) {
    const service = enumToService.get(enumDef.name);
    const dirName = resolveDir(service);

    // If this enum is an alias for a canonical enum, generate a type alias file
    const canonicalName = aliasOf.get(enumDef.name);
    if (canonicalName) {
      // Skip when alias and canonical produce the same file name (self-import)
      if (fileName(enumDef.name) === fileName(canonicalName)) continue;
      const canonicalService = enumToService.get(canonicalName);
      const canonicalDir = resolveDir(canonicalService);
      const canonicalCls = className(canonicalName);
      const aliasCls = className(enumDef.name);
      const lines: string[] = [];
      // Use explicit __all__ to prevent ruff F401 from stripping the re-export
      // Always use direct file import to avoid barrel dependency on the canonical
      if (canonicalDir === dirName) {
        lines.push('from typing import TypeAlias');
        lines.push(`from .${fileName(canonicalName)} import ${canonicalCls}`);
        lines.push('');
        lines.push(`${aliasCls}: TypeAlias = ${canonicalCls}`);
      } else {
        // Cross-service enum aliases use TYPE_CHECKING + __getattr__ to avoid
        // circular imports caused by service __init__.py eagerly re-exporting
        // all models (e.g. common → radar → common cycle).
        const modPath = `${ctx.namespace}.${dirToModule(canonicalDir)}.models.${fileName(canonicalName)}`;
        lines.push('from typing import TYPE_CHECKING');
        lines.push('');
        lines.push('if TYPE_CHECKING:');
        lines.push(`    from ${modPath} import ${canonicalCls} as ${aliasCls}`);
        lines.push('else:');
        lines.push('    def __getattr__(name: str):');
        lines.push(`        if name == "${aliasCls}":`);
        lines.push(`            from ${modPath} import ${canonicalCls}`);
        lines.push(`            return ${canonicalCls}`);
        lines.push('        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")');
      }
      lines.push(`__all__ = ["${aliasCls}"]`);
      files.push({
        path: `src/${ctx.namespace}/${dirName}/models/${fileName(enumDef.name)}.py`,
        content: lines.join('\n'),
        integrateTarget: true,
        overwriteExisting: true,
      });

      // Also generate compat alias files for dedup aliases (they may have compat aliases too)
      for (const aliasName of compatAliases.get(enumDef.name) ?? []) {
        let compatContent: string;
        if (canonicalDir === dirName) {
          compatContent = [
            'from typing import TypeAlias',
            `from .${fileName(canonicalName)} import ${canonicalCls}`,
            '',
            `${aliasName}: TypeAlias = ${canonicalCls}`,
            `__all__ = ["${aliasName}"]`,
          ].join('\n');
        } else {
          const modPath = `${ctx.namespace}.${dirToModule(canonicalDir)}.models.${fileName(canonicalName)}`;
          compatContent = [
            'from typing import TYPE_CHECKING',
            '',
            'if TYPE_CHECKING:',
            `    from ${modPath} import ${canonicalCls} as ${aliasName}`,
            'else:',
            '    def __getattr__(name: str):',
            `        if name == "${aliasName}":`,
            `            from ${modPath} import ${canonicalCls}`,
            `            return ${canonicalCls}`,
            '        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")',
            `__all__ = ["${aliasName}"]`,
          ].join('\n');
        }
        files.push({
          path: `src/${ctx.namespace}/${dirName}/models/${fileName(aliasName)}.py`,
          content: compatContent,
          integrateTarget: true,
          overwriteExisting: true,
        });
      }

      continue;
    }

    const cls = className(enumDef.name);
    const lines: string[] = [];

    const readable = humanizeClassName(enumDef.name);
    lines.push(`"""Enumeration of ${readable} values."""`);
    lines.push('');
    lines.push('from __future__ import annotations');
    lines.push('');

    if (enumDef.values.length === 0) {
      lines.push('from typing import Union');
      lines.push('from typing import TypeAlias');
      lines.push('');
      lines.push(`${cls}: TypeAlias = str`);
    } else {
      // Deduplicate values that produce the same string
      const seenValues = new Set<string>();
      const uniqueValues: typeof enumDef.values = [];
      for (const value of enumDef.values) {
        const valueStr = String(value.value);
        if (!seenValues.has(valueStr)) {
          seenValues.add(valueStr);
          uniqueValues.push({ ...value, value: valueStr });
        }
      }

      // Determine if all values are strings or all integers
      const allStrings = uniqueValues.every((v) => typeof v.value === 'string');
      const allIntegers = uniqueValues.every((v) => typeof v.value === 'number' && Number.isInteger(v.value));

      if (allStrings) {
        lines.push('from enum import Enum');
        lines.push('from typing import Optional');
        lines.push('from typing import Literal, TypeAlias');
        lines.push('');
        lines.push('');
        lines.push(`class ${cls}(str, Enum):`);
        lines.push(`    """Known values for ${cls}."""`);
        lines.push('');
      } else if (allIntegers) {
        lines.push('from enum import IntEnum');
        lines.push('from typing import Literal, TypeAlias');
        lines.push('');
        lines.push('');
        lines.push(`class ${cls}(IntEnum):`);
        lines.push(`    """Known values for ${cls}."""`);
        lines.push('');
      } else {
        // Mixed types — fall back to Union[Literal[...], str]
        lines.push('from typing import Union');
        lines.push('from typing import Literal, TypeAlias');
        lines.push('');
        const literals = uniqueValues.map((v) =>
          typeof v.value === 'string'
            ? `"${v.value}"`
            : typeof v.value === 'boolean'
              ? v.value
                ? 'True'
                : 'False'
              : String(v.value),
        );
        lines.push(`${cls}: TypeAlias = Union[Literal[${literals.join(', ')}], str]`);
        files.push({
          path: `src/${ctx.namespace}/${dirName}/models/${fileName(enumDef.name)}.py`,
          content: lines.join('\n'),
          integrateTarget: true,
          overwriteExisting: true,
        });
        continue;
      }

      const usedNames = new Set<string>();
      for (const v of uniqueValues) {
        let memberName = toUpperSnakeCase(String(v.value));
        if (usedNames.has(memberName)) {
          let suffix = 2;
          while (usedNames.has(`${memberName}_${suffix}`)) suffix++;
          memberName = `${memberName}_${suffix}`;
        }
        usedNames.add(memberName);
        const valueStr =
          typeof v.value === 'string'
            ? `"${v.value}"`
            : typeof v.value === 'boolean'
              ? v.value
                ? 'True'
                : 'False'
              : String(v.value);
        lines.push(`    ${memberName} = ${valueStr}`);
        if (v.description || v.deprecated) {
          const parts: string[] = [];
          if (v.description) parts.push(v.description);
          if (v.deprecated) parts.push('.. deprecated::');
          lines.push(`    """${parts.join('\n\n    ')}"""`);
        }
      }
      if (allStrings) {
        lines.push('');
        lines.push('    @classmethod');
        lines.push(`    def _missing_(cls, value: object) -> Optional["${cls}"]:`);
        lines.push('        if not isinstance(value, str):');
        lines.push('            return None');
        lines.push('        unknown = str.__new__(cls, value)');
        lines.push('        unknown._name_ = value.upper()');
        lines.push('        unknown._value_ = value');
        lines.push('        return unknown');
      }
      lines.push('');
      lines.push(
        `${cls}Literal: TypeAlias = Literal[${uniqueValues
          .map((v) =>
            typeof v.value === 'string'
              ? `"${v.value}"`
              : typeof v.value === 'boolean'
                ? v.value
                  ? 'True'
                  : 'False'
                : String(v.value),
          )
          .join(', ')}]`,
      );
    }

    files.push({
      path: `src/${ctx.namespace}/${dirName}/models/${fileName(enumDef.name)}.py`,
      content: lines.join('\n'),
      integrateTarget: true,
      overwriteExisting: true,
    });

    for (const aliasName of compatAliases.get(enumDef.name) ?? []) {
      files.push({
        path: `src/${ctx.namespace}/${dirName}/models/${fileName(aliasName)}.py`,
        content: [
          'from typing import TypeAlias',
          `from .${fileName(enumDef.name)} import ${cls}`,
          '',
          `${aliasName}: TypeAlias = ${cls}`,
          `__all__ = ["${aliasName}"]`,
        ].join('\n'),
        integrateTarget: true,
        overwriteExisting: true,
      });
    }
  }

  return files;
}

export function collectCompatEnumAliases(enums: Enum[], ctx: EmitterContext): Map<string, string[]> {
  const aliases = new Map<string, string[]>();
  const irEnumNames = new Set(enums.map((enumDef) => enumDef.name));
  const normalizedHashToEnum = new Map<string, string>();

  for (const enumDef of enums) {
    normalizedHashToEnum.set(enumValueHash(enumDef), enumDef.name);
  }

  for (const baselineEnum of Object.values(ctx.apiSurface?.enums ?? {})) {
    if (irEnumNames.has(baselineEnum.name)) continue;
    const hash = Object.values(baselineEnum.members)
      .map((value) => String(value))
      .sort()
      .join('|');
    const target = normalizedHashToEnum.get(hash);
    if (!target) continue;
    if (!aliases.has(target)) aliases.set(target, []);
    aliases.get(target)!.push(baselineEnum.name);
  }

  return aliases;
}

export function collectGeneratedEnumSymbolsByDir(enums: Enum[], ctx: EmitterContext): Map<string, string[]> {
  const placementSpec = enums === ctx.spec.enums ? ctx.spec : { ...ctx.spec, enums };
  const enumToService = computeSchemaPlacement(placementSpec, ctx).enumToService;
  const mountDirMap = buildMountDirMap(ctx);
  const resolveDir = (irService: string | undefined) =>
    irService ? (mountDirMap.get(irService) ?? 'common') : 'common';
  const compatAliases = collectCompatEnumAliases(enums, ctx);
  const symbolsByDir = new Map<string, string[]>();

  for (const enumDef of enums) {
    const service = enumToService.get(enumDef.name);
    const dirName = resolveDir(service);
    if (!symbolsByDir.has(dirName)) symbolsByDir.set(dirName, []);
    symbolsByDir.get(dirName)!.push(enumDef.name);
    for (const aliasName of compatAliases.get(enumDef.name) ?? []) {
      symbolsByDir.get(dirName)!.push(aliasName);
    }
  }

  return symbolsByDir;
}

function enumValueHash(enumDef: Enum): string {
  return [...enumDef.values]
    .map((value) => String(value.value))
    .sort()
    .join('|');
}
