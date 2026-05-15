import type { EmitterContext, ResolvedOperation } from '@workos/oagen';

type OperationOverride = {
  methodName?: string;
  mountOn?: string;
};

const OPERATION_OVERRIDES: Record<string, OperationOverride> = {
  'POST /organizations/{organizationId}/groups': {
    methodName: 'create_group',
  },
  'GET /organizations/{organizationId}/groups': {
    methodName: 'list_groups',
  },
  'GET /organizations/{organizationId}/groups/{groupId}': {
    methodName: 'get_group',
  },
  'PATCH /organizations/{organizationId}/groups/{groupId}': {
    methodName: 'update_group',
  },
  'DELETE /organizations/{organizationId}/groups/{groupId}': {
    methodName: 'delete_group',
  },
  'POST /organizations/{organizationId}/groups/{groupId}/organization-memberships': {
    methodName: 'add_organization_membership',
  },
  'GET /organizations/{organizationId}/groups/{groupId}/organization-memberships': {
    methodName: 'list_organization_memberships',
  },
  'DELETE /organizations/{organizationId}/groups/{groupId}/organization-memberships/{omId}': {
    methodName: 'remove_organization_membership',
  },
  'GET /user_management/organization_memberships/{omId}/groups': {
    methodName: 'list_groups_for_organization_membership',
    mountOn: 'UserManagement',
  },
};

const contextCache = new WeakMap<EmitterContext, EmitterContext>();

function operationKey(resolved: ResolvedOperation): string {
  return `${resolved.operation.httpMethod.toUpperCase()} ${resolved.operation.path}`;
}

export function withNodeOperationOverrides(ctx: EmitterContext): EmitterContext {
  const cached = contextCache.get(ctx);
  if (cached) return cached;

  const resolvedOperations = ctx.resolvedOperations;
  if (!resolvedOperations?.length) {
    contextCache.set(ctx, ctx);
    return ctx;
  }

  let changed = false;
  const nextResolved = resolvedOperations.map((resolved) => {
    const override = OPERATION_OVERRIDES[operationKey(resolved)];
    if (!override) return resolved;

    const methodName = override.methodName ?? resolved.methodName;
    const mountOn = override.mountOn ?? resolved.mountOn;
    if (methodName === resolved.methodName && mountOn === resolved.mountOn) {
      return resolved;
    }

    changed = true;
    return {
      ...resolved,
      methodName,
      mountOn,
    };
  });

  const next = changed ? { ...ctx, resolvedOperations: nextResolved } : ctx;
  contextCache.set(ctx, next);
  return next;
}
