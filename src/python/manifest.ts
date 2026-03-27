import type { ApiSpec, EmitterContext, GeneratedFile } from '@workos/oagen';
import { resolveMethodName, servicePropertyName } from './naming.js';
import { resolveResourceClassName } from './resources.js';

/**
 * Generate smoke test manifest mapping HTTP operations to SDK methods.
 */
export function generateManifest(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const manifest: Record<string, { sdkMethod: string; service: string }> = {};

  for (const service of spec.services) {
    const propName = servicePropertyName(resolveResourceClassName(service, ctx));
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
