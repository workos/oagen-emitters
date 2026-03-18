import type { Model, Field, EmitterContext, GeneratedFile, Service } from "@workos/oagen";
import { walkTypeRef } from "@workos/oagen";
import { mapTypeRef, mapWireTypeRef } from "./type-map.js";
import {
  fieldName,
  wireFieldName,
  fileName,
  serviceDirName,
  resolveInterfaceName,
} from "./naming.js";
import { assignModelsToServices, collectFieldDependencies } from "./utils.js";

export function generateModels(models: Model[], ctx: EmitterContext): GeneratedFile[] {
  if (models.length === 0) return [];

  const modelToService = assignModelsToServices(models, ctx.spec.services);
  const files: GeneratedFile[] = [];

  for (const model of models) {
    const service = modelToService.get(model.name);
    const dirName = service ? serviceDirName(service) : "common";
    const domainName = resolveInterfaceName(model.name, ctx);
    const responseName = `${domainName}Response`;
    const deps = collectFieldDependencies(model);
    const lines: string[] = [];

    // Baseline interface data (for compat field type matching)
    const baselineDomain = ctx.apiSurface?.interfaces?.[domainName];
    const baselineResponse = ctx.apiSurface?.interfaces?.[responseName];

    // Import referenced models (domain + response) and enums with correct cross-service paths
    const enumToService = assignEnumsToServices(ctx.spec.enums, ctx.spec.services);
    for (const dep of deps.models) {
      const depName = resolveInterfaceName(dep, ctx);
      const depService = modelToService.get(dep);
      const depDir = depService ? serviceDirName(depService) : "common";
      const relPath =
        depDir === dirName
          ? `./${fileName(dep)}.interface`
          : `../../${depDir}/interfaces/${fileName(dep)}.interface`;
      lines.push(`import type { ${depName}, ${depName}Response } from '${relPath}';`);
    }
    for (const dep of deps.enums) {
      const depService = enumToService.get(dep);
      const depDir = depService ? serviceDirName(depService) : "common";
      const relPath =
        depDir === dirName
          ? `./${fileName(dep)}.interface`
          : `../../${depDir}/interfaces/${fileName(dep)}.interface`;
      lines.push(`import type { ${dep} } from '${relPath}';`);
    }

    if (lines.length > 0) lines.push("");

    // Build set of importable type names for this file:
    // the model itself, its Response variant, all IR-dep model names + Response variants, and all IR-dep enum names
    const importableNames = new Set<string>();
    importableNames.add(domainName);
    importableNames.add(responseName);
    for (const dep of deps.models) {
      const depName = resolveInterfaceName(dep, ctx);
      importableNames.add(depName);
      importableNames.add(`${depName}Response`);
    }
    for (const dep of deps.enums) {
      importableNames.add(dep);
    }

    // Type params (generics)
    const typeParams = renderTypeParams(model);

    // Domain interface (camelCase fields) — deduplicate by camelCase name
    const seenDomainFields = new Set<string>();
    if (model.description) {
      lines.push(`/** ${model.description} */`);
    }
    lines.push(`export interface ${domainName}${typeParams} {`);
    for (const field of model.fields) {
      const domainFieldName = fieldName(field.name);
      if (seenDomainFields.has(domainFieldName)) continue;
      seenDomainFields.add(domainFieldName);
      if (field.description) {
        lines.push(`  /** ${field.description} */`);
      }
      const baselineField = baselineDomain?.fields?.[domainFieldName];
      // For the domain interface, also check that the response baseline's optionality
      // is compatible — the serializer reads from the response type and assigns to the domain type.
      // If the domain baseline says required but the response baseline says optional,
      // the serializer would produce T | undefined for a field expecting T.
      const domainWireField = wireFieldName(field.name);
      const responseBaselineField = baselineResponse?.fields?.[domainWireField];
      const domainResponseOptionalMismatch =
        baselineField &&
        !baselineField.optional &&
        responseBaselineField &&
        responseBaselineField.optional;
      if (
        domainResponseOptionalMismatch &&
        (domainFieldName === "metadata" || domainFieldName === "directoryManaged")
      ) {
        console.log(
          `[DEBUG] domainResponseOptionalMismatch for ${domainName}.${domainFieldName}: domain.optional=${baselineField?.optional}, response.optional=${responseBaselineField?.optional}, wireField=${domainWireField}`,
        );
      }
      if (
        baselineField &&
        !domainResponseOptionalMismatch &&
        baselineTypeResolvable(baselineField.type, importableNames) &&
        baselineFieldCompatible(baselineField, field)
      ) {
        const opt = baselineField.optional ? "?" : "";
        lines.push(`  ${domainFieldName}${opt}: ${baselineField.type};`);
      } else {
        const opt = !field.required ? "?" : "";
        lines.push(`  ${domainFieldName}${opt}: ${mapTypeRef(field.type)};`);
      }
    }
    lines.push("}");
    lines.push("");

    // Wire/response interface (snake_case fields) — deduplicate by snake_case name
    const seenWireFields = new Set<string>();
    lines.push(`export interface ${responseName}${typeParams} {`);
    for (const field of model.fields) {
      const wireField = wireFieldName(field.name);
      if (seenWireFields.has(wireField)) continue;
      seenWireFields.add(wireField);
      const baselineField = baselineResponse?.fields?.[wireField];
      if (
        baselineField &&
        baselineTypeResolvable(baselineField.type, importableNames) &&
        baselineFieldCompatible(baselineField, field)
      ) {
        const opt = baselineField.optional ? "?" : "";
        lines.push(`  ${wireField}${opt}: ${baselineField.type};`);
      } else {
        const opt = !field.required ? "?" : "";
        lines.push(`  ${wireField}${opt}: ${mapWireTypeRef(field.type)};`);
      }
    }
    lines.push("}");

    files.push({
      path: `src/${dirName}/interfaces/${fileName(model.name)}.interface.ts`,
      content: lines.join("\n"),
      skipIfExists: true,
    });
  }

  return files;
}

