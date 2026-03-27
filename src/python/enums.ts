import type { Enum, EmitterContext, GeneratedFile, Service } from '@workos/oagen';
import { toUpperSnakeCase, walkTypeRef } from '@workos/oagen';
import { fileName, resolveServiceDir, buildServiceNameMap } from './naming.js';

/**
 * Generate Python Literal type alias files from IR Enum definitions.
 * Uses Union[Literal[...], str] for forward compatibility with unknown API values.
 */
export function generateEnums(enums: Enum[], ctx: EmitterContext): GeneratedFile[] {
  if (enums.length === 0) return [];

  const enumToService = assignEnumsToServices(enums, ctx.spec.services);
  const serviceNameMap = buildServiceNameMap(ctx.spec.services, ctx);
  const resolveDir = (irService: string | undefined) =>
    irService ? resolveServiceDir(serviceNameMap.get(irService) ?? irService) : 'common';
  const files: GeneratedFile[] = [];

  for (const enumDef of enums) {
    const service = enumToService.get(enumDef.name);
    const dirName = resolveDir(service);
    const lines: string[] = [];

    lines.push('from __future__ import annotations');
    lines.push('');
    lines.push('from typing import Union');
    lines.push('from typing_extensions import Literal, TypeAlias');
    lines.push('');

    if (enumDef.values.length === 0) {
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

      const literals = uniqueValues.map((v) => (typeof v.value === 'string' ? `"${v.value}"` : String(v.value)));
      lines.push(`${enumDef.name}: TypeAlias = Union[Literal[${literals.join(', ')}], str]`);

      // Companion constants class for attribute access
      lines.push('');
      lines.push('');
      lines.push(`class ${enumDef.name}Values:`);
      lines.push(`    """Known values for ${enumDef.name}."""`);
      lines.push('');

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
          lines.push(`    ${memberName}: str = ${valueStr}`);
          lines.push(`    """${v.description}"""`);
        } else {
          lines.push(`    ${memberName}: str = ${valueStr}`);
        }
      }
    }

    files.push({
      path: `${ctx.namespace}/${dirName}/models/${fileName(enumDef.name)}.py`,
      content: lines.join('\n'),
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
