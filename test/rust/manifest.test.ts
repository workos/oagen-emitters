import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { buildOperationsMap } from '../../src/rust/manifest.js';

const spec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: '',
  services: [
    {
      name: 'Organizations',
      operations: [
        {
          name: 'createOrganization',
          httpMethod: 'post',
          path: '/organizations',
          pathParams: [],
          queryParams: [],
          headerParams: [],
          response: { kind: 'primitive', type: 'unknown' },
          errors: [],
          injectIdempotencyKey: false,
        },
        {
          name: 'getOrganization',
          httpMethod: 'get',
          path: '/organizations/{id}',
          pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
          queryParams: [],
          headerParams: [],
          response: { kind: 'primitive', type: 'unknown' },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    },
  ],
  models: [],
  enums: [],
  sdk: defaultSdkBehavior(),
};

const ctx: EmitterContext = {
  namespace: 'workos',
  namespacePascal: 'WorkOS',
  spec,
  resolvedOperations: spec.services.flatMap((service) =>
    service.operations.map((operation) => ({
      service,
      operation,
      methodName: operation.name,
      mountOn: service.name,
      defaults: {},
      inferFromClient: [],
      urlBuilder: false,
    })),
  ),
};

describe('rust/manifest', () => {
  it('maps each HTTP operation to an SDK method + service accessor', () => {
    const map = buildOperationsMap(spec, ctx);
    expect(map['POST /organizations']).toEqual({
      sdkMethod: 'create_organization',
      service: 'organizations',
    });
    expect(map['GET /organizations/{id}']).toEqual({
      sdkMethod: 'get_organization',
      service: 'organizations',
    });
  });
});
