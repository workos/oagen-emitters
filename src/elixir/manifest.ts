import type { ApiSpec, EmitterContext, OperationsMap, Service } from '@workos/oagen';
import { functionName, moduleName, fileName } from './naming.js';
import { getMountTarget } from '../shared/resolved-ops.js';
import { buildExportedClassNameSet, resolveServiceTarget } from '../shared/service-name-collision.js';

/**
 * Build the operation-to-SDK-function mapping for `.oagen-manifest.json`.
 *
 * `service` is the snake_case form of the RESOLVED module short name (with the
 * collision `Service` suffix applied when present) — i.e. exactly the resource
 * file's basename under `lib/{namespace}/`. The smoke runner resolves the real
 * module name by reading `defmodule` from that file, so acronym casing (SSO,
 * MFA) never needs to be re-derived from the snake form.
 *
 * URL-builder operations are excluded — the emitter does not generate request
 * functions for them.
 */
export function buildOperationsMap(spec: ApiSpec, ctx: EmitterContext): OperationsMap {
  const manifest: OperationsMap = {};
  const surfaceMounts = new Set((spec.services as Service[]).map((s) => getMountTarget(s, ctx)));
  const exported = buildExportedClassNameSet(ctx, moduleName);

  for (const resolved of ctx.resolvedOperations ?? []) {
    if (!surfaceMounts.has(resolved.mountOn)) continue;
    if ((resolved as { urlBuilder?: boolean }).urlBuilder) continue;
    const op = resolved.operation;
    const httpKey = `${op.httpMethod.toUpperCase()} ${op.path}`;
    manifest[httpKey] = {
      sdkMethod: functionName(resolved.methodName),
      service: fileName(resolveServiceTarget(resolved.mountOn, exported, moduleName)),
    };
  }

  return manifest;
}
