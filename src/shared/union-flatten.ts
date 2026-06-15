import type { Model, Field, TypeRef, UnionType } from '@workos/oagen';

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
 */
export function flattenDiscriminatedUnionFields(models: Model[]): Model[] {
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
    mergedFieldsByCanonical.set(canonical, mergeVariantFields(variantModels as Model[], union.discriminator.property));
    return canonical;
  }

  /** Rewrite a TypeRef, collapsing flattenable unions to a canonical model ref. */
  function rewriteRef(ref: TypeRef): TypeRef {
    switch (ref.kind) {
      case 'union': {
        const canonical = planUnion(ref);
        return canonical ? { kind: 'model', name: canonical } : ref;
      }
      case 'nullable':
        return { kind: 'nullable', inner: rewriteRef(ref.inner) };
      case 'array':
        return { kind: 'array', items: rewriteRef(ref.items) };
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
      if (!defByName.has(field.name)) {
        defByName.set(field.name, field);
        order.push(field.name);
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
