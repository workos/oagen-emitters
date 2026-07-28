import type { TypeRef, PrimitiveType, UnionType } from '@workos/oagen';
import { mapTypeRef as irMapTypeRef } from '@workos/oagen';
import { moduleName } from './naming.js';

export interface TypeMapOptions {
  /** PascalCase SDK namespace (ctx.namespacePascal). */
  nsPascal: string;
  /** Generic type-parameter names on the enclosing model — mapped to term(). */
  typeParamNames?: Set<string>;
}

/** Map an IR TypeRef to an Elixir typespec string. */
export function mapTypeRef(ref: TypeRef, opts: TypeMapOptions): string {
  return irMapTypeRef<string>(ref, {
    primitive: mapPrimitive,
    array: (_r, items) => `[${items}]`,
    model: (r) => (opts.typeParamNames?.has(r.name) ? 'term()' : `${opts.nsPascal}.${moduleName(r.name)}.t()`),
    enum: (r) => `${opts.nsPascal}.${moduleName(r.name)}.t()`,
    union: (r, variants) => joinUnion(r, variants),
    nullable: (_r, inner) => addNil(inner),
    literal: (r) => mapLiteral(r.value),
    map: (_r, value, key) => `%{optional(${key ?? 'String.t()'}) => ${value}}`,
  });
}

/** Append `| nil` unless the spec already admits nil. */
export function addNil(spec: string): string {
  if (spec === 'nil' || spec === 'term()' || spec.split(' | ').includes('nil')) return spec;
  return `${spec} | nil`;
}

function mapPrimitive(ref: PrimitiveType): string {
  if (ref.format === 'binary') return 'binary()';
  switch (ref.type) {
    case 'string':
      return 'String.t()';
    case 'integer':
      return 'integer()';
    case 'number':
      return 'number()';
    case 'boolean':
      return 'boolean()';
    case 'unknown':
      return 'term()';
  }
}

function mapLiteral(value: string | number | boolean | null): string {
  if (value === null) return 'nil';
  if (typeof value === 'string') return 'String.t()';
  if (typeof value === 'boolean') return `${value}`;
  return `${value}`;
}

function joinUnion(ref: UnionType, variants: string[]): string {
  if (ref.compositionKind === 'allOf') return variants[0] ?? 'term()';
  const unique = [...new Set(variants)];
  if (unique.length === 0) return 'term()';
  if (unique.includes('term()')) return 'term()';
  return unique.join(' | ');
}
