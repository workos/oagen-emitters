import type { Model, Field, EmitterContext, TypeRef, UnionType, PrimitiveType } from '@workos/oagen';
import { mapTypeRef as tsMapTypeRef } from './type-map.js';
import { fieldName, wireFieldName, fileName, resolveInterfaceName, wireInterfaceName } from './naming.js';
import {
  relativeImport,
  buildKnownTypeNames,
  isBaselineGeneric,
  createServiceDirResolver,
  modelHasNewFields,
  assignModelsToServices,
} from './utils.js';
import {
  liveSurfaceHasFunction,
  liveSurfaceHasFile,
  liveSurfaceFunctionPath,
  liveSurfaceHasAutogenFile,
} from './live-surface.js';
import { isNodeOwnedService } from './options.js';

// ---------------------------------------------------------------------------
// Guard strategy
// ---------------------------------------------------------------------------

type GuardStrategy =
  | { kind: 'direct' }
  | { kind: 'null-check'; fallback: string }
  | { kind: 'coalesce'; fallback: string }
  | { kind: 'non-null-assert' };

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
 * Decide whether a `deserialize${X}` / `serialize${X}` helper will be
 * resolvable at compile time. A helper is callable when:
 *   - the live SDK already exports it (live-surface knows), OR
 *   - the emitter is producing the dep model's serializer this run, which
 *     happens when `modelHasNewFields(dep, ctx)` says the dep needs
 *     regeneration.
 *
 * When neither condition holds, expression builders fall back to passing
 * the value through unchanged — `deserializeX(wire)` and `serializeX(model)`
 * become `wire` / `model` respectively. Safe because elided cases imply
 * the wire and domain shapes are identical (no IR additions).
 */
