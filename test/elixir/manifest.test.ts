import { describe, it, expect } from 'vitest';
import type { ResolvedWrapper, Service } from '@workos/oagen';
import { buildOperationsMap } from '../../src/elixir/manifest.js';
import { makeSpec, makeCtx, makeOp, buildResolvedOps } from './helpers.js';

function makeWrapper(name: string, targetVariant: string): ResolvedWrapper {
  return {
    name,
    targetVariant,
    defaults: {},
    inferFromClient: [],
    exposedParams: [],
    optionalParams: [],
    responseModelName: null,
  };
}

const services: Service[] = [
  {
    name: 'Organizations',
    operations: [
      makeOp({ name: 'listOrganizations' }),
      makeOp({
        name: 'getOrganization',
        path: '/organizations/{id}',
        pathParams: [
          {
            name: 'id',
            type: { kind: 'primitive', type: 'string' },
            required: true,
          },
        ],
      }),
    ],
  },
];

describe('elixir/manifest', () => {
  it('maps every operation to its snake_case function and service', () => {
    const spec = makeSpec({ services });
    const manifest = buildOperationsMap(spec, makeCtx(spec));
    expect(manifest['GET /organizations']).toEqual({
      sdkMethod: 'list_organizations',
      service: 'organizations',
    });
    expect(manifest['GET /organizations/{id}']).toEqual({
      sdkMethod: 'get_organization',
      service: 'organizations',
    });
  });

  it('maps union-split operations to their wrapper functions, not the base method', () => {
    const spec = makeSpec({ services });
    const ctx = makeCtx(spec);
    ctx.resolvedOperations = buildResolvedOps(services).map((r) =>
      r.operation.path === '/organizations'
        ? {
            ...r,
            wrappers: [
              makeWrapper('list_organizations_by_domain', 'DomainQuery'),
              makeWrapper('list_organizations_by_name', 'NameQuery'),
            ],
          }
        : r,
    );
    const manifest = buildOperationsMap(spec, ctx);
    // resources.ts emits only the wrappers for these — `list_organizations`
    // never exists, so recording it would send the smoke runner at a missing
    // function.
    expect(manifest['GET /organizations']).toEqual([
      { sdkMethod: 'list_organizations_by_domain', service: 'organizations' },
      { sdkMethod: 'list_organizations_by_name', service: 'organizations' },
    ]);
  });

  it('excludes url-builder operations', () => {
    const spec = makeSpec({ services });
    const ctx = makeCtx(spec);
    ctx.resolvedOperations = buildResolvedOps(services).map((r) =>
      r.operation.path === '/organizations' ? { ...r, urlBuilder: true } : r,
    );
    const manifest = buildOperationsMap(spec, ctx);
    expect(manifest['GET /organizations']).toBeUndefined();
    expect(manifest['GET /organizations/{id}']).toBeDefined();
  });
});
