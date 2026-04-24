import type { ApiSpec, EmitterContext, OperationsMap } from '@workos/oagen';
import { resolveMethodName, servicePropertyName } from './naming.js';
import { resolveResourceClassName } from './resources.js';

export function buildOperationsMap(spec: ApiSpec, ctx: EmitterContext): OperationsMap {
  const manifest: OperationsMap = {};

  for (const service of spec.services) {
    const propName = servicePropertyName(resolveResourceClassName(service, ctx));
    for (const op of service.operations) {
      const httpKey = `${op.httpMethod.toUpperCase()} ${op.path}`;
      const method = resolveMethodName(op, service, ctx);
      manifest[httpKey] = { sdkMethod: method, service: propName };
    }
  }

  return manifest;
}
