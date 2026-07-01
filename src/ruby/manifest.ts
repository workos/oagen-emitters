import type { ApiSpec, EmitterContext, OperationsMap, Service } from '@workos/oagen';
import { servicePropertyName } from './naming.js';
import { getMountTarget } from '../shared/resolved-ops.js';

/**
 * Build operation-to-SDK-method mapping for the manifest.
 *
 * Uses each resolved operation's actual mountOn (not the service default) so
 * operations remounted via operationHints land on the correct service prop.
 * Split operations emit one entry per wrapper (keyed by wrapper name + variant).
 *
 * The accessor (`service` field) uses the raw mountOn — accessor names stay
 * unsuffixed even when the underlying service class gets a `Service` suffix
 * on collision.
 */
export function buildOperationsMap(spec: ApiSpec, ctx: EmitterContext): OperationsMap {
  const manifest: OperationsMap = {};

  // Restrict to the emit surface (`spec` is the core's surfaceSpec = selected ∪
  // on-disk). Recording a never-generated service here persists it into the
  // merged manifest, so the next scoped run reads it back as present and re-wires
  // it — the same recurrence the rust manifest fix prevents.
  const surfaceMounts = new Set((spec.services as Service[]).map((s) => getMountTarget(s, ctx)));
  for (const r of ctx.resolvedOperations ?? []) {
    if (!surfaceMounts.has(r.mountOn)) continue;
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
