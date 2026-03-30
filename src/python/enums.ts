import type { Enum, EmitterContext, GeneratedFile, Service } from '@workos/oagen';
import { toUpperSnakeCase, walkTypeRef } from '@workos/oagen';
import { fileName, resolveServiceDir, buildServiceNameMap } from './naming.js';

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
  const serviceNameMap = buildServiceNameMap(ctx.spec.services, ctx);
  const resolveDir = (irService: string | undefined) =>
    irService ? resolveServiceDir(serviceNameMap.get(irService) ?? irService) : 'common';
  const files: GeneratedFile[] = [];

  // Build hash for deduplication based on sorted member values
  const enumHashMap = new Map<string, string>();
  const hashGroups = new Map<string, string[]>();
  for (const enumDef of enums) {
    const hash = [...enumDef.values]
      .map((v) => String(v.value))
      .sort()
      .join('|');
    enumHashMap.set(enumDef.name, hash);
    if (!hashGroups.has(hash)) hashGroups.set(hash, []);
    hashGroups.get(hash)!.push(enumDef.name);
  }

  // For identical enums, pick canonical (alphabetically first)
  const aliasOf = new Map<string, string>();
  for (const [, names] of hashGroups) {
    if (names.length <= 1) continue;
    const sorted = [...names].sort();
    const canonical = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      aliasOf.set(sorted[i], canonical);
    }
  }

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
        lines.push(`from ${ctx.namespace}.${canonicalDir}.models import ${canonicalName}`);
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
          uniqueValues.push(value);
        }
      }

      // Determine if all values are strings or all integers
      const allStrings = uniqueValues.every((v) => typeof v.value === 'string');
      const allIntegers = uniqueValues.every((v) => typeof v.value === 'number' && Number.isInteger(v.value));

      if (allStrings) {
        lines.push('from enum import Enum');
        lines.push('');
        lines.push('');
        lines.push(`class ${enumDef.name}(str, Enum):`);
        lines.push(`    """Known values for ${enumDef.name}."""`);
        lines.push('');
      } else if (allIntegers) {
        lines.push('from enum import IntEnum');
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
    }

    files.push({
      path: `src/${ctx.namespace}/${dirName}/models/${fileName(enumDef.name)}.py`,
      content: lines.join('\n'),
      integrateTarget: true,
      overwriteExisting: true,
    });
  }

  return files;
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
