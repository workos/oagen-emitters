import type { TypeRef, PrimitiveType, UnionType } from '@workos/oagen';
import { mapTypeRef as irMapTypeRef } from '@workos/oagen';
import { className, enumClassName } from './naming.js';

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
    enum: (r) => `${prefix}${enumClassName(r.name)}`,
    union: (r, variants) => joinUnionVariants(r, variants),
    nullable: (_ref, inner) => `?${inner}`,
    literal: (r) =>
      typeof r.value === 'number'
        ? Number.isInteger(r.value)
          ? 'int'
          : 'float'
        : typeof r.value === 'boolean'
          ? 'bool'
          : 'string',
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
    enum: (r) => `${prefix}${enumClassName(r.name)}`,
    union: (r, variants) => joinDocUnionVariants(r, variants),
    nullable: (_ref, inner) => `${inner}|null`,
    literal: (r) =>
      typeof r.value === 'string'
        ? 'string'
        : typeof r.value === 'number'
          ? 'int'
          : typeof r.value === 'boolean'
            ? 'bool'
            : 'string',
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
  // PHP type declarations forbid the `?T` nullable shorthand inside a `|`
  // union — `string|?string` is a parse error. Hoist nullability out of the
  // variants: strip a leading `?`, drop a bare `null`, then re-attach it as a
  // single `?T` (one non-null type) or trailing `|null` (several). A union of
  // `string` + nullable-`string` (e.g. from a `oneOf: [string, {string|null}]`
  // spec shape) thus collapses to `?string` instead of invalid `string|?string`.
  const { nonNull, nullable } = splitNullable(variants);
  if (nonNull.includes('mixed')) return 'mixed'; // `mixed` already permits null
  if (nonNull.length === 0) return 'null';
  if (nonNull.length === 1) return nullable ? `?${nonNull[0]}` : nonNull[0];
  return nullable ? `${nonNull.join('|')}|null` : nonNull.join('|');
}

function joinDocUnionVariants(ref: UnionType, variants: string[]): string {
  if (ref.compositionKind === 'allOf') {
    return variants[0] ?? 'mixed';
  }
  // PHPDoc tolerates `?T`, but normalize the same way for consistency and to
  // avoid redundant members (the doc nullable form is `T|null`, so split on `|`).
  const { nonNull, nullable } = splitNullable(variants.flatMap((v) => v.split('|')));
  if (nonNull.includes('mixed')) return 'mixed';
  if (nonNull.length === 0) return 'null';
  return nullable ? `${nonNull.join('|')}|null` : nonNull.join('|');
}

/**
 * Partition rendered union variants into their non-null types plus a single
 * nullability flag. Recognizes both the `?T` shorthand and a bare `null`/`'null'`
 * variant. Deduplicates the non-null types while preserving first-seen order.
 */
function splitNullable(variants: string[]): { nonNull: string[]; nullable: boolean } {
  let nullable = false;
  const nonNull: string[] = [];
  for (const v of variants) {
    if (v === 'null' || v === "'null'") {
      nullable = true;
    } else if (v.startsWith('?')) {
      nullable = true;
      nonNull.push(v.slice(1));
    } else {
      nonNull.push(v);
    }
  }
  return { nonNull: [...new Set(nonNull)], nullable };
}
