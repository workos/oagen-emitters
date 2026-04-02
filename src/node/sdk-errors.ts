import type { SdkBehavior } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';

/**
 * Node-specific overrides for exception kind names.
 *
 * The IR `statusCodeMap` uses canonical kind names (e.g. 'Authentication'),
 * but the Node SDK historically uses different names for some status codes.
 * This map translates the IR kind name to the Node-specific name before
 * appending the 'Exception' suffix.
 */
const NODE_EXCEPTION_KIND_OVERRIDES: Record<string, string> = {
  Authentication: 'Unauthorized',
};

/**
 * Build the status-code-to-exception-class-name map from SDK behavior,
 * applying Node-specific naming overrides.
 *
 * Example: IR `401: 'Authentication'` becomes `401: 'UnauthorizedException'`
 * because Node uses `UnauthorizedException` instead of `AuthenticationException`.
 */
export function buildNodeStatusExceptions(sdk?: SdkBehavior): Record<number, string> {
  const behavior = sdk ?? defaultSdkBehavior();
  return Object.fromEntries(
    Object.entries(behavior.errors.statusCodeMap).map(([code, kind]) => {
      const nodeKind = NODE_EXCEPTION_KIND_OVERRIDES[kind] ?? kind;
      return [Number(code), `${nodeKind}Exception`];
    }),
  );
}
