import type { Operation } from '@workos/oagen';

/**
 * The scheme an operation uses in place of the client's default bearer auth
 * (`access_token` on `SSO.getProfile`, say), or `null` when it declares none.
 *
 * Since @workos/oagen 0.31 `Operation.security` is a list of alternatives —
 * one `SecurityRequirementSet` per OpenAPI requirement object, any one of
 * which satisfies the request — where earlier versions carried a single flat
 * `SecurityRequirement[]`. `flat()` reads both the same way, so this compiles
 * and behaves identically on either side of that boundary.
 *
 * An operation that declares nothing (`undefined`) inherits the document
 * default and has no override; one that declares `[]` needs no authentication
 * and has none either.
 */
export function bearerOverrideScheme(op: Operation): string | null {
  return op.security?.flat().find((s) => s.schemeName !== 'bearerAuth')?.schemeName ?? null;
}
