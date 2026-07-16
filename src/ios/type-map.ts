import type { TypeRef, PrimitiveType, UnionType } from '@workos/oagen';
import { mapTypeRef as irMapTypeRef } from '@workos/oagen';
import { typeName } from './naming.js';

/**
 * Map an IR `TypeRef` to a Swift type expression string.
 *
 * `nullable` variants become `T?`; the caller (models/resources) additionally
 * appends `?` for non-required, non-nullable fields via {@link isOptionalType}
 * bookkeeping so we never produce a double optional.
 */
export function mapTypeRef(ref: TypeRef): string {
  return irMapTypeRef<string>(ref, {
    primitive: mapPrimitive,
    array: (_ref, items) => `[${items}]`,
    model: (r) => typeName(r.name),
    enum: (r) => typeName(r.name),
    union: (r, variants) => joinUnionVariants(r, variants),
    nullable: (_ref, inner) => (inner.endsWith('?') ? inner : `${inner}?`),
    literal: (r) => {
      if (r.value === null) return 'AnyCodable';
      if (typeof r.value === 'string') return 'String';
      if (typeof r.value === 'number') return Number.isInteger(r.value) ? 'Int' : 'Double';
      if (typeof r.value === 'boolean') return 'Bool';
      return 'AnyCodable';
    },
    map: (_ref, value) => `[String: ${value}]`,
  });
}

function mapPrimitive(ref: PrimitiveType): string {
  if (ref.format === 'binary' || ref.format === 'byte') return 'Data';
  switch (ref.type) {
    case 'string':
      if (ref.format === 'date-time' || ref.format === 'date') return 'Date';
      return 'String';
    case 'integer':
      return 'Int';
    case 'number':
      return 'Double';
    case 'boolean':
      return 'Bool';
    case 'unknown':
      return 'AnyCodable';
  }
}

function joinUnionVariants(ref: UnionType, variants: string[]): string {
  // allOf merges collapse to the (already-merged) first variant shape.
  if (ref.compositionKind === 'allOf') {
    return variants[0] ?? 'AnyCodable';
  }
  const unique = [...new Set(variants)];
  if (unique.length === 1) return unique[0];
  // v1: heterogeneous / discriminated unions widen to AnyCodable (see the
  // design doc's "Future Enhancements" for native sum-type modeling).
  return 'AnyCodable';
}

/** True when a `TypeRef` is a `nullable` wrapper (its Swift form already ends `?`). */
export function isNullableRef(ref: TypeRef): boolean {
  return ref.kind === 'nullable';
}

/**
 * Swift type for a struct field / parameter, accounting for optionality.
 * A field is optional when it is not required OR its type is nullable; we append
 * a single `?` and never double it.
 */
export function fieldSwiftType(ref: TypeRef, required: boolean): string {
  const base = mapTypeRef(ref);
  const optional = !required || isNullableRef(ref);
  if (optional && !base.endsWith('?')) return `${base}?`;
  return base;
}
