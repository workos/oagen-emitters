import type { TypeRef, PrimitiveType, UnionType } from '@workos/oagen';
import { mapTypeRef as irMapTypeRef } from '@workos/oagen';
import { className } from './naming.js';
import { unionWrapperName } from './unions.js';

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
      // Slices, maps, and pointer types (models) don't get pointer-wrapped:
      // nil slice/map + omitempty already handles absence, and double-pointers
      // are confusing at the call site.
      if (inner.startsWith('*') || inner.startsWith('[]') || inner.startsWith('map[')) return inner;
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
    nullable: (_ref, inner) => {
      if (inner.startsWith('*') || inner.startsWith('[]') || inner.startsWith('map[')) return inner;
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
  // A discriminated union of named variants becomes a sealed wrapper struct
  // (see unions.ts). Checked before the single-variant collapse below so a
  // one-member union still gets the wrapper, which makes adding a second
  // member later a purely additive change to the generated SDK.
  const wrapper = unionWrapperName(_ref);
  if (wrapper) return `*${wrapper}`;

  const unique = [...new Set(variants)];
  if (unique.length === 1) return unique[0];
  // Discriminated unions no wrapper can represent — an empty mapping, or a
  // variant that isn't a named model. Widen to the first model variant, which
  // at least keeps one arm typed. Non-discriminated heterogeneous unions fall
  // through to interface{}.
  if (_ref.discriminator && _ref.discriminator.mapping) {
    const resolverName = unionResolverName(_ref);
    if (resolverName) return resolverName;
  }
  return 'interface{}';
}

/**
 * Fallback public type for a discriminated union that {@link unionWrapperName}
 * cannot wrap — the discriminator resolved but carries no mapping, or a variant
 * isn't a named model. Treat the union's first model variant as the public
 * type. Fields that exist only on later variants are lost; callers who need
 * them can json.Unmarshal the raw payload manually.
 */
function unionResolverName(ref: UnionType): string | null {
  for (const v of ref.variants) {
    if (v.kind === 'model') return `*${className(v.name)}`;
  }
  return null;
}
