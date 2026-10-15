import type { ApiSpec, Model } from '@workos/oagen';
import { buildDirectionIndex, directionOf } from '@workos/oagen';
import { loadRawSpec } from '../shared/model-utils.js';

/** The IR drops additionalProperties; only opt in with matching raw evidence. */
export function closedRequestVariants(spec: ApiSpec): Set<string> {
  const closed = new Set<string>();
  const raw = loadRawSpec();
  if (!raw) return closed;
  const direction = buildDirectionIndex(spec);
  const deref = (schema: any): any =>
    schema?.$ref?.startsWith('#/components/schemas/')
      ? raw.components?.schemas?.[schema.$ref.slice('#/components/schemas/'.length)]
      : schema;
  for (const service of spec.services) {
    for (const op of service.operations) {
      const body = op.requestBody;
      if (body?.kind !== 'union' || body.discriminator) continue;
      const request = deref(raw.paths?.[op.path]?.[op.httpMethod]?.requestBody);
      const schema = deref(request?.content?.['application/json']?.schema);
      const variants = schema?.oneOf ?? schema?.anyOf;
      if (!variants || variants.length !== body.variants.length) continue;
      body.variants.forEach((ref, index) => {
        if (ref.kind !== 'model' || directionOf(direction, ref.name) !== 'request') return;
        const variant = deref(variants[index]);
        const model = spec.models.find((m) => m.name === ref.name);
        if (variant?.additionalProperties === false && model && matchesFields(model, variant)) closed.add(ref.name);
      });
    }
  }
  return closed;
}

function matchesFields(model: Model, schema: any): boolean {
  const names = Object.keys(schema.properties ?? {});
  return names.length === model.fields.length && model.fields.every((f) => names.includes(f.name));
}
