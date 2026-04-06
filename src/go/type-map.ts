import type { TypeRef, PrimitiveType, UnionType } from '@workos/oagen';
import { mapTypeRef as irMapTypeRef } from '@workos/oagen';
import { className } from './naming.js';

/**
 * Map an IR TypeRef to a Go type string.
 */
export function mapTypeRef(ref: TypeRef, asPointer = false): string {
  const base = irMapTypeRef<string>(ref, {
    primitive: mapPrimitive,
    array: (_ref, items) => `[]${items}`,
    model: (r) => `*${className(r.name)}`,
    enum: (r) => className(r.name),
    union: (_r, variants) => joinUnionVariants(_r, variants),
    nullable: (_ref, inner) => {
      // If inner is already a pointer type (model), don't double-pointer
      if (inner.startsWith('*')) return inner;
      return `*${inner}`;
    },
    literal: (r) => {
      if (r.value === null) return 'interface{}';
      if (typeof r.value === 'string') return 'string';
      if (typeof r.value === 'number') return Number.isInteger(r.value) ? 'int' : 'float64';
      if (typeof r.value === 'boolean') return 'bool';
      return 'interface{}';
    },
    map: (_ref, value) => `map[string]${value}`,
  });
  if (asPointer && !base.startsWith('*') && !base.startsWith('[]') && !base.startsWith('map[')) {
    return `*${base}`;
  }
  return base;
}

/**
 * Map an IR TypeRef to a Go type string without pointer wrapping for models.
 * Used for response type references where we don't want a double pointer.
 */
export function mapTypeRefValue(ref: TypeRef): string {
  return irMapTypeRef<string>(ref, {
    primitive: mapPrimitive,
    array: (_ref, items) => `[]${items}`,
    model: (r) => className(r.name),
    enum: (r) => className(r.name),
    union: (_r, variants) => joinUnionVariants(_r, variants),
    nullable: (_ref, inner) => `*${inner}`,
    literal: (r) => {
      if (r.value === null) return 'interface{}';
      if (typeof r.value === 'string') return 'string';
      if (typeof r.value === 'number') return Number.isInteger(r.value) ? 'int' : 'float64';
      if (typeof r.value === 'boolean') return 'bool';
      return 'interface{}';
    },
    map: (_ref, value) => `map[string]${value}`,
  });
}

function mapPrimitive(ref: PrimitiveType): string {
  if (ref.format === 'binary') return '[]byte';
  switch (ref.type) {
    case 'string':
      return 'string';
    case 'integer':
      return 'int';
    case 'number':
      return 'float64';
    case 'boolean':
      return 'bool';
    case 'unknown':
      return 'interface{}';
  }
}

function joinUnionVariants(_ref: UnionType, variants: string[]): string {
  if (_ref.compositionKind === 'allOf') {
    return variants[0] ?? 'interface{}';
  }
  const unique = [...new Set(variants)];
  if (unique.length === 1) return unique[0];
  // Go doesn't have union types; use interface{}
  return 'interface{}';
}
