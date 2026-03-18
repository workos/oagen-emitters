import type { ApiSpec, EmitterContext, GeneratedFile } from "@workos/oagen";
import { resolveMethodName, servicePropertyName } from "./naming.js";

export function generateManifest(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const manifest: Record<string, { sdkMethod: string; service: string }> = {};

  for (const service of spec.services) {
    const propName = servicePropertyName(service.name);
    for (const op of service.operations) {
      const httpKey = `${op.httpMethod.toUpperCase()} ${op.path}`;
      const method = resolveMethodName(op, service, ctx);
      manifest[httpKey] = { sdkMethod: method, service: propName };
    }
  }

  return [
    {
      path: "smoke-manifest.json",
      content: JSON.stringify(manifest, null, 2),
    },
  ];
}
