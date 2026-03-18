import type { Enum, EmitterContext, GeneratedFile, Service } from "@workos/oagen";
import { walkTypeRef } from "@workos/oagen";
import { fileName, serviceDirName } from "./naming.js";

export function generateEnums(enums: Enum[], ctx: EmitterContext): GeneratedFile[] {
  if (enums.length === 0) return [];

  const enumToService = assignEnumsToServices(enums, ctx.spec.services);
  const files: GeneratedFile[] = [];

  for (const enumDef of enums) {
    const service = enumToService.get(enumDef.name);
    const dirName = service ? serviceDirName(service) : "common";

    // Check baseline surface for representation and values
    const baselineEnum = ctx.apiSurface?.enums?.[enumDef.name];
    const baselineAlias = ctx.apiSurface?.typeAliases?.[enumDef.name];
    const lines: string[] = [];

    if (baselineEnum?.members) {
      // Generate TS `enum` using baseline member names and values directly
      lines.push(`export enum ${enumDef.name} {`);
      for (const [memberName, memberValue] of Object.entries(baselineEnum.members)) {
        const valueStr = typeof memberValue === "string" ? `'${memberValue}'` : String(memberValue);
        lines.push(`  ${memberName} = ${valueStr},`);
      }
      lines.push("}");
    } else if (baselineAlias?.value) {
      // Use the exact baseline type alias value for guaranteed compat match
      lines.push(`export type ${enumDef.name} = ${baselineAlias.value};`);
    } else {
      // No baseline — generate string literal union from IR values
      const values = enumDef.values;
      lines.push(`export type ${enumDef.name} =`);
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        const valueStr = typeof v.value === "string" ? `'${v.value}'` : String(v.value);
        if (v.description) {
          lines.push(`  /** ${v.description} */`);
        }
        const suffix = i === values.length - 1 ? ";" : "";
        lines.push(`  | ${valueStr}${suffix}`);
      }
    }

    files.push({
      path: `src/${dirName}/interfaces/${fileName(enumDef.name)}.interface.ts`,
      content: lines.join("\n"),
      skipIfExists: true,
    });
  }

  return files;
}

function assignEnumsToServices(enums: Enum[], services: Service[]): Map<string, string> {
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
      for (const p of [...op.pathParams, ...op.queryParams, ...op.headerParams]) {
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
