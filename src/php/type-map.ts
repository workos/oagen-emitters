import type { TypeRef, PrimitiveType, UnionType } from '@workos/oagen';
import { mapTypeRef as irMapTypeRef } from '@workos/oagen';
import { className, enumClassName } from './naming.js';

/**
 * Map an IR TypeRef to a PHP native type hint string.
 */
export function mapTypeRef(ref: TypeRef): string {
  return irMapTypeRef<string>(ref, {
    primitive: mapPrimitive,
    array: (_ref, _items) => 'array',
    model: (r) => className(r.name),
    enum: (r) => enumClassName(r.name),
    union: (r, variants) => joinUnionVariants(r, variants),
    nullable: (_ref, inner) => `?${inner}`,
    literal: (r) =>
      typeof r.value === 'string'
        ? 'string'
        : r.value === null
          ? 'null'
          : typeof r.value === 'boolean'
            ? 'bool'
            : typeof r.value === 'number'
              ? Number.isInteger(r.value)
                ? 'int'
                : 'float'
              : 'string',
    map: (_ref, _value) => 'array',
  });
}

/**
 * Map an IR TypeRef to a PHPDoc type string (more expressive than native hints).
 */
export function mapTypeRefDoc(ref: TypeRef): string {
  return irMapTypeRef<string>(ref, {
    primitive: mapPrimitive,
    array: (_ref, items) => `array<${items}>`,
    model: (r) => className(r.name),
    enum: (r) => enumClassName(r.name),
    union: (r, variants) => joinUnionVariants(r, variants),
    nullable: (_ref, inner) => `${inner}|null`,
    literal: (r) => (typeof r.value === 'string' ? `'${r.value}'` : r.value === null ? 'null' : String(r.value)),
    map: (_ref, value) => `array<string, ${value}>`,
  });
}

function mapPrimitive(ref: PrimitiveType): string {
  if (ref.format === 'date-time') return '\\DateTimeImmutable';
  if (ref.format === 'binary') return 'string';
  switch (ref.type) {
    case 'string':
      return 'string';
    case 'integer':
      return 'int';
    case 'number':
      return 'float';
    case 'boolean':
      return 'bool';
    case 'unknown':
      return 'mixed';
  }
}

function joinUnionVariants(ref: UnionType, variants: string[]): string {
  if (ref.compositionKind === 'allOf') {
    return variants[0] ?? 'mixed';
  }
  const unique = [...new Set(variants)];
  if (unique.length === 1) return unique[0];
  return unique.join('|');
}
