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
    lines.push('');
    lines.push(`namespace ${ctx.namespacePascal}\\Resource;`);
    lines.push('');

    lines.push(`enum ${phpClassName}: ${backingType}`);
    lines.push('{');

    // Generate cases
    const usedCaseNames = new Set<string>();
    for (const v of e.values) {
      let caseName = toEnumCaseName(String(v.name), v.value);
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
      path: `lib/Resource/${phpFileName}.php`,
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
 * Convert an enum value to a valid PHP enum case name.
 * Uses the backing value as the case name when it's a valid PHP identifier,
 * preserving the original casing from the API spec (e.g., 'AppleOAuth' stays as-is).
 * Falls back to PascalCase conversion for non-identifier values.
 */
function toEnumCaseName(name: string, value: string | number): string {
  const strValue = String(value);
  // If the value itself is a valid PHP identifier starting with uppercase, use it directly
  if (/^[A-Z][a-zA-Z0-9]*$/.test(strValue)) {
    return strValue;
  }
  // Otherwise, convert from the name (which may be UPPER_SNAKE_CASE)
  if (!name) return name;
  return name
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join('');
}