function helperExists(helperName: string, depModelName: string, ctx: EmitterContext): boolean {
  if (liveSurfaceHasFunction(helperName)) return true;
  const depModel = ctx.spec.models.find((m) => m.name === depModelName);
  if (!depModel) return false;
  const modelToService = assignModelsToServices(ctx.spec.models, ctx.spec.services, ctx.modelHints);
  const depService = modelToService.get(depModelName);
  const resolvedName = resolveInterfaceName(depModelName, ctx);
  const siblingPrefix = helperName.startsWith('serialize') ? 'deserialize' : 'serialize';
  const siblingPath = liveSurfaceFunctionPath(`${siblingPrefix}${resolvedName}`);
  if (siblingPath && liveSurfaceHasFile(siblingPath) && !liveSurfaceHasAutogenFile(siblingPath)) return false;
  const sourceFile = (ctx.apiSurface?.interfaces?.[resolvedName] as { sourceFile?: string } | undefined)?.sourceFile;
  const { resolveDir } = createServiceDirResolver(ctx.spec.models, ctx.spec.services, ctx);
  const candidate = sourceFile
    ? sourceFile.replace('/interfaces/', '/serializers/').replace('.interface.ts', '.serializer.ts')
    : `src/${resolveDir(depService)}/serializers/${fileName(depModelName)}.serializer.ts`;
  if (liveSurfaceHasFile(candidate) && !liveSurfaceHasAutogenFile(candidate)) return false;
  if (isNodeOwnedService(ctx, depService)) return true;
  return modelHasNewFields(depModel, ctx);
}

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
      // The deserialize helper may not exist if its serializer file was
      // elided (no baseline serializer + no new fields ⇒ no generation).
      // Fall back to passing the wire value through — the runtime shape
      // is identical to the domain shape in those cases.
      if (!helperExists(`deserialize${name}`, ref.name, ctx)) return wireExpr;
      return `deserialize${name}(${wireExpr})`;
    }
    case 'array':
      if (ref.items.kind === 'model') {
        const name = resolveInterfaceName(ref.items.name, ctx);
        if (!helperExists(`deserialize${name}`, ref.items.name, ctx)) return wireExpr;
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
      if (!helperExists(`serialize${name}`, ref.name, ctx)) return domainExpr;
      return `serialize${name}(${domainExpr})`;
    }
    case 'array':
      if (ref.items.kind === 'model') {
        const name = resolveInterfaceName(ref.items.name, ctx);
        if (!helperExists(`serialize${name}`, ref.items.name, ctx)) return domainExpr;
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
  // No mapping → passthrough. Without this guard, an empty `disc.mapping`
  // emits `switch { ; default: ... }` which is invalid TypeScript syntax
  // (the leading `;` looks like a stray statement before the first case).
  if (cases.length === 0) return expr;
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
    irDomainFields.add(fieldName(field.domainName ?? field.name));
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
// Field assignment planning
// ---------------------------------------------------------------------------

export function planDeserializeField(
  field: Field,
  baselineDomain: BaselineInterface | undefined,
  baselineResponse: BaselineInterface | undefined,
  skipFormatFields: Set<string>,
  ctx: EmitterContext,
): { line: string; skip: boolean } {
  const domain = fieldName(field.domainName ?? field.name);
  const wire = wireFieldName(field.name);
  const wireAccess = `response.${wire}`;
  const skip = skipFormatFields.has(field.name);

  // Fallback selection considers both the IR field type and the baseline
  // domain field. When baseline declares the field as `optional`
  // (undefined-permitting) but the IR is nullable (null-only), prefer
  // `undefined` so the deserialize output matches the baseline interface
  // signature. Otherwise the assignment becomes
  // `Record<...> | null → Record<...> | undefined` (TS2322).
  const baselineDomainField = baselineDomain?.fields?.[domain];
  const baselineDomainAcceptsNull = baselineDomainField?.type?.includes('null') ?? false;
  let fallbackForNullable: string;
  if (field.type.kind === 'nullable') {
    fallbackForNullable =
      baselineDomainField && baselineDomainField.optional && !baselineDomainAcceptsNull ? 'undefined' : 'null';
  } else {
    fallbackForNullable = 'undefined';
  }
  let expr = skip ? wireAccess : deserializeExpression(field.type, wireAccess, ctx, fallbackForNullable);

  // Baseline-declared Date for an IR `string` field: the interface body
  // uses the baseline's `Date` (line 392 in models.ts), so the serializer
  // must convert with `new Date(...)`. The IR type doesn't carry the
  // `format: date-time` here (the spec just said `type: string`), so
  // `deserializeExpression` would otherwise return the raw wire access.
  const baselineField = baselineDomain?.fields?.[domain];
  if (
    !skip &&
    expr === wireAccess &&
    baselineField?.type === 'Date' &&
    field.type.kind === 'primitive' &&
    field.type.type === 'string'
  ) {
    expr = `new Date(${wireAccess})`;
  }

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
  if (effectivelyOptional && expr !== wireAccess && needsNullGuard(field.type)) {
    const fallback = field.type.kind === 'nullable' ? 'null' : 'undefined';
    return { kind: 'null-check', fallback };
  }

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

export function planSerializeField(
  field: Field,
  baselineDomain: BaselineInterface | undefined,
  baselineResponse: BaselineInterface | undefined,
  skipFormatFields: Set<string>,
  ctx: EmitterContext,
): { line: string; skip: boolean } {
  const wire = wireFieldName(field.name);
  const domain = fieldName(field.domainName ?? field.name);
  const domainAccess = `model.${domain}`;
  const skip = skipFormatFields.has(field.name);

  // Symmetric to `planDeserializeField`: when the baseline wire is
  // `optional` (undefined) but the IR is nullable, fall back to
  // `undefined` so the serialized output matches the baseline wire shape.
  const baselineWireField = baselineResponse?.fields?.[wire];
  const baselineWireAcceptsNull = baselineWireField?.type?.includes('null') ?? false;
  let fallbackForNullable: string;
  if (field.type.kind === 'nullable') {
    fallbackForNullable =
      baselineWireField && baselineWireField.optional && !baselineWireAcceptsNull ? 'undefined' : 'null';
  } else {
    fallbackForNullable = 'undefined';
  }
  let expr = skip ? domainAccess : serializeExpression(field.type, domainAccess, ctx, fallbackForNullable);

  // Symmetric to `planDeserializeField`: when the baseline declares the
  // domain field as `Date` but the IR carries a plain `string`, the
  // serializer must call `.toISOString()` so the wire form gets a string
  // back. Without this, the serializer assigns a `Date` model field into
  // a `string` wire field — TS2322.
  const baselineField = baselineDomain?.fields?.[domain];
  if (
    !skip &&
    expr === domainAccess &&
    baselineField?.type === 'Date' &&
    field.type.kind === 'primitive' &&
    field.type.type === 'string'
  ) {
    expr = field.required ? `${domainAccess}.toISOString()` : `${domainAccess}?.toISOString()`;
  }

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

  const shouldGuardSer = effectivelyOptionalSer || field.type.kind === 'nullable';
  if (expr !== domainAccess && needsNullGuard(field.type) && shouldGuardSer) {
    let fallback: string = field.type.kind === 'nullable' ? 'null' : 'undefined';
    // If the wire side is required but the field guard would otherwise emit
    // `undefined`, the assignment becomes `string | undefined → string`.
    // Pick a non-undefined fallback that satisfies the wire type:
    //   - `null` when the wire type accepts null
    //   - the string-defaulting `defaultForType(field.type)` (e.g. `''`)
    //     for required-string wires
    const baselineWireField = baselineResponse?.fields?.[wire];
    const wireRequired = baselineWireField ? !baselineWireField.optional : field.required;
    if (fallback === 'undefined' && wireRequired) {
      const wireAcceptsNull = baselineWireField?.type?.includes('null');
      fallback = wireAcceptsNull ? 'null' : (defaultForType(field.type) ?? 'undefined');
    }
    return { kind: 'null-check', fallback };
  }

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
    // Only coalesce when the wire field is REQUIRED — it must carry a value, so
    // a nullish domain value has to become `null` (or `undefined` if the wire
    // rejects null). When the wire field is itself optional, a passthrough is
    // correct and compat-faithful: `undefined` omits the field (matching the
    // hand-written serializers) and an explicit `null` is preserved. Inventing
    // `?? null` here would send `organization_id: null` for an absent optional,
    // non-nullable-per-spec body field — a wire behavior change.
    const wireFieldIsRequired2 = responseBaselineField2 ? !responseBaselineField2.optional : field.required;
    if (fieldEffectivelyOptional && wireFieldIsRequired2) {
      // The wire side may not accept `null` (e.g. `metadata?: Record<...>`).
      // Fall back to `undefined` in that case so the assignment matches the
      // baseline wire field's actual type.
      const wireAcceptsNull = responseBaselineField2?.type?.includes('null') ?? true;
      const fallback = wireAcceptsNull ? 'null' : 'undefined';
      return { kind: 'coalesce', fallback };
    }
  }

  return { kind: 'direct' };
}

function emitAssignment(lhs: string, expr: string, accessExpr: string, guard: GuardStrategy): string {
  switch (guard.kind) {
    case 'direct':
      return `  ${lhs}: ${expr},`;
    case 'null-check':
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
  /** Models reachable from any response — anything outside this set is
   *  request-only and won't have a `deserialize<X>` emitted. `undefined`
   *  means "no usage info available, assume deserialize exists". */
  responseReachableModels: Set<string> | undefined;
  ctx: EmitterContext;
}

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
  // Single-form baselines (`wireInterfaceName` returns the same name as
  // `domainName`) only export one symbol — don't duplicate the import.
  const symbols = domainName === responseName ? domainName : `${domainName}, ${responseName}`;
  lines.push(`import type { ${symbols} } from '${relativeImport(serializerPath, interfacePath)}';`);

  const nestedModelRefs = new Set<string>();
  for (const field of model.fields) {
    for (const ref of collectSerializedModelRefs(field.type)) {
      if (ref !== model.name) nestedModelRefs.add(ref);
    }
  }

  for (const dep of nestedModelRefs) {
    const depService = sctx.modelToService.get(dep);
    const depDir = sctx.resolveDir(depService);
    const depName = resolveInterfaceName(dep, sctx.ctx);
    const depIsOwned = isNodeOwnedService(sctx.ctx, depService);

    // Locate the serializer file, in priority order:
    //   1. The actual file containing `deserialize${depName}` per
    //      live-surface (e.g. `deserializeAuditLogSchema` lives in
    //      `create-audit-log-schema.serializer.ts`, not in the predictable
    //      `audit-log-schema.serializer.ts`).
    //   2. The baseline interface's adjacent serializer file path.
    //   3. The IR-name path — this is where the emitter writes the
    //      serializer it's producing this run.
    const baselineSrc = depIsOwned
      ? undefined
      : (sctx.ctx.apiSurface?.interfaces?.[depName] as { sourceFile?: string } | undefined)?.sourceFile;
    const baselineSerializerPath = baselineSrc
      ? baselineSrc.replace('/interfaces/', '/serializers/').replace('.interface.ts', '.serializer.ts')
      : null;
    const irNameSerializerPath = `src/${depDir}/serializers/${fileName(dep)}.serializer.ts`;

    const liveDeserPath = depIsOwned ? undefined : liveSurfaceFunctionPath(`deserialize${depName}`);
    const liveSerPath = depIsOwned ? undefined : liveSurfaceFunctionPath(`serialize${depName}`);
    const depSerializerPath =
      liveDeserPath ??
      liveSerPath ??
      (baselineSerializerPath && liveSurfaceHasFile(baselineSerializerPath)
        ? baselineSerializerPath
        : irNameSerializerPath);

    const rel = relativeImport(serializerPath, depSerializerPath);
    const canon = sctx.dedup.get(dep);
    const depSkipSerialize =
      sctx.skippedSerializeModels.has(dep) || (canon != null && sctx.skippedSerializeModels.has(canon));
    const depSkipDeserialize =
      sctx.responseReachableModels !== undefined &&
      !sctx.responseReachableModels.has(dep) &&
      (canon == null || !sctx.responseReachableModels.has(canon));

    // Decide whether this serializer is reachable at runtime:
    //   - file on disk → honor what it exports (hasDeser/hasSer)
    //   - file NOT on disk → only safe to import if the emitter is
    //     producing the dep's serializer this run, which only happens
    //     when `modelHasNewFields` says the dep needs regeneration.
    //
    // Skip the import otherwise. The serializer body falls back to a
    // pass-through expression when it can't call the helper.
    const hasDeser = liveSurfaceHasFunction(`deserialize${depName}`);
    const hasSer = liveSurfaceHasFunction(`serialize${depName}`);
    const fileExists = !depIsOwned && liveSurfaceHasFile(depSerializerPath);
    if (fileExists && !hasDeser && !hasSer) continue;
    if (!fileExists) {
      const depModel = sctx.ctx.spec.models.find((m) => m.name === dep);
      const willGenerateSerializer = depModel ? depIsOwned || modelHasNewFields(depModel, sctx.ctx) : true;
      if (!willGenerateSerializer) continue;
    }

    // Mixed: file exists, only one of the pair is exported. Import only
    // what's present so we don't synthesize a missing symbol. The body
    // emitter's `bodyArgExpr` already falls through when it sees a missing
    // serialize function.
    if (fileExists && depSkipSerialize) {
      if (hasDeser) lines.push(`import { deserialize${depName} } from '${rel}';`);
      continue;
    }
    if (fileExists && !hasSer) {
      lines.push(`import { deserialize${depName} } from '${rel}';`);
      continue;
    }
    if (fileExists && !hasDeser) {
      lines.push(`import { serialize${depName} } from '${rel}';`);
      continue;
    }

    if (depSkipSerialize && depSkipDeserialize) continue;
    if (depSkipSerialize) {
      lines.push(`import { deserialize${depName} } from '${rel}';`);
    } else if (depSkipDeserialize) {
      lines.push(`import { serialize${depName} } from '${rel}';`);
    } else {
      lines.push(`import { deserialize${depName}, serialize${depName} } from '${rel}';`);
    }
  }
  lines.push('');
  return lines;
}

export function buildSkipFormatFields(model: Model, baselineDomain: BaselineInterface | undefined): Set<string> {
  const skipFormatFields = new Set<string>();
  if (baselineDomain) {
    for (const field of model.fields) {
      if (skipFormatFields.has(field.name)) continue;
      const baselineField = baselineDomain.fields?.[fieldName(field.name)];
      if (baselineField && !baselineField.type.includes('Date') && hasFormatConversion(field.type)) {
        if (hasDateTimeConversion(field.type)) continue;
        skipFormatFields.add(field.name);
      }
    }
  }
  return skipFormatFields;
}

export function shouldSkipSerializeForModel(
  model: Model,
  baselineResponse: BaselineInterface | undefined,
  baselineDomain: BaselineInterface | undefined,
  dedup: Map<string, string>,
  skippedSerializeModels: Set<string>,
  ctx: EmitterContext,
): boolean {
  let shouldSkip =
    serializerHasBaselineIncompatibility(model, baselineResponse, baselineDomain, ctx) ||
    hasUnsafeSerializePassthrough(model, baselineDomain, baselineResponse, ctx);
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
        const resolved = resolveInterfaceName(ref, ctx);
        if (wireInterfaceName(resolved) !== resolved && !helperExists(`serialize${resolved}`, ref, ctx)) {
          shouldSkip = true;
          break;
        }
      }
      if (shouldSkip) break;
    }
  }
  return shouldSkip;
}

