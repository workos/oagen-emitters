import type { Field, Model, Operation, TypeRef } from '@workos/oagen';

/**
 * The model whose fields become the operation's `*Options` properties.
 *
 * A oneOf/anyOf of object alternatives is projected onto one flat model:
 * every field of every alternative is kept, a field is required only when
 * every alternative requires it, and differing literal selectors (e.g.
 * `connection_intent: add | reauthorize`) merge into one string property.
 * A union that can't be projected fails generation instead of silently
 * emitting an empty options class whose callers would send `{}`.
 */
export function resolveRequestBodyModel(op: Operation, models: readonly Model[]): Model | undefined {
  const body = op.requestBody;
  if (body?.kind === 'model') return models.find((m) => m.name === body.name);
  if (body?.kind !== 'union') return undefined;

  const unsupported = (reason: string): never => {
    throw new Error(`.NET ${op.httpMethod.toUpperCase()} ${op.path}: unsupported request body (${reason})`);
  };
  if (body.compositionKind === 'allOf' || body.variants.length === 0) unsupported('union kind');
  const variants = body.variants.map((ref) => {
    if (ref.kind !== 'model') return unsupported(`${ref.kind} alternative`);
    const model = models.find((m) => m.name === ref.name);
    if (!model?.fields.length) return unsupported(`alternative ${ref.name} has no fields`);
    return model;
  });

  const byName = new Map<string, Field[]>();
  for (const model of variants) {
    for (const field of model.fields) byName.set(field.name, [...(byName.get(field.name) ?? []), field]);
  }
  return {
    name: variants[0].name,
    fields: [...byName.values()].map((definitions) => {
      const first = definitions[0];
      const types = [...new Map(definitions.map((f) => [wireTypeKey(f.type), f.type])).values()];
      let type = first.type;
      if (types.length > 1) {
        const literals = types.flatMap((t) => (t.kind === 'union' ? t.variants : [t]));
        if (!literals.every((t) => t.kind === 'literal' && typeof t.value === 'string')) {
          return unsupported(`conflicting types for ${first.name}`);
        }
        type = { kind: 'union', variants: [...new Map(literals.map((t) => [wireTypeKey(t), t])).values()] };
      }
      return {
        ...first,
        type,
        required: definitions.length === variants.length && definitions.every((f) => f.required),
      };
    }),
  };
}

/** Identical inline enums in separate alternatives get different names; compare their wire values. */
function wireTypeKey(type: TypeRef): string {
  if (type.kind === 'enum' && type.values) {
    return JSON.stringify({ kind: 'enum', values: [...type.values].map(String).sort() });
  }
  return JSON.stringify(type);
}
