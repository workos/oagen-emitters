import type { Enum, EmitterContext, GeneratedFile, Service } from '@workos/oagen';
import { walkTypeRef } from '@workos/oagen';
import { fileName, serviceDirName, buildServiceNameMap } from './naming.js';
import { docComment } from './utils.js';

export function generateEnums(enums: Enum[], ctx: EmitterContext): GeneratedFile[] {
  if (enums.length === 0) return [];

  const enumToService = assignEnumsToServices(enums, ctx.spec.services);
  const serviceNameMap = buildServiceNameMap(ctx.spec.services, ctx);
  const resolveDir = (irService: string | undefined) =>
    irService ? serviceDirName(serviceNameMap.get(irService) ?? irService) : 'common';
  const files: GeneratedFile[] = [];

  for (const enumDef of enums) {
    const service = enumToService.get(enumDef.name);
    const dirName = resolveDir(service);

    // Check baseline surface for representation and values
    const baselineEnum = ctx.apiSurface?.enums?.[enumDef.name];
    const baselineAlias = ctx.apiSurface?.typeAliases?.[enumDef.name];
    const lines: string[] = [];

    if (baselineEnum?.members) {
      // Generate TS `enum` using baseline member names and values directly
      lines.push(`export enum ${enumDef.name} {`);
      for (const [memberName, memberValue] of Object.entries(baselineEnum.members)) {
        const valueStr = typeof memberValue === 'string' ? `'${memberValue}'` : String(memberValue);
        lines.push(`  ${memberName} = ${valueStr},`);
      }
      lines.push('}');
    } else if (baselineAlias?.value) {
      // Use the exact baseline type alias value for guaranteed compat match
      lines.push(`export type ${enumDef.name} = ${baselineAlias.value};`);
    } else {
      // No baseline — generate string literal union from IR values
      const values = enumDef.values;
      lines.push(`export type ${enumDef.name} =`);
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        const valueStr = typeof v.value === 'string' ? `'${v.value}'` : String(v.value);
        if (v.description || v.deprecated) {
          const parts: string[] = [];
          if (v.description) parts.push(v.description);
          if (v.deprecated) parts.push('@deprecated');
          lines.push(...docComment(parts.join('\n'), 2));
        }
        const suffix = i === values.length - 1 ? ';' : '';
        lines.push(`  | ${valueStr}${suffix}`);
      }
    }

    files.push({
      path: `src/${dirName}/interfaces/${fileName(enumDef.name)}.interface.ts`,
      content: lines.join('\n'),
      skipIfExists: true,
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
