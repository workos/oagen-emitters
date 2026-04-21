import type { Model, Field, EmitterContext, TypeRef, UnionType, PrimitiveType } from '@workos/oagen';
import { mapTypeRef as tsMapTypeRef } from './type-map.js';
import { fieldName, wireFieldName, fileName, resolveInterfaceName, wireInterfaceName } from './naming.js';
import { relativeImport, buildKnownTypeNames, isBaselineGeneric, createServiceDirResolver } from './utils.js';

// ---------------------------------------------------------------------------
// Guard strategy — determines how a field assignment is wrapped
// ---------------------------------------------------------------------------

type GuardStrategy =
  | { kind: 'direct' }
  | { kind: 'null-check'; fallback: string }
  | { kind: 'coalesce'; fallback: string }
  | { kind: 'non-null-assert' };

// ---------------------------------------------------------------------------
// Baseline types used by planning functions
// ---------------------------------------------------------------------------

interface BaselineFieldInfo {
  type: string;
  optional: boolean;
}

interface BaselineInterface {
  fields?: Record<string, BaselineFieldInfo>;
  sourceFile?: string;
}

// ---------------------------------------------------------------------------
// Expression builders
// ---------------------------------------------------------------------------

/**
 * Build a deserialization expression for a type reference.
 * @param nullFallback - fallback value for nullable inner expressions (default 'null')
 */
export function deserializeExpression(
  ref: TypeRef,
  wireExpr: string,
  ctx: EmitterContext,
  nullFallback = 'null',
): string {
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
      const innerExpr = deserializeExpression(ref.inner, wireExpr, ctx, nullFallback);
      if (innerExpr !== wireExpr) {
        return `${wireExpr} != null ? ${innerExpr} : ${nullFallback}`;
      }
      return `${wireExpr} ?? ${nullFallback}`;
    }
    case 'union': {
      if (ref.discriminator) {
        return renderDiscriminatorSwitch(ref, wireExpr, 'deserialize', ctx);
      }
      if (ref.compositionKind === 'allOf') {
        return renderAllOfMerge(ref, wireExpr, 'deserialize', ctx);
      }
      const models = uniqueModelVariants(ref);
      if (models.length === 1) {
        const name = resolveInterfaceName(models[0], ctx);
        return `deserialize${name}(${wireExpr})`;
      }
      return wireExpr;
    }
    case 'map':
      return wireExpr;
  }
}

/**
 * Build a serialization expression for a type reference.
 * @param nullFallback - fallback value for nullable inner expressions (default 'null')
 */
export function serializeExpression(
  ref: TypeRef,
  domainExpr: string,
  ctx: EmitterContext,
  nullFallback = 'null',
): string {
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
      const innerExpr = serializeExpression(ref.inner, domainExpr, ctx, nullFallback);
      if (innerExpr !== domainExpr) {
        return `${domainExpr} != null ? ${innerExpr} : ${nullFallback}`;
      }
      return domainExpr;
    }
    case 'union': {
      if (ref.discriminator) {
        return renderDiscriminatorSwitch(ref, domainExpr, 'serialize', ctx);
      }
      if (ref.compositionKind === 'allOf') {
        return renderAllOfMerge(ref, domainExpr, 'serialize', ctx);
      }
      const models = uniqueModelVariants(ref);
      if (models.length === 1) {
        const name = resolveInterfaceName(models[0], ctx);
        return `serialize${name}(${domainExpr})`;
      }
      return domainExpr;
    }
    case 'map':
      return domainExpr;
  }
}

// ---------------------------------------------------------------------------
// Primitive format conversions
// ---------------------------------------------------------------------------

function deserializePrimitive(ref: PrimitiveType, wireExpr: string): string {
  if (ref.format === 'date-time') return `new Date(${wireExpr})`;
  if (ref.format === 'int64') return `BigInt(${wireExpr})`;
  return wireExpr;
}

function serializePrimitive(ref: PrimitiveType, domainExpr: string): string {
  if (ref.format === 'date-time') return `${domainExpr}.toISOString()`;
  if (ref.format === 'int64') return `String(${domainExpr})`;
  return domainExpr;
}

// ---------------------------------------------------------------------------
// Union helpers
// ---------------------------------------------------------------------------

/** Extract unique model names from a union's variants. */
export function uniqueModelVariants(ref: UnionType): string[] {
  const modelNames = new Set<string>();
  for (const v of ref.variants) {
    if (v.kind === 'model') modelNames.add(v.name);
  }
  return [...modelNames];
}

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

// ---------------------------------------------------------------------------
// Type inspection helpers
// ---------------------------------------------------------------------------

