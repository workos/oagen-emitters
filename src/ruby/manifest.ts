import type { ApiSpec, EmitterContext, GeneratedFile } from '@workos/oagen';
import { servicePropertyName } from './naming.js';

/**
 * Generate smoke test manifest mapping HTTP operations to SDK methods.
 *
 * Uses each resolved operation's actual mountOn (not the service default) so
 * operations remounted via operationHints land on the correct service prop.
 * Split operations emit one entry per wrapper (keyed by wrapper name + variant).
 */
export function generateManifest(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  void spec;
  const manifest: Record<string, { sdkMethod: string; service: string }> = {};

  for (const r of ctx.resolvedOperations ?? []) {
    const op = r.operation;
    const httpKey = `${op.httpMethod.toUpperCase()} ${op.path}`;
    const propName = servicePropertyName(r.mountOn);
    manifest[httpKey] = { sdkMethod: r.methodName, service: propName };
    if (r.wrappers && r.wrappers.length > 0) {
      for (const w of r.wrappers) {
        manifest[`${httpKey}#${w.targetVariant}`] = { sdkMethod: w.name, service: propName };
      }
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
