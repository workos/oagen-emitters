import type { Model, EmitterContext, GeneratedFile, TypeRef, UnionType } from "@workos/oagen";
import {
  fieldName,
  wireFieldName,
  fileName,
  serviceDirName,
  resolveInterfaceName,
} from "./naming.js";
import { assignModelsToServices, relativeImport } from "./utils.js";

export function generateSerializers(models: Model[], ctx: EmitterContext): GeneratedFile[] {
  if (models.length === 0) return [];

  const modelToService = assignModelsToServices(models, ctx.spec.services);
  const files: GeneratedFile[] = [];

  for (const model of models) {
    const service = modelToService.get(model.name);
    const dirName = service ? serviceDirName(service) : "common";
    const domainName = resolveInterfaceName(model.name, ctx);
    const responseName = `${domainName}Response`;
    const serializerPath = `src/${dirName}/serializers/${fileName(model.name)}.serializer.ts`;

    // Find nested model refs that need their own serializer imports.
    // Only collect models that will actually be called in serialize/deserialize expressions
    // (direct model refs, array-of-model items, nullable-wrapped models, single-model-variant unions).
    const nestedModelRefs = new Set<string>();
    for (const field of model.fields) {
      for (const ref of collectSerializedModelRefs(field.type)) {
        if (ref !== model.name) nestedModelRefs.add(ref);
      }
    }

    const lines: string[] = [];

    // Import model interfaces
    const interfacePath = `src/${dirName}/interfaces/${fileName(model.name)}.interface.ts`;
    lines.push(
      `import type { ${domainName}, ${responseName} } from '${relativeImport(serializerPath, interfacePath)}';`,
    );

    // Import nested model deserializers/serializers
    for (const dep of nestedModelRefs) {
      const depService = modelToService.get(dep);
      const depDir = depService ? serviceDirName(depService) : "common";
      const depSerializerPath = `src/${depDir}/serializers/${fileName(dep)}.serializer.ts`;
      const depName = resolveInterfaceName(dep, ctx);
      const imports = [`deserialize${depName}`, `serialize${depName}`];
      lines.push(
        `import { ${imports.join(", ")} } from '${relativeImport(serializerPath, depSerializerPath)}';`,
      );
    }
    lines.push("");

    // Deserialize function (wire → domain) — deduplicate by camelCase name
    const seenDeserFields = new Set<string>();
    lines.push(`export const deserialize${domainName} = (`);
    lines.push(`  response: ${responseName},`);
    lines.push(`): ${domainName} => ({`);
    for (const field of model.fields) {
      const domain = fieldName(field.name);
      if (seenDeserFields.has(domain)) continue;
      seenDeserFields.add(domain);
      const wire = wireFieldName(field.name);
      const wireAccess = `response.${wire}`;
      const expr = deserializeExpression(field.type, wireAccess, ctx);
      // If the field is optional and the expression involves a function call,
      // wrap with a null check to avoid passing undefined to the deserializer
      if (!field.required && expr !== wireAccess && needsNullGuard(field.type)) {
        lines.push(`  ${domain}: ${wireAccess} != null ? ${expr} : undefined,`);
      } else if (field.required && expr === wireAccess) {
        // Required field with direct assignment — add fallback for cases where
        // the response interface makes the field optional (baseline override)
        const fallback = defaultForType(field.type);
        if (fallback) {
          lines.push(`  ${domain}: ${expr} ?? ${fallback},`);
        } else {
          lines.push(`  ${domain}: ${expr},`);
        }
      } else {
        lines.push(`  ${domain}: ${expr},`);
      }
    }
    lines.push("});");

    // Serialize function (domain → wire)
    lines.push("");
    lines.push(`export const serialize${domainName} = (`);
    lines.push(`  model: ${domainName},`);
    lines.push(`): ${responseName} => ({`);
    const seenSerFields = new Set<string>();
    for (const field of model.fields) {
      const wire = wireFieldName(field.name);
      if (seenSerFields.has(wire)) continue;
      seenSerFields.add(wire);
      const domain = fieldName(field.name);
      const domainAccess = `model.${domain}`;
      const expr = serializeExpression(field.type, domainAccess, ctx);
      // If the field is optional and the expression involves a function call,
      // wrap with a null check to avoid passing undefined to the serializer
      if (!field.required && expr !== domainAccess && needsNullGuard(field.type)) {
        lines.push(`  ${wire}: ${domainAccess} != null ? ${expr} : undefined,`);
      } else {
        lines.push(`  ${wire}: ${expr},`);
      }
    }
    lines.push("});");

    files.push({
      path: serializerPath,
      content: lines.join("\n"),
      skipIfExists: true,
    });
  }

  return files;
}

