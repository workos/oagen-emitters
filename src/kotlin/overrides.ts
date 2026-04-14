import type { Operation } from '@workos/oagen';

/**
 * Operations whose generated implementation would be wrong (URL builders
 * served as HTTP calls). Hand-maintained code in `workos-kotlin` owns these
 * method names instead; the emitter must skip resources, tests, and the
 * smoke manifest for any operation in this set.
 *
 * Keys are `"METHOD path"` in the same form used by the smoke manifest.
 */
export const HANDWRITTEN_OVERRIDE_OPS: ReadonlySet<string> = new Set([
  // AuthKit authorization URL (H09 / H10 are hand-built).
  'GET /user_management/authorize',
  // AuthKit logout URL (H17 — URL, not HTTP call).
  'GET /user_management/sessions/logout',
  // SSO authorization URL (H14 / H15 are hand-built).
  'GET /sso/authorize',
  // SSO logout URL (H17 — URL, not HTTP call).
  'GET /sso/logout',
]);

/** True if the operation is owned by a hand-maintained override. */
export function isHandwrittenOverride(op: Operation): boolean {
  return HANDWRITTEN_OVERRIDE_OPS.has(`${op.httpMethod.toUpperCase()} ${op.path}`);
}
