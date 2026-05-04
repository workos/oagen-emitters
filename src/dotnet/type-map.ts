import type { TypeRef, PrimitiveType, UnionType } from '@workos/oagen';
import { mapTypeRef as irMapTypeRef } from '@workos/oagen';
import { className, modelClassName } from './naming.js';

/** Known C# value types that need `?` for nullable. */
const VALUE_TYPES = new Set(['int', 'long', 'double', 'bool', 'float', 'decimal', 'byte', 'short', 'DateTimeOffset']);

/**
 * Module-level alias map for structurally-identical enums. Populated by
 * `setEnumAliases` from the current spec's enum list; consulted by
 * `mapTypeRef` so that every reference to a duplicate enum resolves to the
 * canonical name. C# has no first-class type alias for enums, so dedup must
 * happen at reference-rewrite time rather than via a runtime alias.
 */
const enumAliases = new Map<string, string>();

/**
 * Names of enums that resolve to a single wire value and should therefore be
 * mapped to C# `string` at reference sites (the owning property emits a
 * const initializer). Populated by `setSingleValueEnumNames`.
 */
const singleValueEnumNames = new Set<string>();

/**
 * Module-level alias map for structurally-identical models. Populated by
 * `setModelAliases` from model deduplication; consulted by `mapTypeRef` so
 * that every reference to a duplicate model resolves to the canonical name.
 */
const modelAliases = new Map<string, string>();

/** Replace the current enum-alias map. Safe to call more than once. */
export function setEnumAliases(aliases: Map<string, string>): void {
  enumAliases.clear();
  for (const [k, v] of aliases) enumAliases.set(k, v);
}

/** Replace the current model-alias map. Safe to call more than once. */
export function setModelAliases(aliases: Map<string, string>): void {
  modelAliases.clear();
  for (const [k, v] of aliases) modelAliases.set(k, v);
}

/** Check if a model name is an alias (i.e., structurally identical to another model). */
export function isModelAlias(name: string): boolean {
  return modelAliases.has(name);
}

/** Resolve a model name to its canonical form (identity if not an alias). */
export function resolveModelName(name: string): string {
  return modelAliases.get(name) ?? name;
}

/** Replace the set of enum names that are single-value discriminator stand-ins. */
export function setSingleValueEnumNames(names: Iterable<string>): void {
  singleValueEnumNames.clear();
  for (const n of names) singleValueEnumNames.add(n);
}

/** Resolve an enum reference name to its canonical form. */
export function resolveEnumTypeName(name: string): string {
  return enumAliases.get(name) ?? name;
}

/**
 * Map an IR TypeRef to a C# type string.
 */
export function mapTypeRef(ref: TypeRef): string {
  return irMapTypeRef<string>(ref, {
    primitive: mapPrimitive,
    array: (_ref, items) => `List<${items}>`,
    model: (r) => modelClassName(modelAliases.get(r.name) ?? r.name),
    enum: (r) => {
      // Single-value enums (discriminator consts in disguise) map to `string`
      // so the caller can't misuse a public one-member enum type. The
      // owning property emits a const initializer separately.
      if ((r.values?.length ?? 0) === 1) return 'string';
      if (singleValueEnumNames.has(r.name)) return 'string';
      return className(resolveEnumTypeName(r.name));
    },
    union: (_r, variants) => joinUnionVariants(_r, variants),
    nullable: (_ref, inner) => {
      // With <Nullable>enable</Nullable>, all nullable types need `?`
      if (inner.endsWith('?')) return inner; // already nullable (e.g., nested nullable)
      return `${inner}?`;
    },
    literal: (r) => {
      if (r.value === null) return 'object';
      if (typeof r.value === 'string') return 'string';
      if (typeof r.value === 'number') return Number.isInteger(r.value) ? 'int' : 'double';
      if (typeof r.value === 'boolean') return 'bool';
      return 'object';
    },
    map: (_ref, value) => `Dictionary<string, ${value}>`,
  });
}

/**
 * Map an IR TypeRef to a C# type string, making optional fields nullable.
 * For value types, appends `?`. For reference types, returns as-is.
 */
export function mapTypeRefOptional(ref: TypeRef): string {
  const baseType = mapTypeRef(ref);
  if (isValueType(baseType)) return `${baseType}?`;
  return baseType;
}

/**
 * Check if a C# type is a value type (needs ? for nullable).
 */
