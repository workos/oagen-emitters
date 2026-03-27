import type { Enum, EmitterContext, GeneratedFile, Service } from '@workos/oagen';
import { toUpperSnakeCase, walkTypeRef } from '@workos/oagen';
import { fileName, resolveServiceDir, buildServiceNameMap } from './naming.js';

/**
 * Generate Python StrEnum files from IR Enum definitions.
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

    lines.push('from enum import Enum');
    lines.push('');
    lines.push('');
    lines.push(`class ${enumDef.name}(str, Enum):`);

    if (enumDef.values.length === 0) {
      lines.push('    pass');
    } else {
      const usedNames = new Set<string>();
      for (const value of enumDef.values) {
        let memberName = toUpperSnakeCase(String(value.value));
        // Deduplicate member names by appending a numeric suffix
        if (usedNames.has(memberName)) {
          let suffix = 2;
          while (usedNames.has(`${memberName}_${suffix}`)) suffix++;
          memberName = `${memberName}_${suffix}`;
        }
        usedNames.add(memberName);
        const valueStr = typeof value.value === 'string' ? `"${value.value}"` : String(value.value);
        if (value.description) {
          lines.push(`    ${memberName} = ${valueStr}`);
          lines.push(`    """${value.description}"""`);
        } else {
          lines.push(`    ${memberName} = ${valueStr}`);
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
