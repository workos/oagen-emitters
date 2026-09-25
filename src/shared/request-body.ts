import type { Field, Model, Operation, TypeRef } from '@workos/oagen';

/**
 * Project compatible object request variants onto named inputs, not onto response
 * models. Every supplied field survives serialization; the API still validates
 * branch-specific combinations. Complex unions retain the emitter's existing handling.
 */
export function resolveRequestBodyModel(op: Pick<Operation, 'requestBody'>, models: readonly Model[]): Model | null {
  function resolve(ref: TypeRef | undefined): Model | null {
    if (!ref) return null;
    // Optional whole bodies retain the emitter's native body API. Flattening
    // them would make formerly optional requests require individual fields.
    if (ref.kind === 'nullable') return null;
    if (ref.kind === 'model') return models.find((m) => m.name === ref.name) ?? null;
    if (ref.kind !== 'union' || ref.discriminator || ref.variants.length === 0) return null;
    const variants = ref.variants.map(resolve);
    if (variants.some((m) => !m || m.discriminator || m.fields.length === 0)) return null;
    const objects = variants as Model[];
    const fields = new Map<string, Field>();
    for (const model of objects) {
      for (const field of model.fields) {
        const prior = fields.get(field.name);
        if (prior && !sameWireType(prior.type, field.type)) return null;
        if (!prior) fields.set(field.name, field);
      }
    }
    return {
      name: objects[0].name,
      fields: [...fields.values()].map((field) => ({
        ...field,
        required: objects.every((m) => m.fields.some((f) => f.name === field.name && f.required)),
      })),
    };
  }
  return resolve(op.requestBody);
}

function sameWireType(a: TypeRef, b: TypeRef): boolean {
  // Inline enums in separate branches have different generated names, but the
  // same value set. Reuse the first branch's existing enum, never widen it.
  if (a.kind === 'enum' && b.kind === 'enum' && a.values && b.values) {
    return JSON.stringify(a.values) === JSON.stringify(b.values);
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

export function isRequiredConstant(field: {
  required?: boolean;
  type: TypeRef;
}): field is { required: true; type: { kind: 'literal'; value: string | number | boolean } } {
  return field.required === true && field.type.kind === 'literal' && field.type.value !== null;
}
