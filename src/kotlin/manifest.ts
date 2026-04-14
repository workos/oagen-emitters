import type { ApiSpec, EmitterContext, GeneratedFile } from '@workos/oagen';
import { resolveMethodName, servicePropertyName, resolveClassName } from './naming.js';
import { buildResolvedLookup, lookupResolved, getMountTarget } from '../shared/resolved-ops.js';
import { propertyName } from './naming.js';
import { isHandwrittenOverride } from './overrides.js';

/**
 * Generate the smoke-test manifest mapping `"HTTP_METHOD /path"` to
 * `{ sdkMethod, service }`. The `service` is the camelCase accessor property
 * on the main `WorkOS` client (e.g., `organizations`).
 *
 * For polymorphic/split operations (e.g., authenticate -> 8 methods), the
 * manifest emits one entry per wrapper method so each variant is addressable.
 */
export function generateManifest(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const manifest: Record<string, { sdkMethod: string; service: string } | { sdkMethod: string; service: string }[]> =
    {};
  const resolvedLookup = buildResolvedLookup(ctx);

  for (const service of spec.services) {
    const mountTarget = getMountTarget(service, ctx);
    const prop = servicePropertyName(resolveClassName(service, ctx) || mountTarget);
    for (const op of service.operations) {
      if (isHandwrittenOverride(op)) continue;
      const httpKey = `${op.httpMethod.toUpperCase()} ${op.path}`;

      // Check if this operation is split into wrapper methods
      const resolved = lookupResolved(op, resolvedLookup);
      const wrappers = resolved?.wrappers ?? [];

      // Use the resolved mount target for correct service attribution
      const resolvedProp = resolved ? servicePropertyName(resolved.mountOn) : prop;

      if (wrappers.length > 0) {
        // Polymorphic operation: emit an array of methods
        const methods = wrappers.map((w) => ({
          sdkMethod: propertyName(w.name),
          service: resolvedProp,
        }));
        manifest[httpKey] = methods;
      } else {
        const method = resolveMethodName(op, service, ctx);
        manifest[httpKey] = { sdkMethod: method, service: resolvedProp };
      }
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
