import type { Enum, EmitterContext, GeneratedFile, Service } from '@workos/oagen';
import { className, fileName } from './naming.js';

/**
 * Generate PHP 8.1+ backed enum classes from IR Enum definitions.
 */
export function generateEnums(enums: Enum[], ctx: EmitterContext): GeneratedFile[] {
  if (enums.length === 0) return [];

  const files: GeneratedFile[] = [];

  for (const e of enums) {
    const phpClassName = className(e.name);
    const phpFileName = fileName(e.name);

    // Determine backing type
    const allInts = e.values.every((v) => typeof v.value === 'number' && Number.isInteger(v.value));
    const backingType = allInts ? 'int' : 'string';

    const lines: string[] = [];
    lines.push('<?php');
    lines.push('');
    lines.push(`namespace ${ctx.namespacePascal}\\Enums;`);
    lines.push('');

    lines.push(`enum ${phpClassName}: ${backingType}`);
    lines.push('{');

    // Generate cases
    const usedCaseNames = new Set<string>();
    for (const v of e.values) {
      let caseName = toPascalCaseEnumCase(String(v.name));
      // Deduplicate case names
      if (usedCaseNames.has(caseName)) {
        let suffix = 2;
        while (usedCaseNames.has(`${caseName}${suffix}`)) suffix++;
        caseName = `${caseName}${suffix}`;
      }
      usedCaseNames.add(caseName);

      const value = backingType === 'int' ? String(v.value) : `'${String(v.value).replace(/'/g, "\\'")}'`;
      if (v.description) {
        lines.push(`    /** ${v.description} */`);
      }
      lines.push(`    case ${caseName} = ${value};`);
    }

    lines.push('}');

    files.push({
      path: `src/Enums/${phpFileName}.php`,
      content: lines.join('\n'),
      integrateTarget: true,
      overwriteExisting: true,
    });
  }

  return files;
}

/** Assign enums to services for directory placement. */
export function assignEnumsToServices(enums: Enum[], services: Service[]): Map<string, string> {
  const map = new Map<string, string>();
  // Simple assignment — collect all enum refs from service operations
  for (const service of services) {
    for (const op of service.operations) {
      const refs = collectEnumRefsFromOp(op);
      for (const ref of refs) {
        if (!map.has(ref)) {
          map.set(ref, service.name);
        }
      }
    }
  }
  return map;
}

function collectEnumRefsFromOp(op: any): string[] {
  const refs: string[] = [];
  const walk = (ref: any) => {
    if (!ref) return;
    if (ref.kind === 'enum') refs.push(ref.name);
    if (ref.kind === 'array') walk(ref.items);
    if (ref.kind === 'nullable') walk(ref.inner);
    if (ref.kind === 'union') ref.variants?.forEach(walk);
    if (ref.kind === 'map') walk(ref.valueType);
  };
  walk(op.response);
  walk(op.requestBody);
  for (const p of [...(op.pathParams ?? []), ...(op.queryParams ?? [])]) {
    walk(p.type);
  }
  return refs;
}

/**
 * Convert UPPER_SNAKE_CASE enum value name to PascalCase for PHP enum cases.
 */
function toPascalCaseEnumCase(name: string): string {
  return name
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join('');
}