/** Check whether a TypeRef involves a function call in serialization. */
export function needsNullGuard(ref: TypeRef): boolean {
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

export function hasFormatConversion(ref: TypeRef): boolean {
  switch (ref.kind) {
    case 'primitive':
      return ref.format === 'date-time' || ref.format === 'int64';
    case 'nullable':
      return hasFormatConversion(ref.inner);
    default:
      return false;
  }
}

export function hasDateTimeConversion(ref: TypeRef): boolean {
  switch (ref.kind) {
    case 'primitive':
      return ref.format === 'date-time';
    case 'nullable':
      return hasDateTimeConversion(ref.inner);
    default:
      return false;
  }
}

/**
 * Collect model names that will actually be called in serialize/deserialize expressions.
 * Unlike collectModelRefs (which walks all union variants), this only includes models
 * that the expression functions will actually invoke a serializer/deserializer for.
 */
export function collectSerializedModelRefs(ref: TypeRef): string[] {
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
      if (ref.discriminator && models.length > 0) return models;
      if (ref.compositionKind === 'allOf' && models.length > 0) return models;
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

/** Return a TypeScript default value expression for a type. */
export function defaultForType(ref: TypeRef): string | null {
  switch (ref.kind) {
    case 'literal':
      return typeof ref.value === 'string' ? `'${ref.value}'` : String(ref.value);
    case 'enum':
      return null;
    case 'map':
      return '{}';
    case 'nullable':
      return 'null';
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

// ---------------------------------------------------------------------------
// Serializer type params
// ---------------------------------------------------------------------------

export function renderSerializerTypeParams(model: Model, ctx?: EmitterContext): { decl: string; usage: string } {
  if (model.typeParams?.length) {
    const params = model.typeParams.map((tp) => {
      const def = tp.default ? ` = ${tsMapTypeRef(tp.default)}` : '';
      return `${tp.name}${def}`;
    });
    const names = model.typeParams.map((tp) => tp.name);
    return { decl: `<${params.join(', ')}>`, usage: `<${names.join(', ')}>` };
  }
  if (ctx?.apiSurface?.interfaces) {
    const domainName = resolveInterfaceName(model.name, ctx);
    const baseline = ctx.apiSurface.interfaces[domainName];
    if (baseline?.fields) {
      const baselineSourceFile = (baseline as any).sourceFile as string | undefined;
      const { modelToService, resolveDir } = createServiceDirResolver(ctx.spec.models, ctx.spec.services, ctx);
      const generatedPath = `src/${resolveDir(modelToService.get(model.name))}/interfaces/${fileName(model.name)}.interface.ts`;
      const pathMatches = !baselineSourceFile || baselineSourceFile === generatedPath;
      const knownNames = buildKnownTypeNames(ctx.spec.models, ctx);
      if (pathMatches && isBaselineGeneric(baseline.fields, knownNames)) {
        return {
          decl: '<GenericType extends Record<string, unknown> = Record<string, unknown>>',
          usage: '<GenericType>',
        };
      }
    }
  }
  return { decl: '', usage: '' };
}

// ---------------------------------------------------------------------------
// Baseline incompatibility detection
// ---------------------------------------------------------------------------

export function serializerHasBaselineIncompatibility(
  model: Model,
  baselineResponse: BaselineInterface | undefined,
  baselineDomain?: BaselineInterface,
  ctx?: EmitterContext,
): boolean {
  if (!baselineResponse?.fields) return false;

  const irWireFields = new Set<string>();
  const irDomainFields = new Set<string>();
  for (const field of model.fields) {
    irWireFields.add(wireFieldName(field.name));
    irDomainFields.add(fieldName(field.name));
  }

  for (const [wireField2, fieldDef] of Object.entries(baselineResponse.fields)) {
    if (fieldDef.optional) continue;
    if (!irWireFields.has(wireField2)) {
      return true;
    }
  }

  if (baselineDomain?.fields) {
    const baselineRequiredFields = Object.entries(baselineDomain.fields)
      .filter(([, f]) => !f.optional)
      .map(([name]) => name);
    const unmatchedCount = baselineRequiredFields.filter((n) => !irDomainFields.has(n)).length;
    if (unmatchedCount > 0 && baselineRequiredFields.length > 0) {
      const unmatchedRatio = unmatchedCount / baselineRequiredFields.length;
      if (unmatchedRatio > 0.3) {
        return true;
      }
    }
  }

  if (ctx?.apiSurface?.interfaces) {
    const modelSourceFile = (baselineResponse as any)?.sourceFile as string | undefined;
    const responseDir = modelSourceFile ? modelSourceFile.split('/').slice(0, 2).join('/') : null;

    for (const field of model.fields) {
      let fieldType = field.type;
      if (fieldType.kind === 'nullable') fieldType = fieldType.inner;
      if (fieldType.kind !== 'array' && fieldType.kind !== 'model') continue;
      const innerType = fieldType.kind === 'array' ? fieldType.items : fieldType;
      if (innerType.kind !== 'model') continue;

      const nestedWireName = wireInterfaceName(resolveInterfaceName(innerType.name, ctx));
      const wireField3 = wireFieldName(field.name);
      const baselineWireField2 = baselineResponse.fields![wireField3];
      if (!baselineWireField2) continue;

      const baselineTypeNames: string[] = baselineWireField2.type.match(/\b[A-Z][a-zA-Z0-9]*Response\b/g) || [];
      if (baselineTypeNames.length > 0 && !baselineTypeNames.includes(nestedWireName)) {
        return true;
      }

      if (baselineWireField2.type.includes(nestedWireName) || baselineWireField2.type.match(/\b[A-Z]\w*Response\b/)) {
        const typeNames: string[] = baselineWireField2.type.match(/\b[A-Z][a-zA-Z0-9]*\b/g) || [];
        for (const typeName of typeNames) {
          if (typeName === 'Record' || typeName === 'Array') continue;
          const nestedIface = ctx.apiSurface!.interfaces![typeName];
          if (!nestedIface) continue;
          const nestedSrc = (nestedIface as any).sourceFile as string | undefined;
          if (!nestedSrc || !responseDir) continue;
          const nestedDir = nestedSrc.split('/').slice(0, 2).join('/');
          if (nestedDir !== responseDir) {
            return true;
          }
        }
      }
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Field assignment planning — replaces inline if/else chains
// ---------------------------------------------------------------------------

/** Plan a single deserializer field assignment. */
export function planDeserializeField(
  field: Field,
  baselineDomain: BaselineInterface | undefined,
  baselineResponse: BaselineInterface | undefined,
  skipFormatFields: Set<string>,
  ctx: EmitterContext,
): { line: string; skip: boolean } {
  const domain = fieldName(field.name);
  const wire = wireFieldName(field.name);
  const wireAccess = `response.${wire}`;
  const skip = skipFormatFields.has(field.name);
  const fallbackForNullable = field.type.kind === 'nullable' ? 'null' : 'undefined';
  const expr = skip ? wireAccess : deserializeExpression(field.type, wireAccess, ctx, fallbackForNullable);
  const isNewField = baselineDomain && !baselineDomain.fields?.[domain];
  const effectivelyOptional = !field.required || isNewField;

  const guard = planDeserializeGuard(field, expr, wireAccess, effectivelyOptional, isNewField, baselineResponse);
  return { line: emitAssignment(domain, expr, wireAccess, guard), skip: false };
}

function planDeserializeGuard(
  field: Field,
  expr: string,
  wireAccess: string,
  effectivelyOptional: boolean | null | undefined,
  isNewField: boolean | null | undefined,
  baselineResponse: BaselineInterface | undefined,
): GuardStrategy {
  // Optional field with function-call expression → null check
  if (effectivelyOptional && expr !== wireAccess && needsNullGuard(field.type)) {
    const fallback = field.type.kind === 'nullable' ? 'null' : 'undefined';
    return { kind: 'null-check', fallback };
  }

  // Required field with direct assignment — may need coalesce fallback
  if (field.required && expr === wireAccess) {
    const wire = wireFieldName(field.name);
    const responseFieldInfo = baselineResponse?.fields?.[wire];
    const responseFieldOptional = responseFieldInfo?.optional ?? false;
    const needsFallback = responseFieldOptional || !!isNewField;
    const fallback = needsFallback ? defaultForType(field.type) : null;
    if (fallback) {
      return { kind: 'coalesce', fallback };
    }
  }

  return { kind: 'direct' };
}

/** Plan a single serializer field assignment. */
export function planSerializeField(
  field: Field,
  baselineDomain: BaselineInterface | undefined,
  baselineResponse: BaselineInterface | undefined,
  skipFormatFields: Set<string>,
  ctx: EmitterContext,
): { line: string; skip: boolean } {
  const wire = wireFieldName(field.name);
  const domain = fieldName(field.name);
  const domainAccess = `model.${domain}`;
  const skip = skipFormatFields.has(field.name);
  const fallbackForNullable = field.type.kind === 'nullable' ? 'null' : 'undefined';
  const expr = skip ? domainAccess : serializeExpression(field.type, domainAccess, ctx, fallbackForNullable);
  const isNewSerField = baselineDomain && !baselineDomain.fields?.[domain];
  const effectivelyOptionalSer = !field.required || isNewSerField;

  const guard = planSerializeGuard(
    field,
    expr,
    domainAccess,
    effectivelyOptionalSer,
    isNewSerField,
    baselineDomain,
    baselineResponse,
  );
  return { line: emitAssignment(wire, expr, domainAccess, guard), skip: false };
}

function planSerializeGuard(
  field: Field,
  expr: string,
  domainAccess: string,
  effectivelyOptionalSer: boolean | null | undefined,
  isNewSerField: boolean | null | undefined,
  baselineDomain: BaselineInterface | undefined,
  baselineResponse: BaselineInterface | undefined,
): GuardStrategy {
  const wire = wireFieldName(field.name);
  const domain = fieldName(field.name);

  // Function-call expression for optional/nullable fields → null check
  const shouldGuardSer = effectivelyOptionalSer || field.type.kind === 'nullable';
  if (expr !== domainAccess && needsNullGuard(field.type) && shouldGuardSer) {
    const fallback = field.type.kind === 'nullable' ? 'null' : 'undefined';
    return { kind: 'null-check', fallback };
  }

  // Optional domain → required wire: needs coalesce or assert
  const baselineWireField = baselineResponse?.fields?.[wire];
  const baselineDomainField = baselineDomain?.fields?.[domain];
  const isNewFieldOnExistingDomain = baselineDomain && !baselineDomainField;
  const domainFieldIsOptional =
    !field.required || (baselineDomainField?.optional ?? false) || !!isNewFieldOnExistingDomain;
  const wireFieldIsRequired = baselineWireField ? !baselineWireField.optional : field.required;
  const needsUndefinedCoalesce = domainFieldIsOptional && wireFieldIsRequired && expr === domainAccess;

  if (needsUndefinedCoalesce) {
    const wireHasNull = baselineWireField?.type?.includes('null') || field.type.kind === 'nullable';
    if (wireHasNull) {
      return { kind: 'coalesce', fallback: 'null' };
    }
    return { kind: 'non-null-assert' };
  }

  // Nullable with direct assignment → may need coalesce for domain-response mismatch
  if (field.type.kind === 'nullable' && expr === domainAccess) {
    const domainWireField2 = wireFieldName(field.name);
    const responseBaselineField2 = baselineResponse?.fields?.[domainWireField2];
    const baselineDomainField2 = baselineDomain?.fields?.[domain];
    const domainResponseMismatch =
      baselineDomainField2 &&
      !baselineDomainField2.optional &&
      responseBaselineField2 &&
      responseBaselineField2.optional;
    const fieldEffectivelyOptional = !field.required || !!isNewSerField || !!domainResponseMismatch;
    if (fieldEffectivelyOptional) {
      return { kind: 'coalesce', fallback: 'null' };
    }
  }

  return { kind: 'direct' };
}

// ---------------------------------------------------------------------------
// Field assignment emission — single function for all guard strategies
// ---------------------------------------------------------------------------

function emitAssignment(lhs: string, expr: string, accessExpr: string, guard: GuardStrategy): string {
  switch (guard.kind) {
    case 'direct':
      return `  ${lhs}: ${expr},`;
    case 'null-check':
      // If the expression already contains a null guard from nullable type handling
      // (e.g., `response.x != null ? deserializeFoo(response.x) : null`),
      // emit it directly — the fallback was baked into the expression.
      // Otherwise, wrap with an outer null check using the accessor.
      if (expr.includes(`${accessExpr} != null ?`)) {
        return `  ${lhs}: ${expr},`;
      }
      return `  ${lhs}: ${accessExpr} != null ? ${expr} : ${guard.fallback},`;
    case 'coalesce':
      return `  ${lhs}: ${expr} ?? ${guard.fallback},`;
    case 'non-null-assert':
      return `  ${lhs}: ${expr}!,`;
  }
}

// ---------------------------------------------------------------------------
// Serializer file emission helpers
// ---------------------------------------------------------------------------

interface SerializerContext {
  modelToService: Map<string, string>;
  resolveDir: (irService: string | undefined) => string;
  dedup: Map<string, string>;
  skippedSerializeModels: Set<string>;
  ctx: EmitterContext;
}

/** Build the import block for a serializer file. */
export function buildSerializerImports(
  model: Model,
  serializerPath: string,
  dirName: string,
  domainName: string,
  responseName: string,
  sctx: SerializerContext,
): string[] {
  const lines: string[] = [];
  const interfacePath = `src/${dirName}/interfaces/${fileName(model.name)}.interface.ts`;
  lines.push(`import type { ${domainName}, ${responseName} } from '${relativeImport(serializerPath, interfacePath)}';`);

  const nestedModelRefs = new Set<string>();
  for (const field of model.fields) {
    for (const ref of collectSerializedModelRefs(field.type)) {
      if (ref !== model.name) nestedModelRefs.add(ref);
    }
  }

  for (const dep of nestedModelRefs) {
    const depService = sctx.modelToService.get(dep);
    const depDir = sctx.resolveDir(depService);
    const depSerializerPath = `src/${depDir}/serializers/${fileName(dep)}.serializer.ts`;
    const depName = resolveInterfaceName(dep, sctx.ctx);
    const rel = relativeImport(serializerPath, depSerializerPath);
    lines.push(`import { deserialize${depName}, serialize${depName} } from '${rel}';`);
  }
  lines.push('');
  return lines;
}

/** Build the set of field names where format conversion should be skipped. */
export function buildSkipFormatFields(model: Model, baselineDomain: BaselineInterface | undefined): Set<string> {
  const skipFormatFields = new Set<string>();
  if (baselineDomain) {
    for (const field of model.fields) {
      if (skipFormatFields.has(field.name)) continue;
      const baselineField = baselineDomain.fields?.[fieldName(field.name)];
      if (baselineField && !baselineField.type.includes('Date') && hasFormatConversion(field.type)) {
        // Always convert date-time fields to Date regardless of baseline
        if (hasDateTimeConversion(field.type)) continue;
        skipFormatFields.add(field.name);
      }
    }
  }
  return skipFormatFields;
}

/** Check if serialize should be skipped (baseline incompat or cascading dependency). */
export function shouldSkipSerializeForModel(
  model: Model,
  baselineResponse: BaselineInterface | undefined,
  baselineDomain: BaselineInterface | undefined,
  dedup: Map<string, string>,
  skippedSerializeModels: Set<string>,
  ctx: EmitterContext,
): boolean {
  let shouldSkip = serializerHasBaselineIncompatibility(model, baselineResponse, baselineDomain, ctx);
  if (!shouldSkip) {
    for (const field of model.fields) {
      for (const ref of collectSerializedModelRefs(field.type)) {
        if (skippedSerializeModels.has(ref)) {
          shouldSkip = true;
          break;
        }
        const canon = dedup.get(ref);
        if (canon && skippedSerializeModels.has(canon)) {
          shouldSkip = true;
          break;
        }
      }
      if (shouldSkip) break;
    }
  }
  return shouldSkip;
}

/** Emit deserializer + serializer body lines for a model. */
export function emitSerializerBody(
  model: Model,
  domainName: string,
  responseName: string,
  typeParams: { decl: string; usage: string },
  baselineDomain: BaselineInterface | undefined,
  baselineResponse: BaselineInterface | undefined,
  skipFormatFields: Set<string>,
  shouldSkipSerialize: boolean,
  ctx: EmitterContext,
): string[] {
  const lines: string[] = [];

  // Deserialize function (wire → domain)
  const seenDeserFields = new Set<string>();
  const deserParamPrefix = model.fields.length === 0 ? '_' : '';
  lines.push(`export const deserialize${domainName} = ${typeParams.decl}(`);
  lines.push(`  ${deserParamPrefix}response: ${responseName}${typeParams.usage},`);
  lines.push(`): ${domainName}${typeParams.usage} => ({`);
  for (const field of model.fields) {
    const domain = fieldName(field.name);
    if (seenDeserFields.has(domain)) continue;
    seenDeserFields.add(domain);
    const plan = planDeserializeField(field, baselineDomain, baselineResponse, skipFormatFields, ctx);
    if (!plan.skip) lines.push(plan.line);
  }
  lines.push('});');

  // Serialize function (domain → wire)
  if (!shouldSkipSerialize) {
    const serParamPrefix = model.fields.length === 0 ? '_' : '';
    lines.push('');
    lines.push(`export const serialize${domainName} = ${typeParams.decl}(`);
    lines.push(`  ${serParamPrefix}model: ${domainName}${typeParams.usage},`);
    lines.push(`): ${responseName}${typeParams.usage} => ({`);
    const seenSerFields = new Set<string>();
    for (const field of model.fields) {
      const wire = wireFieldName(field.name);
      if (seenSerFields.has(wire)) continue;
      seenSerFields.add(wire);
      const plan = planSerializeField(field, baselineDomain, baselineResponse, skipFormatFields, ctx);
      if (!plan.skip) lines.push(plan.line);
    }
    lines.push('});');
  }

  return lines;
}
