import { describe, it, expect } from 'vitest';
import { buildOperationsMap } from '../../src/python/manifest.js';
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

describe('buildOperationsMap', () => {
  it('uses flat client access paths (no dotted namespaces)', () => {
    const ops = buildOperationsMap(spec, ctx);

    const orgEntry = ops['GET /organizations'] as { sdkMethod: string; service: string };
    expect(orgEntry.service).toBe('organizations');
    // Flat: no dotted access, each service has its own accessor
    const apiKeysEntry = ops['GET /organizations/api_keys'] as { sdkMethod: string; service: string };
    expect(apiKeysEntry.service).toBe('organizations_api_keys');
  });
});