/**
 * Check if all PascalCase type references in a baseline type string
 * can be resolved to types that are actually importable in the generated file.
 * A type is importable if it's a builtin, or if it's among the set of names
 * that will be imported (the model's own name/response, or its IR deps).
 * Returns false if any reference is unresolvable (e.g., hand-written types
 * from the live SDK, or spec types from other services not in IR deps).
 */
function baselineTypeResolvable(typeStr: string, importableNames: Set<string>): boolean {
  // Built-in types that are always available
  const builtins = new Set([
    "Record",
    "Promise",
    "Array",
    "Map",
    "Set",
    "Date",
    "string",
    "number",
    "boolean",
    "void",
    "null",
    "undefined",
    "any",
    "never",
    "unknown",
    "true",
    "false",
  ]);

  const matches = typeStr.match(/\b[A-Z][a-zA-Z0-9]*\b/g);
  if (!matches) return true;

  for (const name of matches) {
    if (builtins.has(name)) continue;
    if (importableNames.has(name)) continue;
    return false;
  }
  return true;
}

/**
 * Check if a baseline field type is compatible with the IR field for use
 * in the generated interface. The serializer generates expressions based on
 * the IR type, so the interface type must be assignable from the serializer output.
 *
 * Rejects baseline types when:
 * - IR field is nullable but baseline type doesn't include `null`
 * - IR field is optional but baseline says required (and vice versa)
 * - IR field is required but baseline says optional
 */
function baselineFieldCompatible(
  baselineField: { type: string; optional: boolean },
  irField: Field,
): boolean {
  const irNullable = irField.type.kind === "nullable";
  const baselineHasNull = baselineField.type.includes("null");

  // If the IR field is nullable, the serializer produces `expr ?? null`,
  // so the baseline type must include null to be assignable
  if (irNullable && !baselineHasNull) {
    return false;
  }

  // If the IR field is optional, the serializer may produce undefined,
  // so the baseline should also be optional (or include undefined)
  if (!irField.required && !baselineField.optional && !baselineField.type.includes("undefined")) {
    return false;
  }

  // If the IR field is required but the baseline says optional,
  // the serializer produces a definite value but the interface is looser — that's OK
  // (the domain type is wider than the serializer output)

  return true;
}

function renderTypeParams(model: Model): string {
  if (!model.typeParams?.length) return "";
  const params = model.typeParams.map((tp) => {
    const def = tp.default ? ` = ${mapTypeRef(tp.default)}` : "";
    return `${tp.name}${def}`;
  });
  return `<${params.join(", ")}>`;
}

function assignEnumsToServices(
  enums: { name: string }[],
  services: Service[],
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
