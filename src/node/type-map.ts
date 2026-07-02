import type { TypeRef, PrimitiveType, UnionType } from '@workos/oagen';
import { mapTypeRef as irMapTypeRef } from '@workos/oagen';
import { wireInterfaceName } from './naming.js';
import { wireEnumName } from './options.js';

export interface MapTypeRefOpts {
  genericDefaults?: Map<string, string>;
}

/**
 * Map of enum name → inlined string-union TS source.
 *
 * Set by `index.ts` once per generation run, sourced from `spec.enums` for
 * enums that have no baseline definition in the live SDK. When populated,
 * `mapTypeRef`/`mapWireTypeRef` substitute the union directly at the
 * reference site instead of emitting a separate import — this collapses
 * ~100 single-line enum files into inline literal types.
 */
let inlineEnumUnions: Map<string, string> = new Map();
export function setInlineEnumUnions(map: Map<string, string>): void {
  inlineEnumUnions = map;
}
export function isInlineEnum(name: string): boolean {
  return inlineEnumUnions.has(name);
}

/**
 * Optional callback that resolves an IR model name to its live-SDK interface
 * name. Set by `index.ts` once per run. When present, `mapTypeRef` and
 * `mapWireTypeRef` use it instead of the raw IR name in their `model:` cases
 * — keeping field-type references in sync with import statements that the
 * caller emits via the same resolver. Without this, a structural match like
 * IR `AuditLogSchemaJson` → live `AuditLogSchemaResponse` would produce
 * `schema: AuditLogSchemaJson` in the body but
 * `import type { AuditLogSchemaResponse }` in the imports, leaving
 * `AuditLogSchemaJson` unbound.
 */
let domainNameResolver: ((irName: string) => string) | null = null;
export function setDomainNameResolver(fn: ((irName: string) => string) | null): void {
  domainNameResolver = fn;
}
function resolveDomainName(irName: string): string {
  return domainNameResolver ? domainNameResolver(irName) : irName;
}

/**
 * Names of enums with a configured wire→domain value remap (see
 * NodeEmitterOptions.enumValueRemaps). Set by `index.ts` once per run. A
 * remapped enum's domain type carries the SDK-facing values while its wire
 * companion (`<Enum>Response`) carries the raw values; `mapWireTypeRef` uses
 * the companion so `*Response` interfaces describe the untranslated wire shape.
 */
let remappedEnumNames: Set<string> = new Set();
export function setRemappedEnumNames(names: Set<string>): void {
  remappedEnumNames = names;
}

/**
 * Map an IR TypeRef to a TypeScript domain type string.
 * Domain types use PascalCase model names (e.g., `Organization`).
 */
export function mapTypeRef(ref: TypeRef, opts?: MapTypeRefOpts): string {
  const genericDefaults = opts?.genericDefaults;
  return irMapTypeRef<string>(ref, {
    primitive: mapPrimitive,
    array: (_r, items) => `${parenthesizeUnion(items)}[]`,
    model: (r) => resolveDomainName(r.name) + (genericDefaults?.get(r.name) ?? ''),
    enum: (r) => inlineEnumUnions.get(r.name) ?? r.name,
    union: (r, variants) => joinUnionVariants(r, variants),
    nullable: (_r, inner) => `${inner} | null`,
    literal: (r) => (typeof r.value === 'string' ? `'${r.value}'` : String(r.value)),
    map: (_r, value) => `Record<string, ${value}>`,
  });
}

/**
 * Map an IR TypeRef to a TypeScript wire/response type string.
 * Model references get the `Response` suffix (e.g., `OrganizationResponse`).
 */
export function mapWireTypeRef(ref: TypeRef, opts?: { genericDefaults?: Map<string, string> }): string {
  const genericDefaults = opts?.genericDefaults;
  return irMapTypeRef<string>(ref, {
    primitive: mapWirePrimitive,
    array: (_r, items) => `${parenthesizeUnion(items)}[]`,
    model: (r) => wireInterfaceName(resolveDomainName(r.name)) + (genericDefaults?.get(r.name) ?? ''),
    // A remapped enum has a wire companion (`<Enum>Response`) with the raw
    // values; reference it on the wire side. Inlined enums keep their literal
    // union (they have no separate file, remapped or not).
    enum: (r) => inlineEnumUnions.get(r.name) ?? (remappedEnumNames.has(r.name) ? wireEnumName(r.name) : r.name),
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

function joinUnionVariants(ref: UnionType, variants: string[]): string {
  const unique = [...new Set(variants)];
  if (ref.compositionKind === 'allOf') {
    return unique.join(' & ');
  }
  if (unique.length === 1) return unique[0];
  return unique.join(' | ');
}

function parenthesizeUnion(type: string): string {
  return type.includes(' | ') || type.includes(' & ') ? `(${type})` : type;
}