/**
 * Collect model names that will actually be called in serialize/deserialize expressions.
 * Unlike collectModelRefs (which walks all union variants), this only includes models
 * that the expression functions will actually invoke a serializer/deserializer for.
 */
function collectSerializedModelRefs(ref: TypeRef): string[] {
  switch (ref.kind) {
    case "model":
      return [ref.name];
    case "array":
      if (ref.items.kind === "model") return [ref.items.name];
      return collectSerializedModelRefs(ref.items);
    case "nullable":
      return collectSerializedModelRefs(ref.inner);
    case "union": {
      const models = uniqueModelVariants(ref);
      // Only if exactly one unique model variant — that's when we call its serializer
      if (models.length === 1) return models;
      return [];
    }
    case "map":
    case "primitive":
    case "literal":
    case "enum":
      return [];
  }
}

function deserializeExpression(ref: TypeRef, wireExpr: string, ctx: EmitterContext): string {
  switch (ref.kind) {
    case "primitive":
    case "literal":
    case "enum":
      return wireExpr;
    case "model": {
      const name = resolveInterfaceName(ref.name, ctx);
      return `deserialize${name}(${wireExpr})`;
    }
    case "array":
      if (ref.items.kind === "model") {
        const name = resolveInterfaceName(ref.items.name, ctx);
        return `${wireExpr}.map(deserialize${name})`;
      }
      return wireExpr;
    case "nullable": {
      const innerExpr = deserializeExpression(ref.inner, wireExpr, ctx);
      // If the inner type involves a function call (model or array-of-model),
      // wrap with a null check to avoid passing null to the deserializer
      if (innerExpr !== wireExpr) {
        return `${wireExpr} != null ? ${innerExpr} : null`;
      }
      return `${wireExpr} ?? null`;
    }
    case "union": {
      // If the union has exactly one unique model variant, deserialize using that model's deserializer
      const deserModelVariants = uniqueModelVariants(ref);
      if (deserModelVariants.length === 1) {
        const name = resolveInterfaceName(deserModelVariants[0], ctx);
        return `deserialize${name}(${wireExpr})`;
      }
      return wireExpr;
    }
    case "map":
      return wireExpr;
  }
}

function serializeExpression(ref: TypeRef, domainExpr: string, ctx: EmitterContext): string {
  switch (ref.kind) {
    case "primitive":
    case "literal":
    case "enum":
      return domainExpr;
    case "model": {
      const name = resolveInterfaceName(ref.name, ctx);
      return `serialize${name}(${domainExpr})`;
    }
    case "array":
      if (ref.items.kind === "model") {
        const name = resolveInterfaceName(ref.items.name, ctx);
        return `${domainExpr}.map(serialize${name})`;
      }
      return domainExpr;
    case "nullable": {
      const innerExpr = serializeExpression(ref.inner, domainExpr, ctx);
      // If the inner type involves a function call (model or array-of-model),
      // wrap with a null check to avoid passing null to the serializer
      if (innerExpr !== domainExpr) {
        return `${domainExpr} != null ? ${innerExpr} : null`;
      }
      return domainExpr;
    }
    case "union": {
      // If the union has exactly one unique model variant, serialize using that model's serializer
      const serModelVariants = uniqueModelVariants(ref);
      if (serModelVariants.length === 1) {
        const name = resolveInterfaceName(serModelVariants[0], ctx);
        return `serialize${name}(${domainExpr})`;
      }
      return domainExpr;
    }
    case "map":
      return domainExpr;
  }
}

/**
 * Extract unique model names from a union's variants.
 * Used to determine if a union can be deserialized/serialized as a single model.
 */
function uniqueModelVariants(ref: UnionType): string[] {
  const modelNames = new Set<string>();
  for (const v of ref.variants) {
    if (v.kind === "model") modelNames.add(v.name);
  }
  return [...modelNames];
}

/**
 * Check whether a TypeRef involves a model reference that would produce
 * a function call in serialization/deserialization. Used to determine
 * whether optional fields need a null guard wrapper.
 */
function needsNullGuard(ref: TypeRef): boolean {
  switch (ref.kind) {
    case "model":
      return true;
    case "array":
      return ref.items.kind === "model";
    case "nullable":
      return needsNullGuard(ref.inner);
    case "union":
      return uniqueModelVariants(ref).length === 1;
    default:
      return false;
  }
}

/**
 * Return a TypeScript default value expression for a type, used as a null
 * coalesce fallback when a required domain field may be optional in the
 * response interface (baseline override mismatch).
 */
function defaultForType(ref: TypeRef): string | null {
  switch (ref.kind) {
    case "map":
      return "{}";
    case "primitive":
      switch (ref.type) {
        case "boolean":
          return "false";
        case "string":
          return "''";
        case "integer":
        case "number":
          return "0";
        default:
          return null;
      }
    case "array":
      return "[]";
    default:
      return null;
  }
}
