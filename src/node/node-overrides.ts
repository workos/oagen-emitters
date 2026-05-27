import type { EmitterContext, Model, ResolvedOperation } from '@workos/oagen';
import { enrichModelsFromSpec } from '../shared/model-utils.js';
import { nodeOptions } from './options.js';

const contextCache = new WeakMap<EmitterContext, EmitterContext>();

function operationKey(resolved: ResolvedOperation): string {
  return `${resolved.operation.httpMethod.toUpperCase()} ${resolved.operation.path}`;
}

/**
 * Apply oneOf / allOf+oneOf enrichment (flattening variant fields onto the
 * parent model, plus synthetic models/enums for inline shapes) so the rest
 * of the Node emitter sees a richer `spec.models`.
 *
 * Without this, `ConnectApplication` (and any other `allOf [base, oneOf [...]]`
 * schema whose first variant is itself wrapped in `allOf`) loses every
 * non-M2M field — the IR parser's discriminator detection silently skips
 * variants whose properties live behind another `allOf`. Mirrors what the
 * Go / Kotlin / .NET emitters already do.
 *
 * Discriminated bases produced by `enrichModelsFromSpec` get their original
 * fields restored — Node emits flat interfaces today, not TS sum types, so
 * an empty base would otherwise drop the common fields.
 */
function enrichSpecModels(models: readonly Model[]): Model[] {
  const enriched = enrichModelsFromSpec(models as Model[]);
  const originalByName = new Map(models.map((m) => [m.name, m]));
  return enriched.map((m) => {
    if ((m as { discriminator?: unknown }).discriminator && m.fields.length === 0) {
      const original = originalByName.get(m.name);
      if (original && original.fields.length > 0) {
        return { ...m, fields: original.fields };
      }
    }
    return m;
  });
}

export function withNodeOperationOverrides(ctx: EmitterContext): EmitterContext {
  const cached = contextCache.get(ctx);
  if (cached) return cached;

  const enrichedModels = enrichSpecModels(ctx.spec.models);
  const specChanged =
    enrichedModels.length !== ctx.spec.models.length || enrichedModels.some((m, i) => m !== ctx.spec.models[i]);
  const enrichedSpec = specChanged ? { ...ctx.spec, models: enrichedModels } : ctx.spec;

  const resolvedOperations = ctx.resolvedOperations;
  if (!resolvedOperations?.length) {
    const next = specChanged ? { ...ctx, spec: enrichedSpec } : ctx;
    contextCache.set(ctx, next);
    return next;
  }

  const configOverrides = nodeOptions(ctx).operationOverrides ?? {};

  let opsChanged = false;
  const nextResolved = resolvedOperations.map((resolved) => {
    const override = configOverrides[operationKey(resolved)];
    if (!override) return resolved;

    const methodName = override.methodName ?? resolved.methodName;
    const mountOn = override.mountOn ?? resolved.mountOn;
    if (methodName === resolved.methodName && mountOn === resolved.mountOn) {
      return resolved;
    }

    opsChanged = true;
    return {
      ...resolved,
      methodName,
      mountOn,
    };
  });

  const next =
    opsChanged || specChanged
      ? {
          ...ctx,
          ...(opsChanged ? { resolvedOperations: nextResolved } : {}),
          ...(specChanged ? { spec: enrichedSpec } : {}),
        }
      : ctx;
  contextCache.set(ctx, next);
  return next;
}
