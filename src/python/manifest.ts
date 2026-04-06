import type { ApiSpec, EmitterContext, GeneratedFile } from '@workos/oagen';
import { resolveMethodName } from './naming.js';
import { buildServiceAccessPaths } from './client.js';
import { getMountTarget } from '../shared/resolved-ops.js';

/**
 * Generate smoke test manifest mapping HTTP operations to SDK methods.
 */
export function generateManifest(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const manifest: Record<string, { sdkMethod: string; service: string }> = {};
  const accessPaths = buildServiceAccessPaths(spec.services, ctx);

  for (const service of spec.services) {
    // For mounted services, look up the mount target's access path
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

  return [
    {
      path: 'smoke-manifest.json',
      content: JSON.stringify(manifest, null, 2),
      integrateTarget: false,
      overwriteExisting: true,
    },
  ];
}