export function isValueType(csType: string): boolean {
  // Strip trailing ? if present
  const bare = csType.endsWith('?') ? csType.slice(0, -1) : csType;
  if (VALUE_TYPES.has(bare)) return true;
  // Enums are value types, but we can't detect them purely from the type string.
  // The caller should handle enum nullability explicitly when needed.
  return false;
}

/**
 * Check if an IR TypeRef maps to a C# value type.
 */
export function isValueTypeRef(ref: TypeRef): boolean {
  if (ref.kind === 'enum') return true;
  if (ref.kind === 'primitive') {
    // DateTimeOffset is a value type (struct)
    if (ref.format === 'date-time') return true;
    switch (ref.type) {
      case 'integer':
      case 'number':
      case 'boolean':
        return true;
      default:
        return false;
    }
  }
  return false;
}

/**
 * Whether a TypeRef directly names an enum (no nullable wrapper).
 * Used to detect required enum request fields that must not silently serialize
 * their default Unknown sentinel.
 */
export function isEnumRef(ref: TypeRef): boolean {
  return ref.kind === 'enum';
}

/**
 * Emit JSON attributes for a request-side property. Property name mapping is
 * handled by a global SnakeCaseLower / SnakeCaseNamingStrategy configuration
 * on both serializers, so per-property name attributes are not emitted.
 *
 * When `isRequiredEnum` is true, configure both serializers to skip the field
 * when its value equals the enum default (0 = Unknown sentinel). This converts
 * "unset required enum" from a silent `"unknown"` wire value into a clean
 * omission so the API returns a clear `missing required field` error instead
 * of a confusing 422.
 */
export function emitJsonPropertyAttributes(_wireName: string, options: { isRequiredEnum?: boolean } = {}): string[] {
  if (options.isRequiredEnum) {
    return [
      `        [JsonProperty(DefaultValueHandling = DefaultValueHandling.Ignore)]`,
      `        [STJS.JsonIgnore(Condition = STJS.JsonIgnoreCondition.WhenWritingDefault)]`,
    ];
  }
  // Convention-based: SnakeCaseLower naming policy handles the name mapping.
  return [];
}

function mapPrimitive(ref: PrimitiveType): string {
  if (ref.format === 'binary') return 'byte[]';
  if (ref.format === 'int32') return 'int';
  if (ref.format === 'int64') return 'long';
  if (ref.format === 'date-time') return 'DateTimeOffset';
  switch (ref.type) {
    case 'string':
      return 'string';
    case 'integer':
      return 'long';
    case 'number':
      return 'double';
    case 'boolean':
      return 'bool';
    case 'unknown':
      return 'object';
  }
}

/**
 * Track discriminated unions for downstream model generation.
 * Key = generated base type name, Value = discriminator info.
 */
export const discriminatedUnions = new Map<
  string,
  { property: string; mapping: Record<string, string>; variantTypes: string[] }
>();

function joinUnionVariants(_ref: UnionType, variants: string[]): string {
  if (_ref.compositionKind === 'allOf') {
    return variants[0] ?? 'object';
  }
  const unique = [...new Set(variants)];

  // Discriminated union: register for converter generation BEFORE collapsing
  // single-unique to avoid losing the discriminator when all variants alias
  // to the same canonical model (structural dedup). The base type used for
  // the converter name comes from the discriminator's IR variant names so
  // it stays stable even when the C# class names get rewritten by aliases.
  if (_ref.discriminator && _ref.discriminator.mapping) {
    const irVariantNames = _ref.variants
      .filter((v) => v.kind === 'model')
      .map((v) => (v.kind === 'model' ? v.name : ''))
      .filter(Boolean);
    const baseName = irVariantNames[0] ?? unique[0];
    discriminatedUnions.set(baseName, {
      property: _ref.discriminator.property,
      mapping: _ref.discriminator.mapping,
      variantTypes: unique,
    });
    // Use object with JsonConverter for discriminated unions since
    // AnyOf<> doesn't support discriminator-based deserialization
    return 'object';
  }

  if (unique.length === 1) return unique[0];

  if (unique.length >= 2 && unique.length <= 9) return `OneOf.OneOf<${unique.join(', ')}>`;
  // OneOf supports arity 2-9. Higher-arity unions collapse to `object`,
  // losing type information. Warn so the author knows the spec outgrew the
  // runtime support instead of silently degrading.
  if (unique.length >= 10) {
    console.warn(
      `[oagen:dotnet] Union with ${unique.length} variants exceeds OneOf<T0..T8> arity; falling back to object. Variants: ${unique.join(', ')}`,
    );
  }
  return 'object';
}
