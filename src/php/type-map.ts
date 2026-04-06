import type { TypeRef, PrimitiveType, UnionType } from '@workos/oagen';
import { mapTypeRef as irMapTypeRef } from '@workos/oagen';
import { className } from './naming.js';

/**
 * Map an IR TypeRef to a PHP type hint string.
 */
export function mapTypeRef(ref: TypeRef, opts?: { qualified?: boolean }): string {
  const qualify = opts?.qualified ?? false;
  const prefix = qualify ? '\\WorkOS\\Resource\\' : '';
  return irMapTypeRef<string>(ref, {
    primitive: mapPrimitive,
    array: (_ref, _items) => 'array',
    model: (r) => `${prefix}${className(r.name)}`,
    enum: (r) => `${prefix}${className(r.name)}`,
    union: (r, variants) => joinUnionVariants(r, variants),
    nullable: (_ref, inner) => `?${inner}`,
    literal: (r) => (typeof r.value === 'number' ? (Number.isInteger(r.value) ? 'int' : 'float') : 'string'),
    map: (_ref, _value) => 'array',
  });
}

/**
 * Map an IR TypeRef to a PHPDoc type string for richer documentation.
 * Uses fully-qualified names (leading \) so types resolve correctly
 * regardless of the namespace the docblock appears in.
 */
export function mapTypeRefForPHPDoc(ref: TypeRef, opts?: { prefix?: string }): string {
  const prefix = opts?.prefix ?? '\\WorkOS\\Resource\\';
  return irMapTypeRef<string>(ref, {
    primitive: mapPrimitiveDoc,
    array: (_ref, items) => `array<${items}>`,
    model: (r) => `${prefix}${className(r.name)}`,
    enum: (r) => `${prefix}${className(r.name)}`,
    union: (r, variants) => joinDocUnionVariants(r, variants),
    nullable: (_ref, inner) => `${inner}|null`,
    literal: (r) => (typeof r.value === 'string' ? 'string' : typeof r.value === 'number' ? 'int' : 'string'),
    map: (_ref, value) => `array<string, ${value}>`,
  });
}

function mapPrimitive(ref: PrimitiveType): string {
  if (ref.format === 'date-time') return '\\DateTimeImmutable';
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

function mapPrimitiveDoc(ref: PrimitiveType): string {
  if (ref.format === 'date-time') return '\\DateTimeImmutable';
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

function joinDocUnionVariants(ref: UnionType, variants: string[]): string {
  if (ref.compositionKind === 'allOf') {
    return variants[0] ?? 'mixed';
  }
  const unique = [...new Set(variants)];
  if (unique.length === 1) return unique[0];
  return unique.join('|');
}
