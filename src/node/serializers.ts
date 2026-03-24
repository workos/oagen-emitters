import type { Model, EmitterContext, GeneratedFile, TypeRef, UnionType, PrimitiveType } from '@workos/oagen';
import { mapTypeRef as tsMapTypeRef } from './type-map.js';
import {
  fieldName,
  wireFieldName,
  fileName,
  serviceDirName,
  resolveInterfaceName,
  buildServiceNameMap,
  wireInterfaceName,
} from './naming.js';
import { assignModelsToServices, relativeImport, pruneUnusedImports } from './utils.js';

/**
 * Detect whether the existing SDK uses string (ISO 8601) representation for
 * date-time fields rather than Date objects.  When any baseline interface has
 * a date-time IR field typed as plain `string` (not `Date`), the entire SDK
 * is assumed to follow that convention and ALL generated serializers will skip
 * the `new Date()` / `.toISOString()` conversion — not just those for models
 * that have a baseline interface.
 */
function detectStringDateConvention(models: Model[], ctx: EmitterContext): boolean {
  if (!ctx.apiSurface?.interfaces) return false;
  for (const model of models) {
    const domainName = resolveInterfaceName(model.name, ctx);
    const baseline = ctx.apiSurface.interfaces[domainName];
    if (!baseline?.fields) continue;
    for (const field of model.fields) {
      if (!hasFormatConversion(field.type)) continue;
      const baselineField = baseline.fields[fieldName(field.name)];
      if (baselineField && !baselineField.type.includes('Date')) {
        return true; // Found a date-time field stored as string — convention is strings
      }
    }
  }
  return false;
}

/**
 * Render generic type parameter declarations for a model.
 * E.g., `<CustomAttributesType = Record<string, unknown>>`.
 * Returns empty string for non-generic models.
 */
function renderSerializerTypeParams(model: Model, ctx?: EmitterContext): { decl: string; usage: string } {
  if (model.typeParams?.length) {
    const params = model.typeParams.map((tp) => {
      const def = tp.default ? ` = ${tsMapTypeRef(tp.default)}` : '';
      return `${tp.name}${def}`;
    });
    const names = model.typeParams.map((tp) => tp.name);
    return { decl: `<${params.join(', ')}>`, usage: `<${names.join(', ')}>` };
  }
  // Fallback: check if the baseline interface is generic (hand-written generics
  // not captured in the IR).  Only apply if the baseline file path matches the
  // generated path — meaning the existing generic file will be preserved via
  // skipIfExists.  If paths differ, the interface is newly generated and non-generic.
  if (ctx?.apiSurface?.interfaces) {
    const domainName = resolveInterfaceName(model.name, ctx);
    const baseline = ctx.apiSurface.interfaces[domainName];
    if (baseline?.fields) {
      const baselineSourceFile = (baseline as any).sourceFile as string | undefined;
      const modelToService = assignModelsToServices(ctx.spec.models, ctx.spec.services);
      const serviceNameMap = buildServiceNameMap(ctx.spec.services, ctx);
      const sDir = modelToService.get(model.name);
      const resolvedDir = sDir ? serviceDirName(serviceNameMap.get(sDir) ?? sDir) : 'common';
      const generatedPath = `src/${resolvedDir}/interfaces/${fileName(model.name)}.interface.ts`;
      const pathMatches = !baselineSourceFile || baselineSourceFile === generatedPath;
      if (pathMatches && baselineAppearsGeneric(baseline.fields, ctx)) {
        return {
          decl: '<GenericType extends Record<string, unknown> = Record<string, unknown>>',
          usage: '<GenericType>',
        };
      }
    }
  }
  return { decl: '', usage: '' };
}

/** Built-in TypeScript types that don't indicate a generic type parameter. */
const SERIALIZER_BUILTINS = new Set([
  'Record',
  'Promise',
  'Array',
  'Map',
  'Set',
  'Date',
  'string',
  'number',
  'boolean',
  'void',
  'null',
  'undefined',
  'any',
  'never',
  'unknown',
  'true',
  'false',
]);

/**
 * Check if a baseline interface appears to be generic by looking for
 * PascalCase type names in field types that aren't known models/enums/builtins.
 */
