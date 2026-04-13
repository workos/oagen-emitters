import type { ApiSpec, EmitterContext, GeneratedFile } from '@workos/oagen';
import { resolveMethodName, servicePropertyName, resolveClassName } from './naming.js';
import { getMountTarget } from '../shared/resolved-ops.js';

/**
 * Generate the smoke-test manifest mapping `"HTTP_METHOD /path"` to
 * `{ sdkMethod, service }`. The `service` is the camelCase accessor property
 * on the main `WorkOS` client (e.g., `organizations`).
 */
export function generateManifest(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const manifest: Record<string, { sdkMethod: string; service: string }> = {};

  for (const service of spec.services) {
    const mountTarget = getMountTarget(service, ctx);
    const prop = servicePropertyName(resolveClassName(service, ctx) || mountTarget);
    for (const op of service.operations) {
      const httpKey = `${op.httpMethod.toUpperCase()} ${op.path}`;
      const method = resolveMethodName(op, service, ctx);
      manifest[httpKey] = { sdkMethod: method, service: prop };
    }
  }

  return [
    {
      path: 'smoke-manifest.json',
      content: JSON.stringify(manifest, null, 2),
      integrateTarget: false,
    },
  ];
}
