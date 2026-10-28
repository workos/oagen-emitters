import type { Field, Model, Operation, TypeRef } from '@workos/oagen';

/** Project object alternatives onto PHP's named inputs without changing response models. */
export function resolveRequestBodyModel(op: Operation, models: readonly Model[]): Model | null {
  function unsupported(reason: string): never {
    throw new Error(`PHP ${op.httpMethod.toUpperCase()} ${op.path}: unsupported request body (${reason})`);
  }

  function resolve(ref: TypeRef): Model {
    if (ref.kind === 'model') {
      const model = models.find((m) => m.name === ref.name);
      if (!model) return unsupported(`unresolved model ${ref.name}`);
      if (model.discriminator && model.fields.length === 0) return unsupported(`discriminated model ${ref.name}`);
      return model;
    }
    if (ref.kind !== 'union' || ref.compositionKind === 'allOf' || ref.variants.length === 0) {
      return unsupported(ref.kind);
    }
    const variants = ref.variants.map(resolve);
    const fields = new Map<string, Field[]>();
    for (const model of variants) {
      for (const field of model.fields) {
        const definitions = fields.get(field.name) ?? [];
        definitions.push(field);
        fields.set(field.name, definitions);
      }
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

  return op.requestBody ? resolve(op.requestBody) : null;
}

function wireTypeKey(type: TypeRef): string {
  // Identical inline enums in separate alternatives can have different generated names.
  if (type.kind === 'enum' && type.values) return JSON.stringify({ kind: 'enum', values: type.values });
  return JSON.stringify(type);
}
