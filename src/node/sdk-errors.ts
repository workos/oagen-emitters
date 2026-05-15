import type { SdkBehavior } from '@workos/oagen';

const NODE_EXCEPTION_KIND_OVERRIDES: Record<string, string> = {
  Authentication: 'Unauthorized',
};

const DEFAULT_STATUS_CODE_MAP: Record<string, string> = {
  '400': 'BadRequest',
  '401': 'Authentication',
  '403': 'Authorization',
  '404': 'NotFound',
  '409': 'Conflict',
  '422': 'UnprocessableEntity',
  '429': 'RateLimitExceeded',
};

export function buildNodeStatusExceptions(sdk?: SdkBehavior): Record<number, string> {
  const statusCodeMap = sdk?.errors?.statusCodeMap ?? DEFAULT_STATUS_CODE_MAP;
  return Object.fromEntries(
    Object.entries(statusCodeMap).map(([code, kind]) => {
      const nodeKind = NODE_EXCEPTION_KIND_OVERRIDES[kind] ?? kind;
      return [Number(code), `${nodeKind}Exception`];
    }),
  );
}
