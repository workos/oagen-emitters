import type { TypeRef, UnionType } from '@workos/oagen';
import { typeName } from './naming.js';

/**
 * Lightweight registry that synthesises a named Rust enum for every IR union
 * encountered in field positions. Models reference the synthesised name; the
 * generator emits the enum bodies into a separate module so the crate stays
 * self-contained.
 */
export class UnionRegistry {
  private byKey = new Map<string, { name: string; tag?: string; arms: { name: string; type: string }[] }>();
  private hintCounts = new Map<string, number>();

  /** Total number of registered unions (used by callers to skip emit). */
  size(): number {
    return this.byKey.size;
  }

  /** Drop all collected unions. Call at the start of every emit run. */
  reset(): void {
    this.byKey.clear();
    this.hintCounts.clear();
  }

  /**
   * Register a union and return the Rust type name to reference.  Unions with
   * identical structure (same variants + discriminator) are deduplicated.
   */
  register(union: UnionType, hint: string): string {
    const variants = arms(union);
    const key = JSON.stringify({
      variants: variants.map((v) => v.type),
      discriminator: union.discriminator?.property ?? null,
      mapping: union.discriminator?.mapping ?? null,
    });
    const existing = this.byKey.get(key);
    if (existing) return existing.name;

    const name = this.uniqueName(`${typeName(hint)}OneOf`);
    this.byKey.set(key, {
      name,
      tag: union.discriminator?.property,
      arms: variants,
    });
    return name;
  }

  /**
   * Render every registered union as a Rust source file (including a leading
   * `use serde::...;` line).
   */
  render(): string {
    if (this.byKey.size === 0) return '';
    const blocks: string[] = [];
    blocks.push('#[allow(unused_imports)]');
    blocks.push('use super::*;');
    blocks.push('#[allow(unused_imports)]');
    blocks.push('use crate::enums::*;');
    blocks.push('use serde::{Deserialize, Serialize};');
    blocks.push('');

    for (const u of this.byKey.values()) {
      blocks.push('#[derive(Debug, Clone, Serialize, Deserialize)]');
      if (u.tag) {
        blocks.push(`#[serde(tag = ${JSON.stringify(u.tag)})]`);
      } else {
        blocks.push('#[serde(untagged)]');
      }
      blocks.push(`pub enum ${u.name} {`);
      for (const a of u.arms) {
        const single = `    ${a.name}(${a.type}),`;
        if (single.length <= 100) {
          blocks.push(single);
        } else {
          // Match rustfmt's break-shape for over-long tuple variants:
          //   Variant(
          //       LongType,
          //   ),
          blocks.push(`    ${a.name}(`);
          blocks.push(`        ${a.type},`);
          blocks.push('    ),');
        }
      }
      blocks.push('}');
      blocks.push('');
    }

    return blocks.join('\n').replace(/\n+$/g, '\n');
  }

  private uniqueName(base: string): string {
    const taken = new Set(Array.from(this.byKey.values()).map((u) => u.name));
    if (!taken.has(base)) return base;
    const n = (this.hintCounts.get(base) ?? 1) + 1;
    this.hintCounts.set(base, n);
    return `${base}${n}`;
  }
}

/**
 * Map an IR `TypeRef` to a Rust type expression (e.g., `String`, `Vec<u32>`,
 * `Option<HashMap<String, serde_json::Value>>`).
 *
 * The caller decides whether to wrap the result in `Option<...>` based on the
 * field's `required` flag — `mapTypeRef` itself only emits `Option` for the
 * `nullable` IR variant.
 *
 * When `ctx.registry` is supplied, encountered unions are registered as
 * synthesised Rust enums (using `ctx.hint` to name the generated type); when
 * no registry is provided, unions degrade to `serde_json::Value`.
 */
export function mapTypeRef(ref: TypeRef, ctx?: { hint?: string; registry?: UnionRegistry }): string {
  switch (ref.kind) {
    case 'primitive':
      return primitiveType(ref.type, ref.format);
    case 'array':
      return `Vec<${mapTypeRef(ref.items, ctx)}>`;
    case 'model':
      return typeName(ref.name);
    case 'enum':
      return typeName(ref.name);
    case 'nullable':
      return `Option<${mapTypeRef(ref.inner, ctx)}>`;
    case 'literal':
      return literalType(ref.value);
    case 'map':
      return `std::collections::HashMap<String, ${mapTypeRef(ref.valueType, ctx)}>`;
    case 'union': {
      const variants = ref.variants;
      const mapped = variants.map((v) => mapTypeRef(v, ctx));
      const unique = Array.from(new Set(mapped));
      if (unique.length === 1) return unique[0]!;
      if (ctx?.registry && ctx.hint) {
        return ctx.registry.register(ref, ctx.hint);
      }
      return 'serde_json::Value';
    }
  }
}

/** Variants for the registry: each gets a Rust variant name + a payload type. */
function arms(union: UnionType): { name: string; type: string }[] {
  const seen = new Set<string>();
  const out: { name: string; type: string }[] = [];
  for (const v of union.variants) {
    const t = mapTypeRef(v); // No registry — variants must already be named.
    const armName = variantArmName(v, t);
    let unique = armName;
    let n = 1;
    while (seen.has(unique)) {
      n += 1;
      unique = `${armName}${n}`;
    }
    seen.add(unique);
    out.push({ name: unique, type: t });
  }
  return out;
}

function variantArmName(ref: TypeRef, mappedType: string): string {
  if (ref.kind === 'model' || ref.kind === 'enum') return typeName(ref.name);
  // Strip generics for arm naming and PascalCase.
  const base = mappedType.replace(/[<>:,\s]/g, '');
  return typeName(base);
}

/**
 * Wrap a type in `Option<...>` if not already optional. Used for non-required
 * fields where the IR did not produce a `nullable` wrapper.
 */
export function makeOptional(rustType: string): string {
  if (rustType.startsWith('Option<')) return rustType;
  return `Option<${rustType}>`;
}

function primitiveType(type: 'string' | 'integer' | 'number' | 'boolean' | 'unknown', format?: string): string {
  switch (type) {
    case 'string':
      if (format === 'binary') return 'Vec<u8>';
      return 'String';
    case 'integer':
      if (format === 'int32') return 'i32';
      return 'i64';
    case 'number':
      if (format === 'float') return 'f32';
      return 'f64';
    case 'boolean':
      return 'bool';
    case 'unknown':
      return 'serde_json::Value';
  }
}

function literalType(value: string | number | boolean | null): string {
  if (value === null) return 'serde_json::Value';
  if (typeof value === 'string') return 'String';
  if (typeof value === 'number') return Number.isInteger(value) ? 'i64' : 'f64';
  if (typeof value === 'boolean') return 'bool';
  return 'serde_json::Value';
}
