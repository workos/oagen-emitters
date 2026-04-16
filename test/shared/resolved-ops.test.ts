import { describe, expect, it } from 'vitest';
import type { EmitterContext, ResolvedOperation } from '@workos/oagen';
import { assertUniqueResolvedMethods, buildResolvedLookup } from '../../src/shared/resolved-ops.js';

function makeResolvedOperation(
  httpMethod: string,
  path: string,
  methodName: string,
  mountOn = 'Authorization',
): ResolvedOperation {
  return {
    operation: {
      name: methodName,
      httpMethod: httpMethod as any,
      path,
      pathParams: [],
      queryParams: [],
      headerParams: [],
      response: { kind: 'primitive', type: 'string' },
      errors: [],
      injectIdempotencyKey: false,
    },
    service: {
      name: mountOn,
      operations: [],
    },
    methodName,
    mountOn,
    defaults: {},
    inferFromClient: [],
    urlBuilder: false,
  } as unknown as ResolvedOperation;
}

function makeCtx(resolvedOperations: ResolvedOperation[]): EmitterContext {
  return {
    namespace: 'workos',
    namespacePascal: 'WorkOS',
    spec: {
      name: 'Test',
      version: '1.0.0',
      baseUrl: 'https://api.example.com',
      services: [],
      models: [],
      enums: [],
      sdk: {} as any,
    },
    resolvedOperations,
  } as EmitterContext;
}

describe('shared/resolved-ops', () => {
  it('allows duplicate method names when they target the same path', () => {
    const ctx = makeCtx([
      makeResolvedOperation('put', '/organizations/{id}', 'update_organization'),
      makeResolvedOperation('patch', '/organizations/{id}', 'update_organization'),
    ]);

    expect(() => assertUniqueResolvedMethods(ctx)).not.toThrow();
    expect(buildResolvedLookup(ctx).size).toBe(2);
  });

  it('throws when two different paths in the same mount resolve to the same method', () => {
    const ctx = makeCtx([
      makeResolvedOperation(
        'get',
        '/authorization/organization_memberships/{organization_membership_id}/resources/{resource_id}/permissions',
        'list_resource_permissions',
      ),
      makeResolvedOperation(
        'get',
        '/authorization/organization_memberships/{organization_membership_id}/resources/{resource_type_slug}/{external_id}/permissions',
        'list_resource_permissions',
      ),
    ]);

    expect(() => assertUniqueResolvedMethods(ctx)).toThrow(
      /Resolved operation name collision for Authorization\.list_resource_permissions/,
    );
  });
});
