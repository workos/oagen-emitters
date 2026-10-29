import type { EmitterContext, Field, Model, Operation, TypeRef } from '@workos/oagen';
import { domainFieldName, fieldName } from './naming.js';

/**
 * Typed params fields for an object-union request body, so a body that turned
 * from one object into a union of objects keeps its flat struct fields next to
 * `Body`. Variants merge when their shared fields agree; a field is required
 * only when every variant requires it. Returns null for unions that can't be
 * flattened unambiguously, which keep the `Body interface{}`-only struct.
 */
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
  const reserved = new Set(['Body', 'NullFields', 'PaginationParams', ...op.queryParams.map((p) => fieldName(p.name))]);
  const fields = new Map<string, Field>();
  const goNames = new Set<string>();
  for (const model of variants) {
    for (const field of model.fields) {
      const prior = fields.get(field.name);
      if (!prior) {
        const goName = domainFieldName(field);
        // Ambiguous struct fields must retain the existing Body-only API.
        if (reserved.has(goName) || goNames.has(goName)) return null;
        goNames.add(goName);
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
