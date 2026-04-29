import type { ApiSpec, EmitterContext, OperationsMap } from '@workos/oagen';
import { resolveMethodName } from './naming.js';
import { buildServiceAccessPaths } from './client.js';
import { buildResolvedLookup, lookupResolved, getMountTarget } from '../shared/resolved-ops.js';

/**
 * Build operation-to-SDK-method mapping for the manifest.
 */
export function buildOperationsMap(spec: ApiSpec, ctx: EmitterContext): OperationsMap {
  const manifest: OperationsMap = {};
  const accessPaths = buildServiceAccessPaths(spec.services, ctx);
  const resolvedLookup = buildResolvedLookup(ctx);

  for (const service of spec.services) {
    // For mounted services, look up the mount target's access path
    let serviceProp = accessPaths.get(service.name);
    if (!serviceProp) {
      const mountTarget = getMountTarget(service, ctx);
      serviceProp = accessPaths.get(mountTarget);
    }
    if (!serviceProp) {
      throw new Error(`Missing public client access path for service ${service.name}`);
    }
    for (const op of service.operations) {
      const httpKey = `${op.httpMethod.toUpperCase()} ${op.path}`;
      const method = resolveMethodName(op, service, ctx);

      // Use per-operation mountOn when it differs from the service default
      const resolved = lookupResolved(op, resolvedLookup);
      const propName = (resolved && accessPaths.get(resolved.mountOn)) ?? serviceProp;

      manifest[httpKey] = { sdkMethod: method, service: propName };
    }
  }

  return manifest;
}