export function emitSerializerBody(
  model: Model,
  domainName: string,
  responseName: string,
  typeParams: { decl: string; usage: string },
  baselineDomain: BaselineInterface | undefined,
  baselineResponse: BaselineInterface | undefined,
  skipFormatFields: Set<string>,
  shouldSkipSerialize: boolean,
  shouldSkipDeserialize: boolean,
  ctx: EmitterContext,
): string[] {
  const lines: string[] = [];
  const effectiveShouldSkipSerialize =
    shouldSkipSerialize || hasUnsafeSerializePassthrough(model, baselineDomain, baselineResponse, ctx);

  if (!shouldSkipDeserialize) {
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
  }

  if (!effectiveShouldSkipSerialize) {
    if (!shouldSkipDeserialize) lines.push('');
    const serParamPrefix = model.fields.length === 0 ? '_' : '';
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

function hasUnsafeSerializePassthrough(
  model: Model,
  baselineDomain: BaselineInterface | undefined,
  baselineResponse: BaselineInterface | undefined,
  ctx: EmitterContext,
): boolean {
  if (!baselineDomain?.fields || !baselineResponse?.fields) return false;

  for (const field of model.fields) {
    const domain = fieldName(field.name);
    const wire = wireFieldName(field.name);
    const domainField = baselineDomain.fields[domain];
    const wireField = baselineResponse.fields[wire];
    if (!domainField || !wireField || domainField.type === wireField.type) continue;

    const domainAccess = `model.${domain}`;
    if (serializeExpression(field.type, domainAccess, ctx) === domainAccess) {
      return true;
    }
  }

  return false;
}
