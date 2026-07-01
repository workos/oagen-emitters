import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Service } from '@workos/oagen';
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

  it('scoped run: omits a never-generated (out-of-scope, not present) service', () => {
    const mk = (name: string): Service => ({
      name,
      operations: [
        {
          name: `list${name}`,
          httpMethod: 'get',
          path: `/${name.toLowerCase()}`,
          pathParams: [],
          queryParams: [],
          headerParams: [],
          response: { kind: 'primitive', type: 'unknown' },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    });
    const pipes = mk('Pipes');
    const agents = mk('Agents');
    // ctx resolves the FULL spec (both); scope = Pipes. The core passes the
    // surfaceSpec (services = [Pipes]) — Agents is a spec service never generated.
    const fullCtx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec: { ...spec, services: [pipes, agents] },
      scopedServices: new Set(['Pipes']),
      resolvedOperations: [pipes, agents].flatMap((s) =>
        s.operations.map((operation) => ({
          service: s,
          operation,
          methodName: operation.name,
          mountOn: s.name,
          defaults: {},
          inferFromClient: [],
          urlBuilder: false,
        })),
      ),
    };
    const surfaceSpec: ApiSpec = { ...spec, services: [pipes] };
    const map = buildOperationsMap(surfaceSpec, fullCtx);
    expect(map['GET /pipes']).toEqual({ sdkMethod: 'list_pipes', service: 'pipes' });
    // Pre-fix: recorded `service: 'agents'`, which re-entered presentServiceKeys
    // next run and re-opened the barrel/client orphan.
    expect(map['GET /agents']).toBeUndefined();
  });
});
