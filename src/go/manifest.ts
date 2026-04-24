import type { ApiSpec, EmitterContext, OperationsMap } from '@workos/oagen';
import { resolveMethodName } from './naming.js';
import { buildServiceAccessPaths } from './client.js';
import { getMountTarget } from '../shared/resolved-ops.js';

/**
 * Build operation-to-SDK-method mapping for the manifest.
 */
export function buildOperationsMap(spec: ApiSpec, ctx: EmitterContext): OperationsMap {
  const manifest: OperationsMap = {};
  const accessPaths = buildServiceAccessPaths(spec.services, ctx);

  for (const service of spec.services) {
    let propName = accessPaths.get(service.name);
    if (!propName) {
      const mountTarget = getMountTarget(service, ctx);
      propName = accessPaths.get(mountTarget);
    }
    if (!propName) {
      throw new Error(`Missing public client access path for service ${service.name}`);
    }
    for (const op of service.operations) {
      const httpKey = `${op.httpMethod.toUpperCase()} ${op.path}`;
      const method = resolveMethodName(op, service, ctx);
      manifest[httpKey] = { sdkMethod: method, service: propName };
    }
  }

  return manifest;
}
