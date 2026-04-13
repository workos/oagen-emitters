import type { TypeRef, PrimitiveType, UnionType } from '@workos/oagen';
import { mapTypeRef as irMapTypeRef } from '@workos/oagen';
import { className } from './naming.js';

/** Known C# value types that need `?` for nullable. */
const VALUE_TYPES = new Set(['int', 'long', 'double', 'bool', 'float', 'decimal', 'byte', 'short', 'DateTimeOffset']);

/**
 * Map an IR TypeRef to a C# type string.
 */
export function mapTypeRef(ref: TypeRef): string {
  return irMapTypeRef<string>(ref, {
    primitive: mapPrimitive,
    array: (_ref, items) => `List<${items}>`,
    model: (r) => className(r.name),
    enum: (r) => className(r.name),
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
  if (unique.length === 1) return unique[0];

  // Discriminated union: register for converter generation and return first variant as base
  if (_ref.discriminator && _ref.discriminator.mapping) {
    const baseName = unique[0];
    discriminatedUnions.set(baseName, {
      property: _ref.discriminator.property,
      mapping: _ref.discriminator.mapping,
      variantTypes: unique,
    });
    // Use object with JsonConverter for discriminated unions since
    // AnyOf<> doesn't support discriminator-based deserialization
    return 'object';
  }

  if (unique.length >= 2 && unique.length <= 3) return `AnyOf<${unique.join(', ')}>`;
  return 'object';
}
