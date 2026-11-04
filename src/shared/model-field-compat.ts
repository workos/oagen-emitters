import type { EmitterContext, Field, Model } from '@workos/oagen';

/** Required field positions from a shipped model, pinned when a schema relaxes a field. */
export function preservedModelFields(modelName: string, ctx: EmitterContext): string[] {
  const configured = ctx.emitterOptions?.modelRequiredFieldOrder as Record<string, string[]> | undefined;
  return configured?.[modelName] ?? [];
}

export function isPreservedModelField(modelName: string, fieldName: string, ctx: EmitterContext): boolean {
  return preservedModelFields(modelName, ctx).includes(fieldName);
}

export function orderModelFields(modelName: string, fields: Field[], ctx: EmitterContext): Field[] {
  const prior = preservedModelFields(modelName, ctx);
  const byName = new Map(fields.map((field) => [field.name, field]));
  const pinned = prior.flatMap((name) => {
    const field = byName.get(name);
    return field ? [field] : [];
  });
  const remaining = fields.filter((field) => !prior.includes(field.name));
  return [...pinned, ...remaining.filter((field) => field.required), ...remaining.filter((field) => !field.required)];
}

/** Alias equivalence must include compatibility settings for fields present in the model. */
export function modelFieldCompatibilityHash(model: Model, ctx: EmitterContext): string {
  const names = new Set(model.fields.map((field) => field.name));
  const prior = preservedModelFields(model.name, ctx).filter((name) => names.has(name));
  return prior.length ? `|modelRequiredFieldOrder:${JSON.stringify(prior)}` : '';
}
