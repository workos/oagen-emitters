import type { Enum, EmitterContext, GeneratedFile, Service } from '@workos/oagen';
import { toUpperSnakeCase, walkTypeRef } from '@workos/oagen';
import { fileName, buildServiceDirMap, dirToModule } from './naming.js';
import { groupServicesByNamespace } from './client.js';

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

  const enumToService = assignEnumsToServices(enums, ctx.spec.services);
  const grouping = groupServicesByNamespace(ctx.spec.services, ctx);
  const serviceDirMap = buildServiceDirMap(grouping);
  const resolveDir = (irService: string | undefined) =>
    irService ? (serviceDirMap.get(irService) ?? 'common') : 'common';
  const files: GeneratedFile[] = [];
  const compatAliases = collectCompatEnumAliases(enums, ctx);

  const aliasOf = collectEnumAliasOf(enums);

  for (const enumDef of enums) {
    const service = enumToService.get(enumDef.name);
    const dirName = resolveDir(service);

    // If this enum is an alias for a canonical enum, generate a type alias file
    const canonicalName = aliasOf.get(enumDef.name);
    if (canonicalName) {
      const canonicalService = enumToService.get(canonicalName);
      const canonicalDir = resolveDir(canonicalService);
      const lines: string[] = [];
      // Use explicit __all__ to prevent ruff F401 from stripping the re-export
      if (canonicalDir === dirName) {
        lines.push(`from .${fileName(canonicalName)} import ${canonicalName}`);
      } else {
        lines.push(`from ${ctx.namespace}.${dirToModule(canonicalDir)}.models import ${canonicalName}`);
      }
      lines.push('');
      lines.push(`${enumDef.name} = ${canonicalName}`);
      lines.push(`__all__ = ["${enumDef.name}"]`);
      files.push({
        path: `src/${ctx.namespace}/${dirName}/models/${fileName(enumDef.name)}.py`,
        content: lines.join('\n'),
        integrateTarget: true,
        overwriteExisting: true,
      });

      // Also generate compat alias files for dedup aliases (they may have compat aliases too)
      for (const aliasName of compatAliases.get(enumDef.name) ?? []) {
        const importLine =
          canonicalDir === dirName
            ? `from .${fileName(canonicalName)} import ${canonicalName}`
            : `from ${ctx.namespace}.${dirToModule(canonicalDir)}.models import ${canonicalName}`;
        files.push({
          path: `src/${ctx.namespace}/${dirName}/models/${fileName(aliasName)}.py`,
          content: [importLine, '', `${aliasName} = ${canonicalName}`, `__all__ = ["${aliasName}"]`].join('\n'),
          integrateTarget: true,
          overwriteExisting: true,
        });
      }

      continue;
    }

    const lines: string[] = [];

    const readable = humanizeClassName(enumDef.name);
    lines.push(`"""Enumeration of ${readable} values."""`);
    lines.push('');
    lines.push('from __future__ import annotations');
    lines.push('');

    if (enumDef.values.length === 0) {
      lines.push('from typing import Union');
      lines.push('from typing_extensions import TypeAlias');
      lines.push('');
      lines.push(`${enumDef.name}: TypeAlias = str`);
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
        lines.push('from typing_extensions import Literal, TypeAlias');
        lines.push('');
        lines.push('');
        lines.push(`class ${enumDef.name}(str, Enum):`);
        lines.push(`    """Known values for ${enumDef.name}."""`);
        lines.push('');
      } else if (allIntegers) {
        lines.push('from enum import IntEnum');
        lines.push('from typing_extensions import Literal, TypeAlias');
        lines.push('');
        lines.push('');
        lines.push(`class ${enumDef.name}(IntEnum):`);
        lines.push(`    """Known values for ${enumDef.name}."""`);
        lines.push('');
      } else {
        // Mixed types — fall back to Union[Literal[...], str]
        lines.push('from typing import Union');
        lines.push('from typing_extensions import Literal, TypeAlias');
        lines.push('');
        const literals = uniqueValues.map((v) => (typeof v.value === 'string' ? `"${v.value}"` : String(v.value)));
        lines.push(`${enumDef.name}: TypeAlias = Union[Literal[${literals.join(', ')}], str]`);
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
        const valueStr = typeof v.value === 'string' ? `"${v.value}"` : String(v.value);
        if (v.description) {
          lines.push(`    ${memberName} = ${valueStr}`);
          lines.push(`    """${v.description}"""`);
        } else {
          lines.push(`    ${memberName} = ${valueStr}`);
        }
      }
      if (allStrings) {
        lines.push('');
        lines.push('    @classmethod');
        lines.push(`    def _missing_(cls, value: object) -> Optional["${enumDef.name}"]:`);
        lines.push('        if not isinstance(value, str):');
        lines.push('            return None');
        lines.push('        unknown = str.__new__(cls, value)');
        lines.push('        unknown._name_ = value.upper()');
        lines.push('        unknown._value_ = value');
        lines.push('        return unknown');
      }
      lines.push('');
      lines.push(
        `${enumDef.name}Literal: TypeAlias = Literal[${uniqueValues
          .map((v) => (typeof v.value === 'string' ? `"${v.value}"` : String(v.value)))
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
          `from .${fileName(enumDef.name)} import ${enumDef.name}`,
          '',
          `${aliasName} = ${enumDef.name}`,
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

function collectEnumAliasOf(enums: Enum[]): Map<string, string> {
  const hashGroups = new Map<string, string[]>();
  for (const enumDef of enums) {
    const hash = [...enumDef.values]
      .map((v) => String(v.value))
      .sort()
      .join('|');
    if (!hashGroups.has(hash)) hashGroups.set(hash, []);
    hashGroups.get(hash)!.push(enumDef.name);
  }

  const aliasOf = new Map<string, string>();
  for (const [, names] of hashGroups) {
    if (names.length <= 1) continue;
    const sorted = [...names].sort();
    const canonical = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      aliasOf.set(sorted[i], canonical);
    }
  }
  return aliasOf;
}

export function collectGeneratedEnumSymbolsByDir(enums: Enum[], ctx: EmitterContext): Map<string, string[]> {
  const enumToService = assignEnumsToServices(enums, ctx.spec.services);
  const grouping = groupServicesByNamespace(ctx.spec.services, ctx);
  const serviceDirMap = buildServiceDirMap(grouping);
  const resolveDir = (irService: string | undefined) =>
    irService ? (serviceDirMap.get(irService) ?? 'common') : 'common';
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

export function assignEnumsToServices(enums: Enum[], services: Service[]): Map<string, string> {
  const enumToService = new Map<string, string>();
  const enumNames = new Set(enums.map((e) => e.name));

  for (const service of services) {
    for (const op of service.operations) {
      const refs = new Set<string>();
      const collect = (ref: any) => {
        walkTypeRef(ref, { enum: (r: any) => refs.add(r.name) });
      };
      if (op.requestBody) collect(op.requestBody);
      collect(op.response);
      for (const p of [...op.pathParams, ...op.queryParams, ...op.headerParams, ...(op.cookieParams ?? [])]) {
        collect(p.type);
      }
      for (const name of refs) {
        if (enumNames.has(name) && !enumToService.has(name)) {
          enumToService.set(name, service.name);
        }
      }
    }
  }

  return enumToService;
}
