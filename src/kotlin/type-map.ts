import type { TypeRef, PrimitiveType, UnionType } from '@workos/oagen';
import { mapTypeRef as irMapTypeRef } from '@workos/oagen';
import { className } from './naming.js';
import { enumCanonicalMap } from './enums.js';

/** Resolve an enum name through the canonical map (identity when no alias). */
function resolveEnumName(name: string): string {
  return className(enumCanonicalMap.get(name) ?? name);
}

/**
 * Map an IR TypeRef to a non-nullable Kotlin type expression.
 *
 * Kotlin's type system marks nullability at use-sites (`T?`). Optional fields
 * on generated models append `?` to the output of this function.
 */
export function mapTypeRef(ref: TypeRef): string {
  return irMapTypeRef<string>(ref, {
    primitive: mapPrimitive,
    array: (_ref, items) => `List<${items}>`,
    model: (r) => className(r.name),
    enum: (r) => resolveEnumName(r.name),
    union: (r, variants) => joinUnionVariants(r, variants),
    nullable: (_ref, inner) => (inner.endsWith('?') ? inner : `${inner}?`),
    literal: (r) => {
      if (r.value === null) return 'Any?';
      if (typeof r.value === 'string') return 'String';
      if (typeof r.value === 'number') return Number.isInteger(r.value) ? 'Long' : 'Double';
      if (typeof r.value === 'boolean') return 'Boolean';
      return 'Any';
    },
    map: (_ref, value) => `Map<String, ${value}>`,
  });
}

/**
 * Map an IR TypeRef to a nullable Kotlin type expression (always appends `?`).
 * Useful for optional fields on models / request options.
 */
export function mapTypeRefOptional(ref: TypeRef): string {
  const baseType = mapTypeRef(ref);
  return baseType.endsWith('?') ? baseType : `${baseType}?`;
}

/**
 * Is the given IR TypeRef a primitive value? Useful when deciding whether a
 * nullable field needs an explicit `= null` default.
 */
export function isValueTypeRef(ref: TypeRef): boolean {
  if (ref.kind === 'enum') return true;
  if (ref.kind === 'primitive') {
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
  if (ref.format === 'binary') return 'ByteArray';
  if (ref.format === 'int32') return 'Int';
  if (ref.format === 'int64') return 'Long';
  if (ref.format === 'date-time') return 'OffsetDateTime';
  switch (ref.type) {
    case 'string':
      return 'String';
    case 'integer':
      return 'Long';
    case 'number':
      return 'Double';
    case 'boolean':
      return 'Boolean';
    case 'unknown':
      return 'Any';
  }
}

/**
 * Track discriminated unions so the model generator can emit the appropriate
 * Jackson `@JsonTypeInfo` / `@JsonSubTypes` annotations on the sealed parent.
 */
export const discriminatedUnions = new Map<
  string,
  { property: string; mapping: Record<string, string>; variantTypes: string[] }
>();

function joinUnionVariants(ref: UnionType, variants: string[]): string {
  if (ref.compositionKind === 'allOf') {
    return variants[0] ?? 'Any';
  }
  const unique = [...new Set(variants)];

  // Register discriminated unions BEFORE the single-unique collapse so we
  // don't lose the dispatcher when every variant aliases to the same canonical
  // type. The base type used at the call site is the IR variant name, which
  // matches how the dispatcher infrastructure looks up registered unions.
  if (ref.discriminator && ref.discriminator.mapping) {
    const irVariantNames = ref.variants
      .filter((v) => v.kind === 'model')
      .map((v) => (v.kind === 'model' ? v.name : ''))
      .filter(Boolean);
    const baseName = irVariantNames[0] ?? unique[0];
    discriminatedUnions.set(baseName, {
      property: ref.discriminator.property,
      mapping: ref.discriminator.mapping,
      variantTypes: unique,
    });
    // Use the base sealed type; Jackson @JsonTypeInfo handles variant selection.
    return baseName;
  }

  if (unique.length === 1) return unique[0];

  // Non-discriminated unions fall back to the Kotlin top type. A generic
  // AnyOf<> is planned for a future phase if emitter tests prove it necessary.
  return 'Any';
}

/** Kotlin imports implied by a given type expression. Caller collects into a set. */
export function implicitImportsFor(kotlinType: string): string[] {
  const imports: string[] = [];
  if (/\bOffsetDateTime\b/.test(kotlinType)) {
    imports.push('java.time.OffsetDateTime');
  }
  return imports;
}
