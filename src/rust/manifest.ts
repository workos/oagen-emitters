import type { ApiSpec, EmitterContext, OperationsMap } from '@workos/oagen';
import { methodName, moduleName } from './naming.js';
import { groupByMount } from '../shared/resolved-ops.js';

/**
 * Build the operation→SDK-method map written into `.oagen-manifest.json`,
 * which the smoke runner consults to dispatch HTTP operations to SDK calls.
 *
 * Keys are `METHOD /path`; values point at the mount-target accessor on
 * `Client` and the resolved snake_case method name. Split operations register
 * one entry per wrapper (the wrapper name takes precedence over the raw op
 * name since the raw method does not exist in the generated SDK).
 */
export function buildOperationsMap(_spec: ApiSpec, ctx: EmitterContext): OperationsMap {
  const map: OperationsMap = {};

  for (const [mountName, group] of groupByMount(ctx)) {
    const accessor = moduleName(mountName);
    for (const r of group.resolvedOps) {
      const httpKey = `${r.operation.httpMethod.toUpperCase()} ${r.operation.path}`;
      if ((r.wrappers?.length ?? 0) > 0) {
        const first = r.wrappers![0]!;
        map[httpKey] = { sdkMethod: methodName(first.name), service: accessor };
      } else {
        map[httpKey] = { sdkMethod: methodName(r.methodName), service: accessor };
      }
    }
  }

  return map;
}
