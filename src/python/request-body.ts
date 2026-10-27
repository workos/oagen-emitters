import type { ApiSpec, EmitterContext, Field, Model, Operation, TypeRef } from '@workos/oagen';
import { collectModelRefs, collectResponseHeaders } from '@workos/oagen';
import { fieldName } from './naming.js';
import { bearerOverrideScheme } from '../shared/security.js';

/** Add flat kwargs for compatible object unions without replacing the body API. */
export function unionBodyFields(op: Operation, ctx: EmitterContext): Field[] | null {
  const body = op.requestBody;
  if (
    body?.kind !== 'union' ||
    body.compositionKind === 'allOf' ||
    op.parameterGroups?.length ||
    op.pagination ||
    (op.requestBodyEncoding && op.requestBodyEncoding !== 'json')
  )
    return null;
  const variants: Model[] = [];
  for (const ref of body.variants) {
    if (ref.kind !== 'model') return null;
    const model = ctx.spec.models.find((m) => m.name === ref.name);
    if (!model?.fields.length || model.discriminator) return null;
    variants.push(model);
  }
  if (variants.length === 0) return null;
  const fields = new Map<string, Field>();
  const reserved = new Set([
    'self',
    'body',
    'request_options',
    'idempotency_key',
    '_body',
    ...op.queryParams.map((p) => fieldName(p.name)),
  ]);
  const bearerOverride = bearerOverrideScheme(op);
  if (bearerOverride !== null) reserved.add(fieldName(bearerOverride));
  const names = new Set<string>();
  for (const model of variants) {
    for (const field of model.fields) {
      const name = fieldName(field.name);
      // Ambiguous kwargs must retain the existing body-only API.
      if (reserved.has(name) || op.pathParams.some((p) => fieldName(p.name) === name)) return null;
      const prior = fields.get(field.name);
      if (!prior) {
        if (names.has(name)) return null;
        names.add(name);
        fields.set(field.name, { ...field });
      } else {
        const type = mergeFieldTypes(prior.type, field.type, ctx);
        if (!type) return null;
        fields.set(field.name, { ...prior, type });
      }
    }
  }
  return [...fields.values()].map((field) => ({
    ...field,
    required: variants.every((model) => model.fields.some((f) => f.name === field.name && f.required)),
  }));
}

function mergeFieldTypes(a: TypeRef, b: TypeRef, ctx: EmitterContext): TypeRef | null {
  if (JSON.stringify(a) === JSON.stringify(b)) return a;
  if (a.kind === 'enum' && b.kind === 'enum') {
    const values = (ref: typeof a) =>
      ref.values ?? ctx.spec.enums.find((e) => e.name === ref.name)?.values.map((v) => v.value);
    const av = values(a);
    const bv = values(b);
    if (av && bv && JSON.stringify([...av].sort()) === JSON.stringify([...bv].sort())) return a;
  }
  const literals = [a, b].flatMap((ref) => (ref.kind === 'union' ? ref.variants : [ref]));
  if (literals.every((ref) => ref.kind === 'literal')) {
    return { kind: 'union', variants: [...new Map(literals.map((ref) => [JSON.stringify(ref), ref])).values()] };
  }
  return null;
}

/** Only models used by union body= APIs get new defaults; response models stay unchanged. */
export function unionRequestModels(spec: ApiSpec): Set<string> {
  const requests = new Set<string>();
  const responses = new Set<string>();
  for (const service of spec.services) {
    for (const op of service.operations) {
      if (op.requestBody?.kind === 'union') for (const name of collectModelRefs(op.requestBody)) requests.add(name);
      for (const ref of [
        op.response,
        ...op.errors.map((e) => e.type),
        ...(op.successResponses ?? []).map((r) => r.type),
        ...collectResponseHeaders(op).map((h) => h.type),
      ]) {
        if (ref) for (const name of collectModelRefs(ref)) responses.add(name);
      }
      if (op.pagination) for (const name of collectModelRefs(op.pagination.itemType)) responses.add(name);
    }
  }
  const byName = new Map(spec.models.map((model) => [model.name, model]));
  for (const names of [requests, responses]) {
    for (const name of names) {
      const model = byName.get(name);
      if (!model) continue;
      for (const field of model.fields) for (const dependency of collectModelRefs(field.type)) names.add(dependency);
      for (const variant of Object.values(model.discriminator?.mapping ?? {})) names.add(variant);
    }
  }
  for (const name of responses) requests.delete(name);
  return requests;
}
