import type { Field, Model, TypeRef } from '@workos/oagen';

/**
 * How an emitter's fixture builder sees the world, so a spec example can be
 * fitted to the exact shape that builder produces.
 */
export interface ExampleConformer {
  modelMap: Map<string, Model>;
  /** The fixture a model-typed value gets when it carries no example of its own. */
  buildModel: (model: Model) => Record<string, unknown>;
  /** The JSON key the builder writes for a field name (Node re-cases it). */
  wireKey?: (fieldName: string) => string;
  /** Per-field touch-up of a leaf example after conforming (Python's date precision). */
  normalize?: (field: Field, value: unknown) => unknown;
}

/**
 * Fit a spec example to the shape the generated model can round-trip.
 *
 * A scalar example is copied as-is, but a whole-object example is hand-written
 * in the spec and drifts from the schema it illustrates: the data-integrations
 * list response carried camelCase duplicates (`createdAt` beside `created_at`)
 * that models collapse into one field, and the finish-connection example
 * omitted nullable fields a serializer always emits, so a decode → encode
 * round trip could never reproduce the fixture. For a model-typed value, build
 * the object the way a field without an example is built, then overlay the
 * example's values for the fields that object declares: unknown keys are
 * dropped, missing fields keep their generated value, nested objects, array
 * items and map values recurse. Anything else is left to the example.
 *
 * Every emitter that copies `field.example` into a fixture goes through this,
 * so the rule is the same everywhere; an emitter that drops model-shaped
 * examples outright (Rust) needs nothing from it.
 */
export function conformExample(ref: TypeRef, example: unknown, conformer: ExampleConformer): unknown {
  switch (ref.kind) {
    case 'nullable':
      return example === null ? null : conformExample(ref.inner, example, conformer);
    case 'model': {
      const nested = conformer.modelMap.get(ref.name);
      if (!nested || !isPlainObject(example)) return example;
      return overlayExample(nested, example, conformer);
    }
    case 'array':
      return Array.isArray(example) ? example.map((item) => conformExample(ref.items, item, conformer)) : example;
    case 'map':
      return isPlainObject(example)
        ? Object.fromEntries(
            Object.entries(example).map(([key, value]) => [key, conformExample(ref.valueType, value, conformer)]),
          )
        : example;
    default:
      return example;
  }
}

/**
 * Models whose example is being overlaid right now, outermost first. The
 * builder re-enters this module for every nested field that carries an
 * example, so a self-referential model (`Tree.child: Tree` with an example on
 * `child`) would otherwise rebuild itself forever: overlay → build → the same
 * field's example → overlay → … Module state rather than a parameter because
 * each emitter's builder constructs its own conformer on re-entry.
 */
const overlaying = new Set<string>();

/**
 * `model`'s generated fixture with `example`'s values laid over the fields it
 * keeps. An occurrence of a model already being overlaid further up the stack
 * is copied as-is instead — the finite example, exactly what every builder
 * did before — so recursion ends where the example does.
 */
export function overlayExample(
  model: Model,
  example: Record<string, unknown>,
  conformer: ExampleConformer,
): Record<string, unknown> {
  if (overlaying.has(model.name)) return example;
  overlaying.add(model.name);
  try {
    const base = conformer.buildModel(model);
    const wireKey = conformer.wireKey ?? ((name: string) => name);
    const normalize = conformer.normalize ?? ((_field: Field, value: unknown) => value);

    // The fields that can stand behind `base`: the model's own and, for a
    // discriminated union, its first mapped variant's — a builder either makes
    // the union's fixture from that variant alone or folds the variant's extra
    // fields in. `key in base` decides what is actually overlaid, so a wire key
    // the builder dropped (a camelCase twin collapsed onto its snake_case field)
    // is ignored, and the discriminator the builder pinned is never touched.
    const fields = [...model.fields];
    const variantName = model.discriminator ? Object.entries(model.discriminator.mapping)[0]?.[1] : undefined;
    const variant = variantName ? conformer.modelMap.get(variantName) : undefined;
    if (variant && variant !== model) fields.push(...variant.fields);
    const discriminatorKey = model.discriminator ? wireKey(model.discriminator.property) : undefined;

    const seen = new Set<string>();
    for (const field of fields) {
      const key = wireKey(field.name);
      if (seen.has(key)) continue;
      seen.add(key);
      if (key === discriminatorKey) continue;
      if (!(key in base) || !(key in example)) continue;
      base[key] = normalize(field, conformExample(field.type, example[key], conformer));
    }
    return base;
  } finally {
    overlaying.delete(model.name);
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
