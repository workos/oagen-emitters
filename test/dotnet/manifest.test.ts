import { describe, it, expect } from 'vitest';
import { buildOperationsMap } from '../../src/dotnet/manifest.js';
import type { ApiSpec, EmitterContext, Service, Model } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';

const models: Model[] = [
  {
    name: 'Organization',
    fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
  },
];

const services: Service[] = [
  {
    name: 'Organizations',
    operations: [
      {
        name: 'listOrganizations',
        httpMethod: 'get',
        path: '/organizations',
        pathParams: [],
        queryParams: [],
        headerParams: [],
        response: { kind: 'model', name: 'Organization' },
        errors: [],
        injectIdempotencyKey: false,
      },
    ],
  },
  {
    name: 'OrganizationsApiKeys',
    operations: [
      {
        name: 'listOrganizationApiKeys',
        httpMethod: 'get',
        path: '/organizations/api_keys',
        pathParams: [],
        queryParams: [],
        headerParams: [],
        response: { kind: 'model', name: 'Organization' },
        errors: [],
        injectIdempotencyKey: false,
      },
    ],
  },
];

const spec: ApiSpec = {
  name: 'TestAPI',
  version: '1.0.0',
  baseUrl: 'https://api.workos.com',
  services,
  models,
  enums: [],
  sdk: defaultSdkBehavior(),
};

const ctx: EmitterContext = {
  namespace: 'workos',
  namespacePascal: 'WorkOS',
  spec,
};

describe('dotnet/manifest', () => {
  it('returns an operations map', () => {
    const ops = buildOperationsMap(spec, ctx);
    expect(typeof ops).toBe('object');
    expect(Object.keys(ops).length).toBeGreaterThan(0);
  });

  it('maps HTTP operations to SDK method names and services', () => {
    const ops = buildOperationsMap(spec, ctx);

    expect(ops['GET /organizations']).toBeDefined();
    const entry = ops['GET /organizations'] as { sdkMethod: string; service: string };
    expect(entry.sdkMethod).toBeDefined();
    expect(entry.service).toBeDefined();

    expect(ops['GET /organizations/api_keys']).toBeDefined();
    const entry2 = ops['GET /organizations/api_keys'] as { sdkMethod: string; service: string };
    expect(entry2.sdkMethod).toBeDefined();
  });
});
