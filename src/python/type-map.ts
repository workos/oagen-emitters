import type { TypeRef, PrimitiveType, UnionType } from '@workos/oagen';
import { mapTypeRef as irMapTypeRef } from '@workos/oagen';
import { className } from './naming.js';

/**
 * Map an IR TypeRef to a Python type hint string.
 * Uses standard library types: str, int, float, bool, List, Dict, Optional, Union.
 */
export function mapTypeRef(ref: TypeRef): string {
  return irMapTypeRef<string>(ref, {
    primitive: mapPrimitive,
    array: (ref, items) => {
      void ref;
      return `List[${items}]`;
    },
    model: (r) => `"${className(r.name)}"`,
    enum: (r) => `"${className(r.name)}"`,
    union: (r, variants) => joinUnionVariants(r, variants),
    nullable: (ref, inner) => {
      void ref;
      return `Optional[${inner}]`;
    },
    literal: (r) =>
      typeof r.value === 'string' ? `Literal["${r.value}"]` : r.value === null ? 'None' : `Literal[${String(r.value)}]`,
    map: (ref, value) => {
      void ref;
      return `Dict[str, ${value}]`;
    },
  });
}

/**
 * Map an IR TypeRef to a plain Python type string (no quotes around model/enum refs).
 * Used for import collection and direct type references.
 */
export function mapTypeRefUnquoted(ref: TypeRef, knownEnums?: Set<string>, allowRawEnumStrings = false): string {
  return irMapTypeRef<string>(ref, {
    primitive: mapPrimitive,
    array: (ref, items) => {
      void ref;
      return `List[${items}]`;
    },
    model: (r) => className(r.name),
    enum: (r) => {
      if (knownEnums && !knownEnums.has(r.name)) return 'str';
      const enumType = className(r.name);
      return allowRawEnumStrings ? `Union[${enumType}, str]` : enumType;
    },
    union: (r, variants) => joinUnionVariants(r, variants),
    nullable: (ref, inner) => {
      void ref;
      return `Optional[${inner}]`;
    },
    literal: (r) =>
      typeof r.value === 'string' ? `Literal["${r.value}"]` : r.value === null ? 'None' : `Literal[${String(r.value)}]`,
    map: (ref, value) => {
      void ref;
      return `Dict[str, ${value}]`;
    },
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
  // Deduplicate identical variants (e.g., Union[Foo, Foo] -> Foo)
  const unique = [...new Set(variants)];
  if (unique.length === 1) return unique[0];
  return `Union[${unique.join(', ')}]`;
}
