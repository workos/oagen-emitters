import type { TypeRef, PrimitiveType, UnionType } from '@workos/oagen';
import { mapTypeRef as irMapTypeRef } from '@workos/oagen';
import { wireInterfaceName } from './naming.js';

export interface MapTypeRefOpts {
  stringDates?: boolean;
  /** Map from model name → default type args (e.g., `'<Record<string, unknown>>'`).
   *  When present, model refs for generic models get their defaults appended. */
  genericDefaults?: Map<string, string>;
}

/**
 * Map an IR TypeRef to a TypeScript domain type string.
 * Domain types use PascalCase model names (e.g., `Organization`).
 *
 * @param opts.stringDates - When true, map `date-time` to `string` instead of `Date`.
 *   Use this when integrating into an existing SDK that represents timestamps as
 *   ISO 8601 strings rather than Date objects.
 * @param opts.genericDefaults - When present, appends default type args to generic model refs.
 */
export function mapTypeRef(ref: TypeRef, opts?: MapTypeRefOpts): string {
  const primMapper = opts?.stringDates ? mapPrimitiveStringDates : mapPrimitive;
  const genericDefaults = opts?.genericDefaults;
  return irMapTypeRef<string>(ref, {
    primitive: primMapper,
    array: (_r, items) => `${parenthesizeUnion(items)}[]`,
    model: (r) => r.name + (genericDefaults?.get(r.name) ?? ''),
    enum: (r) => r.name,
    union: (r, variants) => joinUnionVariants(r, variants),
    nullable: (_r, inner) => `${inner} | null`,
    literal: (r) => (typeof r.value === 'string' ? `'${r.value}'` : String(r.value)),
    map: (_r, value) => `Record<string, ${value}>`,
  });
}

/**
 * Map an IR TypeRef to a TypeScript wire/response type string.
 * Model references get the `Response` suffix (e.g., `OrganizationResponse`).
 * Wire types use JSON-native types (string for date-time, number/string for int64).
 */
export function mapWireTypeRef(ref: TypeRef, opts?: { genericDefaults?: Map<string, string> }): string {
  const genericDefaults = opts?.genericDefaults;
  return irMapTypeRef<string>(ref, {
    primitive: mapWirePrimitive,
    array: (_r, items) => `${parenthesizeUnion(items)}[]`,
    model: (r) => wireInterfaceName(r.name) + (genericDefaults?.get(r.name) ?? ''),
    enum: (r) => r.name,
    union: (r, variants) => joinUnionVariants(r, variants),
    nullable: (_r, inner) => `${inner} | null`,
    literal: (r) => (typeof r.value === 'string' ? `'${r.value}'` : String(r.value)),
    map: (_r, value) => `Record<string, ${value}>`,
  });
}

function mapPrimitive(ref: PrimitiveType): string {
  if (ref.format) {
    switch (ref.format) {
      case 'date-time':
        return 'Date';
      case 'int64':
        return 'bigint';
    }
  }
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

/**
 * Map a primitive type using string representation for dates.
 * Used when the existing SDK represents timestamps as ISO 8601 strings.
 */
function mapPrimitiveStringDates(ref: PrimitiveType): string {
  if (ref.format) {
    switch (ref.format) {
      case 'int64':
        return 'bigint';
      // date-time intentionally falls through to the string case
    }
  }
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

/**
 * Map an IR PrimitiveType to a TypeScript wire/JSON type string.
 * Wire types match JSON encoding: date-time stays string, int64 stays string/number.
 */
function mapWirePrimitive(ref: PrimitiveType): string {
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

/**
 * Join union variant type strings using the appropriate operator.
 * allOf unions use `&` (intersection), oneOf/anyOf/unspecified use `|` (union).
 */
function joinUnionVariants(ref: UnionType, variants: string[]): string {
  if (ref.compositionKind === 'allOf') {
    return variants.join(' & ');
  }
  return variants.join(' | ');
}

/** Wrap union/intersection types in parentheses when used as array item type. */
function parenthesizeUnion(type: string): string {
  return type.includes(' | ') || type.includes(' & ') ? `(${type})` : type;
}
