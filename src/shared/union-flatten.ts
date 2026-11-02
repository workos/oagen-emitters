import type { Model, Field, TypeRef, UnionType } from '@workos/oagen';

/** Options for {@link flattenDiscriminatedUnionFields}. */
export interface FlattenOptions {
  /** Return true to leave a union un-flattened (the caller emits it itself). */
  skipUnion?: (union: UnionType) => boolean;
}

/**
 * Flatten field-level discriminated unions into a single superset model for
 * the flat-emit languages (Go, Kotlin, Node) that have no native sum type.
 *
 * Background: a property like `ApiKey.owner` is a discriminated `oneOf` whose
 * variants are inline objects — `{ type: 'organization', id }` and
 * `{ type: 'user', id, organization_id }`. The IR represents this as a `union`
 * TypeRef referencing two variant models (`ApiKeyOwner`, `UserApiKeyOwner`).
 * Languages that render such a union as "the first variant" — Go's
 * `unionResolverName`, Kotlin's `baseName` — silently drop every field that
 * only exists on a later variant, so `organization_id` disappears for
 * user-scoped keys. (See the SDK compat report's owner-field note.)
 *
 * This transform, applied only by the flat-emit emitters, merges every
 * variant's fields into the first variant (the union's canonical model),
 * marks any field not shared by all variants optional, widens the
 * discriminator property to the union of its per-variant literal values, and
 * rewrites the field to a plain model ref to that canonical model. The result
 * is one flat struct/data class/interface that carries every variant field,
 * with the discriminator property telling callers which variant they hold —
 * exactly how these emitters already flatten `allOf [base, oneOf]`
 * discriminated bases (see `enrichModelsFromSpec`).
 *
 * Returns a new models array; the input models are not mutated. Union-emitting
 * languages (Python, PHP, Rust, Ruby, .NET) must NOT call this — they emit a
 * real discriminated union and lose nothing.
 *
 * `options.skipUnion` opts individual unions out of the flatten so the caller
 * can emit a real union for them instead. Go uses this for the unions it emits
 * as sealed wrappers; those keep their `union` TypeRef so the wrapper emitter
 * can still see the variants. Callers that pass nothing get the flatten for
 * every discriminated union, unchanged.
 */
export function flattenDiscriminatedUnionFields(models: Model[], options: FlattenOptions = {}): Model[] {
  const byName = new Map(models.map((m) => [m.name, m]));
  // Canonical (first-variant) model name → its merged superset field list.
  const mergedFieldsByCanonical = new Map<string, Field[]>();

  /**
   * Decide whether a union is a flat-flattenable discriminated union of inline
   * object variants. When it is, record the merged field set for its canonical
   * model and return that model's name; otherwise return null.
   */
  function planUnion(union: UnionType): string | null {
    if (!union.discriminator) return null;
    // The caller emits this one as a real union; leave the TypeRef intact.
    if (options.skipUnion?.(union)) return null;

    const variantNames = union.variants.map((v) => (v.kind === 'model' ? v.name : null));
    // Require that *every* variant is a model ref (the inline-object oneOf
    // shape). Untagged unions of primitives (e.g. AuditLogEvent actor
    // metadata: string | number | boolean) carry no discriminator and never
    // reach here, but guard anyway.
    if (variantNames.length < 2 || variantNames.some((n) => n === null)) return null;

    const variantModels = (variantNames as string[]).map((n) => byName.get(n));
    // Every variant must resolve to a concrete data model — not a discriminator
    // dispatcher (empty-field base with its own `discriminator`) and not a
    // fieldless placeholder. This keeps event-style unions out of scope.
    if (variantModels.some((m) => !m || (m as { discriminator?: unknown }).discriminator || m.fields.length === 0)) {
      return null;
    }

    const canonical = (variantNames as string[])[0];
    const merged = mergeVariantFields(variantModels as Model[], union.discriminator.property);

    // The merge map is keyed by the first-variant model name. The same union
    // referenced by several container fields re-plans to an identical merge
    // (harmless). But two *distinct* unions that share a first variant would
    // each want a different superset on that one model — pass 2 can apply only
    // one, silently dropping the other's fields. Fail loudly instead; the spec
    // must disambiguate (rename one union's leading variant).
    const existing = mergedFieldsByCanonical.get(canonical);
    if (existing && fieldListSignature(existing) !== fieldListSignature(merged)) {
      throw new Error(
        `flattenDiscriminatedUnionFields: model "${canonical}" is the first variant of two distinct ` +
          'discriminated unions that merge to different field sets. Flattening both onto one model would ' +
          'silently drop fields; disambiguate the variants in the spec (rename the leading variant of one union).',
      );
    }
    mergedFieldsByCanonical.set(canonical, merged);
    return canonical;
  }

  /** Rewrite a TypeRef, collapsing flattenable unions to a canonical model ref. */
  function rewriteRef(ref: TypeRef): TypeRef {
    switch (ref.kind) {
      case 'union': {
        const canonical = planUnion(ref);
        return canonical ? { kind: 'model', name: canonical } : ref;
      }
      case 'nullable': {
        // Preserve reference identity when nothing inside changed, so pass 1's
        // `type === field.type` check doesn't flag (and rebuild) union-free fields.
        const inner = rewriteRef(ref.inner);
        return inner === ref.inner ? ref : { kind: 'nullable', inner };
      }
      case 'array': {
        const items = rewriteRef(ref.items);
        return items === ref.items ? ref : { kind: 'array', items };
      }
      default:
        return ref;
    }
  }

  // Pass 1: rewrite container fields, recording the merges to apply in pass 2.
  const rewritten = models.map((model) => {
    let changed = false;
    const fields = model.fields.map((field) => {
      const type = rewriteRef(field.type);
      if (type === field.type) return field;
      changed = true;
      return { ...field, type };
    });
    return changed ? { ...model, fields } : model;
  });

  if (mergedFieldsByCanonical.size === 0) return models;

  // Pass 2: replace each canonical variant model with its merged superset.
  return rewritten.map((model) => {
    const merged = mergedFieldsByCanonical.get(model.name);
    return merged ? { ...model, fields: merged } : model;
  });
}

