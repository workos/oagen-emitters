import type { TypeRef, UnionType, EmitterContext } from '@workos/oagen';
import { escapeString, fullModuleName, nsPascal } from './naming.js';

/**
 * Shared wire↔struct casting expression builders, used by model `from_map/1` /
 * `to_map/1` bodies and by resource response handling. All emitted expressions
 * lean on the generated `{Namespace}.Cast` helpers, which are nil-safe and
 * pass through unexpected shapes unchanged (lenient casting).
 */
export interface CastNames {
  /** Names of models that actually have a generated module. */
  modelNames: Set<string>;
  /** Names of enums that actually have a generated module. */
  enumNames: Set<string>;
  /** Generic type-parameter names on the enclosing model (cast as passthrough). */
  typeParamNames?: Set<string>;
}

function knownModel(name: string, names: CastNames): boolean {
  return names.modelNames.has(name) && !names.typeParamNames?.has(name);
}

/** Expression casting a wire value (`accessor`) into its struct/atom form. */
export function castExpr(ref: TypeRef, accessor: string, ctx: EmitterContext, names: CastNames): string {
  const ns = nsPascal(ctx);
  switch (ref.kind) {
    case 'primitive':
    case 'literal':
      return accessor;
    case 'nullable':
      return castExpr(ref.inner, accessor, ctx, names);
    case 'model':
      if (!knownModel(ref.name, names)) return accessor;
      return `${ns}.Cast.nested(${accessor}, &${fullModuleName(ctx, ref.name)}.from_map/1)`;
    case 'enum':
      if (!names.enumNames.has(ref.name)) return accessor;
      return `${ns}.Cast.enum(${accessor}, &${fullModuleName(ctx, ref.name)}.cast/1)`;
    case 'array': {
      const fun = casterFun(ref.items, ctx, names);
      return fun ? `${ns}.Cast.list(${accessor}, ${fun})` : accessor;
    }
    case 'map': {
      const fun = casterFun(ref.valueType, ctx, names);
      return fun ? `${ns}.Cast.map_values(${accessor}, ${fun})` : accessor;
    }
    case 'union':
      return unionCast(ref, accessor, ctx, names);
  }
}

/**
 * Function literal casting one wire item, for use inside `Cast.list/2` and
 * `Cast.map_values/2`. Returns null when the item needs no casting.
 */
export function casterFun(ref: TypeRef, ctx: EmitterContext, names: CastNames): string | null {
  const ns = nsPascal(ctx);
  switch (ref.kind) {
    case 'model':
      if (!knownModel(ref.name, names)) return null;
      return `&${fullModuleName(ctx, ref.name)}.from_map/1`;
    case 'enum':
      if (!names.enumNames.has(ref.name)) return null;
      return `&${fullModuleName(ctx, ref.name)}.cast/1`;
    case 'nullable':
      return casterFun(ref.inner, ctx, names);
    case 'array': {
      const inner = casterFun(ref.items, ctx, names);
      return inner ? `fn items -> ${ns}.Cast.list(items, ${inner}) end` : null;
    }
    case 'map': {
      const inner = casterFun(ref.valueType, ctx, names);
      return inner ? `fn map -> ${ns}.Cast.map_values(map, ${inner}) end` : null;
    }
    case 'union': {
      const cast = unionCast(ref, 'value', ctx, names);
      return cast === 'value' ? null : `fn value -> ${cast} end`;
    }
    default:
      return null;
  }
}

function unionCast(ref: UnionType, accessor: string, ctx: EmitterContext, names: CastNames): string {
  const ns = nsPascal(ctx);
  if (ref.compositionKind === 'allOf' && ref.variants.length > 0) {
    return castExpr(ref.variants[0], accessor, ctx, names);
  }
  const disc = ref.discriminator;
  if (disc) {
    const entries = Object.entries(disc.mapping)
      .filter(([, modelName]) => knownModel(modelName, names))
      .map(([value, modelName]) => `"${escapeString(value)}" => &${fullModuleName(ctx, modelName)}.from_map/1`);
    if (entries.length > 0) {
      return `${ns}.Cast.discriminated(${accessor}, "${escapeString(disc.property)}", %{${entries.join(', ')}})`;
    }
  }
  return accessor;
}

/** Expression dumping a struct/atom value (`accessor`) back into wire form. */
export function dumpExpr(ref: TypeRef, accessor: string, ctx: EmitterContext, names: CastNames): string {
  const ns = nsPascal(ctx);
  switch (ref.kind) {
    case 'primitive':
    case 'literal':
      return accessor;
    case 'nullable':
      return dumpExpr(ref.inner, accessor, ctx, names);
    case 'model':
      if (!knownModel(ref.name, names)) return accessor;
      return `${ns}.Cast.dump_struct(${accessor}, &${fullModuleName(ctx, ref.name)}.to_map/1)`;
    case 'enum':
      if (!names.enumNames.has(ref.name)) return accessor;
      return `${ns}.Cast.enum(${accessor}, &${fullModuleName(ctx, ref.name)}.dump/1)`;
    case 'array': {
      const fun = dumperFun(ref.items, ctx, names);
      return fun ? `${ns}.Cast.list(${accessor}, ${fun})` : accessor;
    }
    case 'map': {
      const fun = dumperFun(ref.valueType, ctx, names);
      return fun ? `${ns}.Cast.map_values(${accessor}, ${fun})` : accessor;
    }
    case 'union':
      // Unions are dumped as-is; discriminated variants are already wire-shaped
      // when they were never cast, and struct inputs are a caller error.
      return accessor;
  }
}

function dumperFun(ref: TypeRef, ctx: EmitterContext, names: CastNames): string | null {
  const ns = nsPascal(ctx);
  switch (ref.kind) {
    case 'model':
      if (!knownModel(ref.name, names)) return null;
      return `fn item -> ${ns}.Cast.dump_struct(item, &${fullModuleName(ctx, ref.name)}.to_map/1) end`;
    case 'enum':
      if (!names.enumNames.has(ref.name)) return null;
      return `&${fullModuleName(ctx, ref.name)}.dump/1`;
    case 'nullable':
      return dumperFun(ref.inner, ctx, names);
    case 'array': {
      const inner = dumperFun(ref.items, ctx, names);
      return inner ? `fn items -> ${ns}.Cast.list(items, ${inner}) end` : null;
    }
    case 'map': {
      const inner = dumperFun(ref.valueType, ctx, names);
      return inner ? `fn map -> ${ns}.Cast.map_values(map, ${inner}) end` : null;
    }
    default:
      return null;
  }
}
