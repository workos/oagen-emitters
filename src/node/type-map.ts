import type { TypeRef, PrimitiveType } from '@workos/oagen';
import { mapTypeRef as irMapTypeRef } from '@workos/oagen';
import { wireInterfaceName } from './naming.js';

/**
 * Map an IR TypeRef to a TypeScript domain type string.
 * Domain types use PascalCase model names (e.g., `Organization`).
 */
export function mapTypeRef(ref: TypeRef): string {
  return irMapTypeRef<string>(ref, {
    primitive: mapPrimitive,
    array: (_r, items) => `${parenthesizeUnion(items)}[]`,
    model: (r) => r.name,
    enum: (r) => r.name,
    union: (_r, variants) => variants.join(' | '),
    nullable: (_r, inner) => `${inner} | null`,
    literal: (r) => (typeof r.value === 'string' ? `'${r.value}'` : String(r.value)),
    map: (_r, value) => `Record<string, ${value}>`,
  });
}

/**
 * Map an IR TypeRef to a TypeScript wire/response type string.
 * Model references get the `Response` suffix (e.g., `OrganizationResponse`).
 */
export function mapWireTypeRef(ref: TypeRef): string {
  return irMapTypeRef<string>(ref, {
    primitive: mapPrimitive,
    array: (_r, items) => `${parenthesizeUnion(items)}[]`,
    model: (r) => wireInterfaceName(r.name),
    enum: (r) => r.name,
    union: (_r, variants) => variants.join(' | '),
    nullable: (_r, inner) => `${inner} | null`,
    literal: (r) => (typeof r.value === 'string' ? `'${r.value}'` : String(r.value)),
    map: (_r, value) => `Record<string, ${value}>`,
  });
}

function mapPrimitive(ref: PrimitiveType): string {
  switch (ref.type) {
    case 'string':
      return 'string';
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'unknown':
      return 'any';
  }
}

/** Wrap union types in parentheses when used as array item type. */
function parenthesizeUnion(type: string): string {
  return type.includes(' | ') ? `(${type})` : type;
}