/**
 * Build the merged field list for a discriminated union's variant models.
 *
 * - A field is required only when present-and-required in *every* variant; a
 *   field missing from some variant (e.g. the user variant's `organization_id`)
 *   becomes optional.
 * - The discriminator property is widened to the union of its per-variant
 *   literal values (`'organization' | 'user'`) so it isn't pinned to the first
 *   variant's constant. (Flat-emit type maps collapse a single-typed literal
 *   union to a plain string, so this is a no-op for Go/Kotlin and a precise
 *   `'organization' | 'user'` for Node.)
 * - Field order follows the first variant, then newly-seen fields from later
 *   variants.
 */
function mergeVariantFields(variants: Model[], discriminatorProp: string): Field[] {
  const total = variants.length;
  const order: string[] = [];
  const defByName = new Map<string, Field>();
  const presence = new Map<string, number>();
  const requiredCount = new Map<string, number>();

  for (const variant of variants) {
    for (const field of variant.fields) {
      const seen = defByName.get(field.name);
      if (!seen) {
        defByName.set(field.name, field);
        order.push(field.name);
      } else if (field.name !== discriminatorProp && !sameTypeRef(seen.type, field.type)) {
        // Only the first-seen definition is kept, so a shared field whose type
        // differs across variants would be merged with the wrong type for the
        // other variants. The discriminator is exempt (it is widened below).
        throw new Error(
          `flattenDiscriminatedUnionFields: field "${field.name}" has conflicting types across variants ` +
            'of a discriminated union; a flat superset model cannot represent both. Align the field type ' +
            'across variants in the spec.',
        );
      }
      presence.set(field.name, (presence.get(field.name) ?? 0) + 1);
      if (field.required) requiredCount.set(field.name, (requiredCount.get(field.name) ?? 0) + 1);
    }
  }

  return order.map((name) => {
    const def = defByName.get(name)!;

    if (name === discriminatorProp) {
      const literals = dedupeLiteralTypes(
        variants.map((v) => v.fields.find((f) => f.name === name)?.type).filter((t): t is TypeRef => t != null),
      );
      const type: TypeRef = literals.length > 1 ? { kind: 'union', variants: literals } : (literals[0] ?? def.type);
      return { ...def, type, required: presence.get(name) === total };
    }

    const required = presence.get(name) === total && requiredCount.get(name) === total;
    return required === def.required ? def : { ...def, required };
  });
}

/** Structural equality of two TypeRefs (IR refs have a stable, deterministic shape). */
function sameTypeRef(a: TypeRef, b: TypeRef): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Stable signature of a merged field list, used to detect canonical collisions. */
function fieldListSignature(fields: Field[]): string {
  return JSON.stringify(fields.map((f) => [f.name, f.required, f.type]));
}

/** Deduplicate literal TypeRefs by value, preserving first-seen order. */
function dedupeLiteralTypes(types: TypeRef[]): TypeRef[] {
  const seen = new Set<string>();
  const out: TypeRef[] = [];
  for (const t of types) {
    const key = t.kind === 'literal' ? `lit:${String(t.value)}` : JSON.stringify(t);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}
