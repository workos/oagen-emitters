import type { TypeRef, PrimitiveType, UnionType } from '@workos/oagen';
import { mapTypeRef as irMapTypeRef } from '@workos/oagen';
import { className } from './naming.js';

/**
 * Map an IR TypeRef to a Ruby YARD doc type string.
 * Ruby is dynamically typed, so these are used only in YARD comments.
 */
export function mapTypeRef(ref: TypeRef): string {
  return irMapTypeRef<string>(ref, {
    primitive: mapPrimitive,
    array: (ref, items) => {
      void ref;
      return `Array<${items}>`;
    },
    model: (r) => `WorkOS::${className(r.name)}`,
    enum: (r) => `WorkOS::Types::${className(r.name)}`,
    union: (r, variants) => joinUnionVariants(r, variants),
    nullable: (ref, inner) => {
      void ref;
      return inner;
    },
    literal: (r) => (typeof r.value === 'string' ? 'String' : r.value === null ? 'nil' : typeof r.value),
    map: (ref, value) => {
      void ref;
      return `Hash{String => ${value}}`;
    },
  });
}

/**
 * Map an IR TypeRef to a more verbose Ruby-compatible type string for documentation.
 * Includes `nil` for nullable types (YARD convention: `[Foo, nil]`).
 */
export function mapTypeRefForYard(ref: TypeRef): string {
  return irMapTypeRef<string>(ref, {
    primitive: mapPrimitive,
    array: (ref, items) => {
      void ref;
      return `Array<${items}>`;
    },
    model: (r) => `WorkOS::${className(r.name)}`,
    enum: (r) => `WorkOS::Types::${className(r.name)}`,
    union: (r, variants) => joinUnionVariantsYard(r, variants),
    nullable: (ref, inner) => {
      void ref;
      // Avoid duplicate nil when inner already contains nil (e.g. from a union with a null literal).
      const parts = inner.split(', ');
      if (parts.includes('nil')) return inner;
      return `${inner}, nil`;
    },
    literal: (r) => (typeof r.value === 'string' ? 'String' : r.value === null ? 'nil' : typeof r.value),
    map: (ref, value) => {
      void ref;
      return `Hash{String => ${value}}`;
    },
  });
}

function mapPrimitive(ref: PrimitiveType): string {
  if (ref.format) {
    switch (ref.format) {
      case 'binary':
        return 'String';
    }
  }
  switch (ref.type) {
    case 'string':
      return 'String';
    case 'integer':
      return 'Integer';
    case 'number':
      return 'Float';
    case 'boolean':
      return 'Boolean';
    case 'unknown':
      return 'Object';
  }
}

function joinUnionVariants(ref: UnionType, variants: string[]): string {
  if (ref.compositionKind === 'allOf') {
    return variants[0] ?? 'Object';
  }
  const unique = [...new Set(variants)];
  if (unique.length === 1) return unique[0];
  return unique.join(', ');
}

function joinUnionVariantsYard(ref: UnionType, variants: string[]): string {
  if (ref.compositionKind === 'allOf') {
    return variants[0] ?? 'Object';
  }
  const unique = [...new Set(variants)];
  if (unique.length === 1) return unique[0];
  return unique.join(', ');
}
