import type { ApiSpec, EmitterContext, OperationsMap } from '@workos/oagen';
import { servicePropertyName } from './naming.js';

/**
 * Build operation-to-SDK-method mapping for the manifest.
 *
 * Uses each resolved operation's actual mountOn (not the service default) so
 * operations remounted via operationHints land on the correct service prop.
 * Split operations emit one entry per wrapper (keyed by wrapper name + variant).
 */
export function buildOperationsMap(spec: ApiSpec, ctx: EmitterContext): OperationsMap {
  void spec;
  const manifest: OperationsMap = {};

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

  return manifest;
}
