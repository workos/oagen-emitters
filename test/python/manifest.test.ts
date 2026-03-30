import { describe, it, expect } from 'vitest';
import { generateManifest } from '../../src/python/manifest.js';
import type { ApiSpec, EmitterContext, Service, Model } from '@workos/oagen';

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
};

const ctx: EmitterContext = {
  namespace: 'workos',
  namespacePascal: 'WorkOS',
  spec,
};

describe('generateManifest', () => {
  it('uses dotted client access paths for namespaced resources', () => {
    const files = generateManifest(spec, ctx);
    expect(files).toHaveLength(1);

    const manifest = JSON.parse(files[0].content) as Record<string, { sdkMethod: string; service: string }>;
    expect(manifest['GET /organizations'].service).toBe('organizations');
    expect(manifest['GET /organizations/api_keys'].service).toBe('organizations.api_keys');
  });
});
