import type { TypeRef, PrimitiveType, UnionType } from '@workos/oagen';
import { mapTypeRef as irMapTypeRef } from '@workos/oagen';

/**
 * Map an IR TypeRef to a Python type hint string.
 * Uses standard library types: str, int, float, bool, List, Dict, Optional, Union.
 */
export function mapTypeRef(ref: TypeRef): string {
  return irMapTypeRef<string>(ref, {
    primitive: mapPrimitive,
    array: (_r, items) => `List[${items}]`,
    model: (r) => `"${r.name}"`,
    enum: (r) => `"${r.name}"`,
    union: (r, variants) => joinUnionVariants(r, variants),
    nullable: (_r, inner) => `Optional[${inner}]`,
    literal: (r) =>
      typeof r.value === 'string' ? `Literal["${r.value}"]` : r.value === null ? 'None' : `Literal[${String(r.value)}]`,
    map: (_r, value) => `Dict[str, ${value}]`,
  });
}

/**
 * Map an IR TypeRef to a plain Python type string (no quotes around model/enum refs).
 * Used for import collection and direct type references.
 */
export function mapTypeRefUnquoted(ref: TypeRef): string {
  return irMapTypeRef<string>(ref, {
    primitive: mapPrimitive,
    array: (_r, items) => `List[${items}]`,
    model: (r) => r.name,
    enum: (r) => r.name,
    union: (r, variants) => joinUnionVariants(r, variants),
    nullable: (_r, inner) => `Optional[${inner}]`,
    literal: (r) =>
      typeof r.value === 'string' ? `Literal["${r.value}"]` : r.value === null ? 'None' : `Literal[${String(r.value)}]`,
    map: (_r, value) => `Dict[str, ${value}]`,
  });
}

function mapPrimitive(ref: PrimitiveType): string {
  if (ref.format) {
    switch (ref.format) {
      case 'binary':
        return 'bytes';
    }
  }
  switch (ref.type) {
    case 'string':
      return 'str';
    case 'integer':
      return 'int';
    case 'number':
      return 'float';
    case 'boolean':
      return 'bool';
    case 'unknown':
      return 'Any';
  }
}

function joinUnionVariants(ref: UnionType, variants: string[]): string {
  if (ref.compositionKind === 'allOf') {
    // Python doesn't have intersection types; use the first variant
    return variants[0] ?? 'Any';
  }
  return `Union[${variants.join(', ')}]`;
}
