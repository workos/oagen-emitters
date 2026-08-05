import type { ApiSpec, EmitterContext, OperationsMap } from '@workos/oagen';
import { groupByMount } from '../shared/resolved-ops.js';
import { accessorName, resolveMethodName, methodName, withResolvedOps } from './naming.js';

/**
 * Build the `"METHOD /path" -> { sdkMethod, service }` map written into
 * `.oagen-manifest.json`. Uses the same mount grouping and method-name resolution
 * as `generateResources`, so the smoke runner resolves the exact methods the
 * emitter produced. Split operations map to an array (one entry per wrapper).
 * URL builders are skipped — there is no HTTP call to verify. Reserved-word
 * back-ticks are stripped: the manifest records the logical selector, and the
 * smoke generator re-escapes if needed.
 */
export function buildOperationsMap(_spec: ApiSpec, ctx: EmitterContext): OperationsMap {
  const rctx = withResolvedOps(ctx);
  const operations: OperationsMap = {};

  for (const group of groupByMount(rctx).values()) {
    const service = strip(accessorName(group.name));
    for (const resolved of group.resolvedOps) {
      if (resolved.urlBuilder) continue;
      const op = resolved.operation;
      const httpKey = `${op.httpMethod.toUpperCase()} ${op.path}`;
      if (resolved.wrappers && resolved.wrappers.length > 0) {
        operations[httpKey] = resolved.wrappers.map((w) => ({
          sdkMethod: strip(methodName(w.name)),
          service,
        }));
      } else {
        operations[httpKey] = {
          sdkMethod: strip(resolveMethodName(op, group.name, rctx)),
          service,
        };
      }
    }
  }

  return operations;
}

function strip(name: string): string {
  return name.split('`').join('');
}
