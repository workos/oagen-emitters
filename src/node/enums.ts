import type { Enum, EmitterContext, GeneratedFile, Model, Service } from '@workos/oagen';
import { collectFieldDependencies, toPascalCase, walkTypeRef } from '@workos/oagen';
import { fileName, resolveServiceDir, buildServiceNameMap } from './naming.js';
import { docComment, assignModelsToEmittableServices } from './utils.js';
import { isInlineEnum } from './type-map.js';
import { isNodeOwnedService, enumValueRemap, wireEnumName } from './options.js';
import { liveSurfaceConstEnumMembers, liveSurfaceInterfacePath } from './live-surface.js';
import { isEnumInScope } from '../shared/resolved-ops.js';

export function generateEnums(enums: Enum[], ctx: EmitterContext): GeneratedFile[] {
  if (enums.length === 0) return [];

  const enumToService = assignEnumsToServices(enums, ctx.spec.services, ctx.spec.models, ctx);
  const serviceNameMap = buildServiceNameMap(ctx.spec.services, ctx);
  const resolveDir = (irService: string | undefined) =>
    irService ? resolveServiceDir(serviceNameMap.get(irService) ?? irService) : 'common';
  const files: GeneratedFile[] = [];

  for (const enumDef of enums) {
    // Inlined enums get expanded at usage sites by `type-map`. No file needed.
    if (isInlineEnum(enumDef.name)) continue;

    const service = enumToService.get(enumDef.name);
    const dirName = resolveDir(service);

    const baselineEnum = ctx.apiSurface?.enums?.[enumDef.name];
    const baselineAlias = ctx.apiSurface?.typeAliases?.[enumDef.name];
    const generatedPath = `src/${dirName}/interfaces/${fileName(enumDef.name)}.interface.ts`;

    const baselineSourceFile =
      (baselineEnum as any)?.sourceFile ?? (baselineAlias as any)?.sourceFile ?? liveSurfaceInterfacePath(enumDef.name);
    if (dirName === 'common' && !baselineSourceFile && (ctx.outputDir || ctx.targetDir || ctx.apiSurface)) {
      continue;
    }
    // The declared-elsewhere skip must not fire for OWNED services: the
    // "elsewhere" is typically the very interface file the owned-service
    // regeneration is simultaneously overwriting (e.g. legacy enums declared
    // inline in organization-domain.interface.ts), so skipping here leaves
    // the names referenced by generated code but declared nowhere. Under
    // ownership the canonical per-service module is the source of truth —
    // emit it; the model emitter plans its import from the same path.
    const isOwnedEnumService = isNodeOwnedService(ctx, service, service ? serviceNameMap.get(service) : undefined);
    if (baselineSourceFile && baselineSourceFile !== generatedPath && !isOwnedEnumService) {
      continue;
    }

    const lines: string[] = [];
    let hasNewValues = false;

    // A configured wire→domain value remap (see NodeEmitterOptions.enumValueRemaps)
    // makes this the SDK-facing domain type: emit the mapped values (raw wire
    // values not in the map pass through). Alongside it we emit a wire companion
    // (`<Enum>Response`) carrying the raw wire values, so `*Response` interfaces
    // and the `deserialize<Enum>` mapper describe the untranslated wire shape
    // instead of lying about it as the domain type. The mapper itself is emitted
    // by the serializer pass. Bypasses baseline merging on purpose — the baseline
    // holds the previously mapped values, and re-merging would union both wire
    // and domain spellings.
    const remap = enumValueRemap(ctx, enumDef.name);

    if (remap) {
      const domainValues = [...new Set(enumDef.values.map((v) => remap[String(v.value)] ?? String(v.value)))];
      const wireValues = [...new Set(enumDef.values.map((v) => String(v.value)))];
      lines.push(`export type ${enumDef.name} =`);
      lines.push(domainValues.map((v) => `  | '${v}'`).join('\n') + ';');
      lines.push('');
      lines.push(`export type ${wireEnumName(enumDef.name)} =`);
      lines.push(wireValues.map((v) => `  | '${v}'`).join('\n') + ';');
      hasNewValues = true;
    } else if (baselineEnum?.members) {
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
      // No baseline form available — emit the workos-node house style:
      //
      //   export const X = { Member: 'value', ... } as const;
      //   export type X = (typeof X)[keyof typeof X];
      //
      // This dual declaration lets callers use either the type (`X`) or the
      // namespace (`X.Member`) without paying for a TypeScript `enum`'s
      // runtime overhead. Emitting only the type alias would compile but
      // break hand-written test files that import the enum as a value.
      //
      // Member name resolution, per value:
      //   1. If the live SDK already declares this enum as a const-object
      //      with a member for this exact value, reuse the existing member
      //      name. This preserves acronym casing (`DSync`, `SAML`, `JWT`)
      //      that the simpler `toPascalCase` would otherwise flatten.
      //   2. Otherwise PascalCase the value.
      //   3. Skip duplicate values and duplicate member names — the union
      //      type derived from the const captures every kept value.
      const values = enumDef.values;
      const existingMembers = liveSurfaceConstEnumMembers(enumDef.name);
      const seenMembers = new Set<string>();
      const seenValues = new Set<string>();
      lines.push(`export const ${enumDef.name} = {`);
      for (const v of values) {
        const valueKey = String(v.value);
        if (seenValues.has(valueKey)) continue;
        seenValues.add(valueKey);
        const memberName = existingMembers?.get(valueKey) ?? toPascalCase(valueKey);
        if (seenMembers.has(memberName)) continue;
        seenMembers.add(memberName);
        const valueStr = typeof v.value === 'string' ? `'${v.value}'` : String(v.value);
        if (v.description || v.deprecated) {
          const parts: string[] = [];
          if (v.description) parts.push(v.description);
          if (v.deprecated) parts.push('@deprecated');
          lines.push(...docComment(parts.join('\n'), 2));
        }
        lines.push(`  ${memberName}: ${valueStr},`);
      }
      lines.push(`} as const;`);
      lines.push('');
      lines.push(`export type ${enumDef.name} =`);
      lines.push(`  (typeof ${enumDef.name})[keyof typeof ${enumDef.name}];`);
    }

    if (isEnumInScope(enumDef.name, ctx)) {
      const path = `src/${dirName}/interfaces/${fileName(enumDef.name)}.interface.ts`;
      const content = lines.join('\n');
      // A remapped enum must overwrite the existing file so its values flip from
      // wire to domain on adoption (skipIfExists would leave the raw values).
      files.push(remap ? { path, content, overwriteExisting: true } : { path, content, skipIfExists: !hasNewValues });
    }
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

export function assignEnumsToServices(
  enums: Enum[],
  services: Service[],
  models: Model[] = [],
  ctx?: EmitterContext,
): Map<string, string> {
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

  if (models.length > 0) {
    // Use the emittable-services assignment (not the raw engine one) so an
    // enum referenced through a model that was re-homed into an owned
    // service directory follows the model — `generateEnums` emission and the
    // model's enum imports must agree on the directory.
    const modelToService = assignModelsToEmittableServices(models, services, ctx);
    for (const model of models) {
      const service = modelToService.get(model.name);
      if (!service) continue;

      for (const name of collectFieldDependencies(model).enums) {
        if (enumNames.has(name) && !enumToService.has(name)) {
          enumToService.set(name, service);
        }
      }
    }
  }

  // A shared enum that already has a canonical declaration under `src/common/`
  // must stay there. `common` is a shared module that owned-service
  // regeneration never overwrites, so it is always the source of truth for
  // these names. Without this, owning a service that references such an enum
  // would emit a SECOND copy into the owned module's `interfaces/` dir (via the
  // owned-service exception in `generateEnums`) while the `common` copy
  // remains, and `src/index.ts` re-exports both barrels — a duplicate
  // `export *` (TS2308). Unassigning the enum makes every consumer
  // (`generateEnums`, model imports, barrels) resolve it to `common`.
  if (ctx) {
    const serviceNameMap = buildServiceNameMap(services, ctx);
    const toUnassign: string[] = [];
    for (const [name, service] of enumToService) {
      if (!isNodeOwnedService(ctx, service, serviceNameMap.get(service))) continue;
      const home =
        (ctx.apiSurface?.enums?.[name] as any)?.sourceFile ??
        (ctx.apiSurface?.typeAliases?.[name] as any)?.sourceFile ??
        liveSurfaceInterfacePath(name);
      if (home && home.startsWith('src/common/')) toUnassign.push(name);
    }
    for (const name of toUnassign) enumToService.delete(name);
  }

  return enumToService;
}
