import type { Field, Model, Operation, TypeRef } from '@workos/oagen';

/**
 * Resolve an operation's request body to the model whose fields become the
 * method's parameters. A union of object alternatives is projected onto one
 * synthetic model: every field of every alternative is kept, a field is
 * required only when every alternative requires it, and differing literal
 * selectors (`add` / `reauthorize`) widen to a union of those literals.
 *
 * A body shape this cannot represent stops generation instead of silently
 * emitting a method that always sends `{}`.
 */
export function resolveRequestBodyModel(op: Operation, models: readonly Model[]): Model | null {
  function unsupported(reason: string): never {
    throw new Error(`Kotlin ${op.httpMethod.toUpperCase()} ${op.path}: unsupported request body (${reason})`);
  }

  function resolve(ref: TypeRef): Model {
    if (ref.kind === 'model') {
      const model = models.find((m) => m.name === ref.name);
      if (!model) return unsupported(`unresolved model ${ref.name}`);
      return model;
    }
    if (ref.kind !== 'union' || ref.compositionKind === 'allOf' || ref.discriminator || ref.variants.length === 0) {
      return unsupported(ref.kind);
    }
    const variants = ref.variants.map(resolve);
    const fields = new Map<string, Field[]>();
    for (const model of variants) {
      for (const field of model.fields) fields.set(field.name, [...(fields.get(field.name) ?? []), field]);
    }
    return {
      name: variants[0].name,
      fields: [...fields.values()].map((definitions) => {
        const first = definitions[0];
        const unique = [...new Map(definitions.map((f) => [wireTypeKey(f.type), f.type])).values()];
        let type = first.type;
        if (unique.length > 1) {
          const alternatives = unique.flatMap((t) => (t.kind === 'union' ? t.variants : [t]));
          if (!alternatives.every((t) => t.kind === 'literal' && t.value !== null)) {
            return unsupported(`conflicting types for ${first.name}`);
          }
          type = { kind: 'union', variants: [...new Map(alternatives.map((t) => [wireTypeKey(t), t])).values()] };
        }
        return {
          ...first,
          type,
          required: definitions.length === variants.length && definitions.every((f) => f.required),
        };
      }),
    };
  }

  const body = op.requestBody;
  if (!body) return null;
  // Single-model bodies keep their previous behavior (a missing model is no body).
  if (body.kind === 'model') return models.find((m) => m.name === body.name) ?? null;
  return resolve(body);
}

function wireTypeKey(type: TypeRef): string {
  // Identical inline enums in separate alternatives get different generated names.
  if (type.kind === 'enum' && type.values) return JSON.stringify({ kind: 'enum', values: type.values });
  return JSON.stringify(type);
}
