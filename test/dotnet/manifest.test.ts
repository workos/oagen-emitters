import { describe, it, expect } from 'vitest';
import { generateManifest } from '../../src/dotnet/manifest.js';
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
  it('generates smoke-manifest.json', () => {
    const files = generateManifest(spec, ctx);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('smoke-manifest.json');
  });

  it('maps HTTP operations to SDK method names and services', () => {
    const files = generateManifest(spec, ctx);
    const manifest = JSON.parse(files[0].content) as Record<string, { sdkMethod: string; service: string }>;

    expect(manifest['GET /organizations']).toBeDefined();
    expect(manifest['GET /organizations'].sdkMethod).toBeDefined();
    expect(manifest['GET /organizations'].service).toBeDefined();

    expect(manifest['GET /organizations/api_keys']).toBeDefined();
    expect(manifest['GET /organizations/api_keys'].sdkMethod).toBeDefined();
  });
});
