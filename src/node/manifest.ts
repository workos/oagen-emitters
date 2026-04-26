import type { ApiSpec, EmitterContext, OperationsMap } from '@workos/oagen';
import { resolveMethodName, servicePropertyName } from './naming.js';
import { resolveResourceClassName } from './resources.js';
import { buildResolvedLookup, lookupResolved } from '../shared/resolved-ops.js';

export function buildOperationsMap(spec: ApiSpec, ctx: EmitterContext): OperationsMap {
  const manifest: OperationsMap = {};
  const resolvedLookup = buildResolvedLookup(ctx);

  for (const service of spec.services) {
    const serviceProp = servicePropertyName(resolveResourceClassName(service, ctx));
    for (const op of service.operations) {
      const httpKey = `${op.httpMethod.toUpperCase()} ${op.path}`;
      const method = resolveMethodName(op, service, ctx);

      // Use per-operation mountOn when it differs from the service default
      const resolved = lookupResolved(op, resolvedLookup);
      const propName = resolved ? servicePropertyName(resolved.mountOn) : serviceProp;

      manifest[httpKey] = { sdkMethod: method, service: propName };
    }
  }

  return manifest;
}
