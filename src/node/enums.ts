import type { Enum, EmitterContext, GeneratedFile, Service } from '@workos/oagen';
import { toPascalCase, walkTypeRef } from '@workos/oagen';
import { fileName, resolveServiceDir, buildServiceNameMap } from './naming.js';
import { docComment } from './utils.js';

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

    const baselineEnum = ctx.apiSurface?.enums?.[enumDef.name];
    const baselineAlias = ctx.apiSurface?.typeAliases?.[enumDef.name];
    const generatedPath = `src/${dirName}/interfaces/${fileName(enumDef.name)}.interface.ts`;

    const baselineSourceFile = (baselineEnum as any)?.sourceFile ?? (baselineAlias as any)?.sourceFile;
    if (baselineSourceFile && baselineSourceFile !== generatedPath) {
      continue;
    }

    const lines: string[] = [];
    let hasNewValues = false;

    if (baselineEnum?.members) {
      const existingValues = new Set(Object.values(baselineEnum.members).map(String));
      const irValues = enumDef.values.map((v) => String(v.value));
      const missingValues = irValues.filter((v) => !existingValues.has(v));
      hasNewValues = missingValues.length > 0;

      lines.push(`export enum ${enumDef.name} {`);
      for (const [memberName, memberValue] of Object.entries(baselineEnum.members)) {
        const valueStr = typeof memberValue === 'string' ? `'${memberValue}'` : String(memberValue);
        lines.push(`  ${memberName} = ${valueStr},`);
      }
      for (const val of missingValues) {
        const memberName = toPascalCase(val);
        lines.push(`  ${memberName} = '${val}',`);
      }
      lines.push('}');
    } else if (baselineAlias?.value) {
      const baselineValues = extractLiteralUnionValues(baselineAlias.value);
      const irValues = enumDef.values.map((v) => String(v.value));
      const missing = irValues.filter((v) => !baselineValues.has(v));
      hasNewValues = missing.length > 0;
      if (missing.length > 0) {
        const allValues = [...baselineValues, ...missing];
        const parts = allValues.map((v) => `'${v}'`);
        lines.push(`export type ${enumDef.name} = ${parts.join(' | ')};`);
      } else {
        lines.push(`export type ${enumDef.name} = ${baselineAlias.value};`);
      }
    } else {
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
      skipIfExists: !hasNewValues,
    });
  }

  return files;
}

function extractLiteralUnionValues(aliasValue: string): Set<string> {
  const values = new Set<string>();
  const regex = /'([^']+)'/g;
  let match;
  while ((match = regex.exec(aliasValue)) !== null) {
    values.add(match[1]);
  }
  return values;
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
