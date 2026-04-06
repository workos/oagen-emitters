import type { Enum, EmitterContext, GeneratedFile, Service } from '@workos/oagen';
import { walkTypeRef } from '@workos/oagen';
import { className } from './naming.js';

/**
 * Generate Go typed string enum constants from IR Enum definitions.
 *
 * Each enum becomes a named string type + const block:
 *   type Status string
 *   const (
 *     StatusActive   Status = "active"
 *     StatusInactive Status = "inactive"
 *   )
 */
export function generateEnums(enums: Enum[], ctx: EmitterContext): GeneratedFile[] {
  if (enums.length === 0) return [];

  const aliasOf = collectEnumAliasOf(enums);
  const files: GeneratedFile[] = [];

  // Group all enums into a single file per SDK
  const lines: string[] = [];
  lines.push(`package ${ctx.namespace}`);
  lines.push('');

  for (const enumDef of enums) {
    // If this enum is an alias, emit a simple type alias
    const canonicalName = aliasOf.get(enumDef.name);
    if (canonicalName) {
      const aliasType = className(enumDef.name);
      const canonicalType = className(canonicalName);
      lines.push(`// ${aliasType} is an alias for ${canonicalType}.`);
      lines.push(`type ${aliasType} = ${canonicalType}`);
      lines.push('');
      continue;
    }

    const typeName = className(enumDef.name);

    if (enumDef.values.length === 0) {
      lines.push(`// ${typeName} represents ${humanize(enumDef.name)} values.`);
      lines.push(`type ${typeName} = string`);
      lines.push('');
      continue;
    }

    // Deduplicate values
    const seenValues = new Set<string>();
    const uniqueValues: typeof enumDef.values = [];
    for (const v of enumDef.values) {
      const vs = String(v.value);
      if (!seenValues.has(vs)) {
        seenValues.add(vs);
        uniqueValues.push(v);
      }
    }

    lines.push(`// ${typeName} represents ${humanize(enumDef.name)} values.`);
    lines.push(`type ${typeName} string`);
    lines.push('');
    lines.push('const (');

    const usedNames = new Set<string>();
    for (const v of uniqueValues) {
      let constSuffix = className(String(v.value));
      // Avoid collision with the type itself
      if (usedNames.has(`${typeName}${constSuffix}`)) {
        let suffix = 2;
        while (usedNames.has(`${typeName}${constSuffix}${suffix}`)) suffix++;
        constSuffix = `${constSuffix}${suffix}`;
      }
      const constName = `${typeName}${constSuffix}`;
      usedNames.add(constName);
      const valueStr = typeof v.value === 'string' ? `"${v.value}"` : String(v.value);
      if (v.description) {
        lines.push(`\t// ${constName} is ${v.description}.`);
      }
      lines.push(`\t${constName} ${typeName} = ${valueStr}`);
    }
    lines.push(')');
    lines.push('');
  }

  files.push({
    path: 'enums.go',
    content: lines.join('\n'),
  });

  return files;
}

function humanize(name: string): string {
  let result = name.replace(/([a-z])([A-Z])/g, '$1 $2');
  result = result.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return result.toLowerCase();
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
