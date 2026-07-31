import type { TypeRef, PrimitiveType, UnionType } from '@workos/oagen';
import { mapTypeRef as irMapTypeRef } from '@workos/oagen';
import { typeName } from './naming.js';

/**
 * Map an IR `TypeRef` to a Kotlin type expression string.
 *
 * Kotlin marks nullability at use sites (`T?`). `nullable` variants become `T?`
 * here; the caller (models/resources) additionally appends `?` for non-required,
 * non-nullable fields via {@link fieldKotlinType} so we never double the marker.
 */
export function mapTypeRef(ref: TypeRef): string {
  return irMapTypeRef<string>(ref, {
    primitive: mapPrimitive,
    array: (_ref, items) => `List<${items}>`,
    model: (r) => typeName(r.name),
    enum: (r) => typeName(r.name),
    union: (r, variants) => joinUnionVariants(r, variants),
    nullable: (_ref, inner) => (inner.endsWith('?') ? inner : `${inner}?`),
    literal: (r) => {
      if (r.value === null) return 'JsonElement';
      if (typeof r.value === 'string') return 'String';
      if (typeof r.value === 'number') return Number.isInteger(r.value) ? 'Long' : 'Double';
      if (typeof r.value === 'boolean') return 'Boolean';
      return 'JsonElement';
    },
    map: (_ref, value) => `Map<String, ${value}>`,
  });
}

function mapPrimitive(ref: PrimitiveType): string {
  if (ref.format === 'binary' || ref.format === 'byte') return 'ByteArray';
  if (ref.format === 'int32') return 'Int';
  if (ref.format === 'int64') return 'Long';
  switch (ref.type) {
    case 'string':
      if (ref.format === 'date-time' || ref.format === 'date') return 'Instant';
      return 'String';
    case 'integer':
      return 'Long';
    case 'number':
      return 'Double';
    case 'boolean':
      return 'Boolean';
    case 'unknown':
      // `JsonElement` rather than `Any`: it is @Serializable out of the box, so
      // it needs no custom serializer at each use site.
      return 'JsonElement';
  }
}

function joinUnionVariants(ref: UnionType, variants: string[]): string {
  // allOf merges collapse to the (already-merged) first variant shape.
  if (ref.compositionKind === 'allOf') {
    return variants[0] ?? 'JsonElement';
  }
  const unique = [...new Set(variants)];
  if (unique.length === 1) return unique[0];
  // v1: heterogeneous / discriminated unions widen to JsonElement (see the
  // design doc's "Future Enhancements" for native sealed-interface modeling).
  return 'JsonElement';
}

/** True when a `TypeRef` is a `nullable` wrapper (its Kotlin form already ends `?`). */
export function isNullableRef(ref: TypeRef): boolean {
  return ref.kind === 'nullable';
}

/**
 * Kotlin type for a data-class property / method parameter, accounting for
 * optionality. A field is nullable when it is not required OR its type is
 * nullable; we append a single `?` and never double it.
 */
export function fieldKotlinType(ref: TypeRef, required: boolean): string {
  const base = mapTypeRef(ref);
  const optional = !required || isNullableRef(ref);
  if (optional && !base.endsWith('?')) return `${base}?`;
  return base;
}

/**
 * Imports implied by a Kotlin type expression. Callers collect these into the
 * file's import set so generated files compile standalone.
 */
export function implicitImportsFor(kotlinType: string): string[] {
  const imports: string[] = [];
  if (/\bInstant\b/.test(kotlinType)) imports.push('kotlinx.datetime.Instant');
  if (/\bJsonElement\b/.test(kotlinType)) imports.push('kotlinx.serialization.json.JsonElement');
  return imports;
}