function baselineAppearsGeneric(fields: Record<string, unknown>, ctx: EmitterContext): boolean {
  const knownNames = new Set<string>();
  for (const m of ctx.spec.models) knownNames.add(resolveInterfaceName(m.name, ctx));
  for (const e of ctx.spec.enums) knownNames.add(e.name);
  // Include all baseline interface/enum/typeAlias names
  if (ctx.apiSurface?.interfaces) {
    for (const name of Object.keys(ctx.apiSurface.interfaces)) knownNames.add(name);
  }
  if (ctx.apiSurface?.typeAliases) {
    for (const name of Object.keys(ctx.apiSurface.typeAliases)) knownNames.add(name);
  }
  if (ctx.apiSurface?.enums) {
    for (const name of Object.keys(ctx.apiSurface.enums)) knownNames.add(name);
  }
  for (const [, bf] of Object.entries(fields)) {
    const fieldType = (bf as { type: string }).type;
    const typeNames = fieldType.match(/\b[A-Z][a-zA-Z0-9]*\b/g);
    if (!typeNames) continue;
    for (const tn of typeNames) {
      if (SERIALIZER_BUILTINS.has(tn)) continue;
      if (knownNames.has(tn)) continue;
      return true;
    }
  }
  return false;
}

export function generateSerializers(models: Model[], ctx: EmitterContext): GeneratedFile[] {
  if (models.length === 0) return [];

  const modelToService = assignModelsToServices(models, ctx.spec.services);
  const serviceNameMap = buildServiceNameMap(ctx.spec.services, ctx);
  const resolveDir = (irService: string | undefined) =>
    irService ? serviceDirName(serviceNameMap.get(irService) ?? irService) : 'common';
  const useStringDates = detectStringDateConvention(models, ctx);
  const files: GeneratedFile[] = [];

  for (const model of models) {
    const service = modelToService.get(model.name);
    const dirName = resolveDir(service);
    const domainName = resolveInterfaceName(model.name, ctx);
    const responseName = wireInterfaceName(domainName);
    const serializerPath = `src/${dirName}/serializers/${fileName(model.name)}.serializer.ts`;
    const typeParams = renderSerializerTypeParams(model, ctx);

    // Build a set of field names where format conversion (new Date / BigInt) should
    // be skipped.  When the SDK-wide convention is string dates, ALL date-time fields
    // in ALL models skip conversion — not just those with a baseline interface.
    const skipFormatFields = new Set<string>();
    const baselineDomain = ctx.apiSurface?.interfaces?.[domainName];
    if (useStringDates) {
      // Global convention: skip date-time conversion for every date field
      for (const field of model.fields) {
        if (hasDateTimeConversion(field.type)) {
          skipFormatFields.add(field.name);
        }
      }
    }
    if (baselineDomain) {
      // Per-field baseline check: also skip any other format conversions
      // (e.g., int64 → BigInt) when the baseline uses a simpler type
      for (const field of model.fields) {
        if (skipFormatFields.has(field.name)) continue;
        const baselineField = baselineDomain.fields?.[fieldName(field.name)];
        if (baselineField && !baselineField.type.includes('Date') && hasFormatConversion(field.type)) {
          skipFormatFields.add(field.name);
        }
      }
    }

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

    // Import nested model deserializers/serializers as separate statements.
    // Splitting ensures the merger's identifier-level filter can drop unused
    // imports independently (e.g., keeping only serialize* when deserialize*
    // already exists in the file from a prior import).
    for (const dep of nestedModelRefs) {
      const depService = modelToService.get(dep);
      const depDir = resolveDir(depService);
      const depSerializerPath = `src/${depDir}/serializers/${fileName(dep)}.serializer.ts`;
      const depName = resolveInterfaceName(dep, ctx);
      const rel = relativeImport(serializerPath, depSerializerPath);
      lines.push(`import { deserialize${depName} } from '${rel}';`);
      lines.push(`import { serialize${depName} } from '${rel}';`);
    }
    lines.push('');

    // Deserialize function (wire → domain) — deduplicate by camelCase name
    const seenDeserFields = new Set<string>();
    // Prefix param with _ when model has no fields to avoid unused-param warnings
    const deserParamPrefix = model.fields.length === 0 ? '_' : '';
    lines.push(`export const deserialize${domainName} = ${typeParams.decl}(`);
    lines.push(`  ${deserParamPrefix}response: ${responseName}${typeParams.usage},`);
    lines.push(`): ${domainName}${typeParams.usage} => ({`);
    for (const field of model.fields) {
      const domain = fieldName(field.name);
      if (seenDeserFields.has(domain)) continue;
      seenDeserFields.add(domain);
      const wire = wireFieldName(field.name);
      const wireAccess = `response.${wire}`;
      const skip = skipFormatFields.has(field.name);
      const expr = skip ? wireAccess : deserializeExpression(field.type, wireAccess, ctx);
      // Treat new fields (not in baseline) as effectively optional: the merger
      // can deep-merge them into existing interfaces but cannot update existing
      // deserializer bodies, so the wire response may not contain them.
      const isNewField = baselineDomain && !baselineDomain.fields?.[domain];
      const effectivelyOptional = !field.required || isNewField;
      // If the field is optional and the expression involves a function call,
      // wrap with a null check to avoid passing undefined to the deserializer
      if (effectivelyOptional && expr !== wireAccess && needsNullGuard(field.type)) {
        // If the expression already starts with a null guard from nullable handling,
        // don't wrap it again — just replace the inner null fallback with undefined
        if (expr.startsWith(`${wireAccess} != null ?`)) {
          lines.push(`  ${domain}: ${expr.replace(/: null$/, ': undefined')},`);
        } else {
          lines.push(`  ${domain}: ${wireAccess} != null ? ${expr} : undefined,`);
        }
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
    // NOTE: Previously we added passthrough assignments for baseline-required fields
    // missing from the IR model.  This was removed because it creates type errors:
    // the serializer would output fields that don't exist on the generated interface
    // (e.g., Connection.type, AuditLogSchema.createdAt).  If a baseline field is
    // truly needed, the merger will preserve the existing serializer for that field.
    lines.push('});');

    // Serialize function (domain → wire)
    const serParamPrefix = model.fields.length === 0 ? '_' : '';
    lines.push('');
    lines.push(`export const serialize${domainName} = ${typeParams.decl}(`);
    lines.push(`  ${serParamPrefix}model: ${domainName}${typeParams.usage},`);
    lines.push(`) => ({`);
    const seenSerFields = new Set<string>();
    for (const field of model.fields) {
      const wire = wireFieldName(field.name);
      if (seenSerFields.has(wire)) continue;
      seenSerFields.add(wire);
      const domain = fieldName(field.name);
      const domainAccess = `model.${domain}`;
      const skip = skipFormatFields.has(field.name);
      const expr = skip ? domainAccess : serializeExpression(field.type, domainAccess, ctx);
      // Treat new fields (not in baseline) as effectively optional — see deserializer comment above.
      const isNewSerField = baselineDomain && !baselineDomain.fields?.[domain];
      const effectivelyOptionalSer = !field.required || isNewSerField;
      // If the expression involves a function call (nested model/array serializer),
      // wrap with a null check to prevent crashes when tests pass `{} as any`.
      // This applies to both optional and required fields in the serialize direction,
      // since serialize is called with user-provided data that may be incomplete.
      if (expr !== domainAccess && needsNullGuard(field.type)) {
        const fallback = effectivelyOptionalSer ? 'undefined' : 'undefined';
        // If the expression already starts with a null guard from nullable handling,
        // don't wrap it again — just replace the inner null fallback with undefined
        if (expr.startsWith(`${domainAccess} != null ?`)) {
          lines.push(`  ${wire}: ${expr.replace(/: null$/, ': undefined')},`);
        } else {
          lines.push(`  ${wire}: ${domainAccess} != null ? ${expr} : ${fallback},`);
        }
      } else {
        lines.push(`  ${wire}: ${expr},`);
      }
    }
    lines.push('});');

    files.push({
      path: serializerPath,
      content: pruneUnusedImports(lines).join('\n'),
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
    case 'model':
      return [ref.name];
    case 'array':
      if (ref.items.kind === 'model') return [ref.items.name];
      return collectSerializedModelRefs(ref.items);
    case 'nullable':
      return collectSerializedModelRefs(ref.inner);
    case 'union': {
      const models = uniqueModelVariants(ref);
      // Discriminated unions and allOf unions need serializers for all model variants
      if (ref.discriminator && models.length > 0) return models;
      if (ref.compositionKind === 'allOf' && models.length > 0) return models;
      // Only if exactly one unique model variant — that's when we call its serializer
      if (models.length === 1) return models;
      return [];
    }
    case 'map':
    case 'primitive':
    case 'literal':
    case 'enum':
      return [];
  }
}

function deserializeExpression(ref: TypeRef, wireExpr: string, ctx: EmitterContext): string {
  switch (ref.kind) {
    case 'primitive':
      return deserializePrimitive(ref, wireExpr);
    case 'literal':
    case 'enum':
      return wireExpr;
    case 'model': {
      const name = resolveInterfaceName(ref.name, ctx);
      return `deserialize${name}(${wireExpr})`;
    }
    case 'array':
      if (ref.items.kind === 'model') {
        const name = resolveInterfaceName(ref.items.name, ctx);
        return `${wireExpr}.map(deserialize${name})`;
      }
      return wireExpr;
    case 'nullable': {
      const innerExpr = deserializeExpression(ref.inner, wireExpr, ctx);
      // If the inner type involves a function call (model or array-of-model),
      // wrap with a null check to avoid passing null to the deserializer
      if (innerExpr !== wireExpr) {
        return `${wireExpr} != null ? ${innerExpr} : null`;
      }
      return `${wireExpr} ?? null`;
    }
    case 'union': {
      // Discriminated union: switch on the discriminator property
      if (ref.discriminator) {
        return renderDiscriminatorSwitch(ref, wireExpr, 'deserialize', ctx);
      }
      // allOf union: merge all model variant fields via spread
      if (ref.compositionKind === 'allOf') {
        return renderAllOfMerge(ref, wireExpr, 'deserialize', ctx);
      }
      // If the union has exactly one unique model variant, deserialize using that model's deserializer
      const deserModelVariants = uniqueModelVariants(ref);
      if (deserModelVariants.length === 1) {
        const name = resolveInterfaceName(deserModelVariants[0], ctx);
        return `deserialize${name}(${wireExpr})`;
      }
      return wireExpr;
    }
    case 'map':
      return wireExpr;
  }
}

function serializeExpression(ref: TypeRef, domainExpr: string, ctx: EmitterContext): string {
  switch (ref.kind) {
    case 'primitive':
      return serializePrimitive(ref, domainExpr);
    case 'literal':
    case 'enum':
      return domainExpr;
    case 'model': {
      const name = resolveInterfaceName(ref.name, ctx);
      return `serialize${name}(${domainExpr})`;
    }
    case 'array':
      if (ref.items.kind === 'model') {
        const name = resolveInterfaceName(ref.items.name, ctx);
        return `${domainExpr}.map(serialize${name})`;
      }
      return domainExpr;
    case 'nullable': {
      const innerExpr = serializeExpression(ref.inner, domainExpr, ctx);
      // If the inner type involves a function call (model or array-of-model),
      // wrap with a null check to avoid passing null to the serializer
      if (innerExpr !== domainExpr) {
        return `${domainExpr} != null ? ${innerExpr} : null`;
      }
      return domainExpr;
    }
    case 'union': {
      // Discriminated union: switch on the discriminator property
      if (ref.discriminator) {
        return renderDiscriminatorSwitch(ref, domainExpr, 'serialize', ctx);
      }
      // allOf union: merge all model variant fields via spread
      if (ref.compositionKind === 'allOf') {
        return renderAllOfMerge(ref, domainExpr, 'serialize', ctx);
      }
      // If the union has exactly one unique model variant, serialize using that model's serializer
      const serModelVariants = uniqueModelVariants(ref);
      if (serModelVariants.length === 1) {
        const name = resolveInterfaceName(serModelVariants[0], ctx);
        return `serialize${name}(${domainExpr})`;
      }
      return domainExpr;
    }
    case 'map':
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
    if (v.kind === 'model') modelNames.add(v.name);
  }
  return [...modelNames];
}

/**
 * Check whether a TypeRef involves a model reference or format conversion
 * that would produce a function call in serialization/deserialization.
 * Used to determine whether optional fields need a null guard wrapper.
 */
function needsNullGuard(ref: TypeRef): boolean {
  switch (ref.kind) {
    case 'model':
      return true;
    case 'primitive':
      return hasFormatConversion(ref);
    case 'array':
      return ref.items.kind === 'model';
    case 'nullable':
      return needsNullGuard(ref.inner);
    case 'union':
      if (ref.discriminator) return true;
      if (ref.compositionKind === 'allOf' && uniqueModelVariants(ref).length > 0) return true;
      return uniqueModelVariants(ref).length === 1;
    default:
      return false;
  }
}

/** Check if a type has a format that requires conversion. */
function hasFormatConversion(ref: TypeRef): boolean {
  switch (ref.kind) {
    case 'primitive':
      return ref.format === 'date-time' || ref.format === 'int64';
    case 'nullable':
      return hasFormatConversion(ref.inner);
    default:
      return false;
  }
}

/** Check if a type specifically has a date-time format conversion. */
function hasDateTimeConversion(ref: TypeRef): boolean {
  switch (ref.kind) {
    case 'primitive':
      return ref.format === 'date-time';
    case 'nullable':
      return hasDateTimeConversion(ref.inner);
    default:
      return false;
  }
}

/** Deserialize a primitive value, applying format conversions when needed. */
function deserializePrimitive(ref: PrimitiveType, wireExpr: string): string {
  if (ref.format === 'date-time') return `new Date(${wireExpr})`;
  if (ref.format === 'int64') return `BigInt(${wireExpr})`;
  return wireExpr;
}

/** Serialize a primitive value, applying format conversions when needed. */
function serializePrimitive(ref: PrimitiveType, domainExpr: string): string {
  if (ref.format === 'date-time') return `${domainExpr}.toISOString()`;
  if (ref.format === 'int64') return `String(${domainExpr})`;
  return domainExpr;
}

/**
 * Render a discriminated union switch expression.
 * Produces an IIFE that switches on the discriminator property and calls
 * the appropriate serializer/deserializer for each mapped model.
 */
function renderDiscriminatorSwitch(
  ref: UnionType,
  expr: string,
  direction: 'deserialize' | 'serialize',
  ctx: EmitterContext,
): string {
  const disc = ref.discriminator!;
  const cases: string[] = [];
  for (const [value, modelName] of Object.entries(disc.mapping)) {
    const resolved = resolveInterfaceName(modelName, ctx);
    const fn = `${direction}${resolved}`;
    cases.push(`case '${value}': return ${fn}(${expr} as any)`);
  }
  return `(() => { switch ((${expr} as any).${disc.property}) { ${cases.join('; ')}; default: return ${expr} } })()`;
}

/**
 * Render an allOf merge expression.
 * Spreads the serialized/deserialized result of each model variant.
 */
function renderAllOfMerge(
  ref: UnionType,
  expr: string,
  direction: 'deserialize' | 'serialize',
  ctx: EmitterContext,
): string {
  const models = uniqueModelVariants(ref);
  if (models.length === 0) return expr;
  const spreads = models.map((name) => {
    const resolved = resolveInterfaceName(name, ctx);
    return `...${direction}${resolved}(${expr} as any)`;
  });
  return `({ ${spreads.join(', ')} })`;
}

/**
 * Return a TypeScript default value expression for a type, used as a null
 * coalesce fallback when a required domain field may be optional in the
 * response interface (baseline override mismatch).
 */
function defaultForType(ref: TypeRef): string | null {
  switch (ref.kind) {
    case 'literal':
      // Use the literal value itself as the fallback (e.g., 'role' for object: 'role')
      return typeof ref.value === 'string' ? `'${ref.value}'` : String(ref.value);
    case 'enum':
      // Use the first enum value as a safe fallback when the response may omit the field
      if (ref.values && ref.values.length > 0) {
        const first = ref.values[0];
        return typeof first === 'string' ? `'${first}'` : String(first);
      }
      return null;
    case 'map':
      return '{}';
    case 'primitive':
      switch (ref.type) {
        case 'boolean':
          return 'false';
        case 'string':
          return "''";
        case 'integer':
        case 'number':
          return '0';
        default:
          return null;
      }
    case 'array':
      return '[]';
    default:
      return null;
  }
}
