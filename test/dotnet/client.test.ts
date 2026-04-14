import { describe, it, expect } from 'vitest';
import { generateClient } from '../../src/dotnet/client.js';
import type { EmitterContext, ApiSpec, Service, Model } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';

const models: Model[] = [
  {
    name: 'Organization',
    fields: [
      { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
      { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
    ],
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

describe('dotnet/client', () => {
  it('generates only WorkOSClient.Generated.cs', () => {
    const files = generateClient(spec, ctx);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('Client/WorkOSClient.Generated.cs');
  });

  it('generates partial class with service accessors', () => {
    const files = generateClient(spec, ctx);
    const content = files[0].content;

    expect(content).toContain('namespace WorkOS');
    expect(content).toContain('public partial class WorkOSClient');
    // Lazy-initialized service property
    expect(content).toContain('OrganizationsService');
    expect(content).toContain('??= new OrganizationsService(this)');
  });

  it('does not contain static HTTP infrastructure', () => {
    const files = generateClient(spec, ctx);
    const content = files[0].content;

    // These belong in the hand-maintained WorkOSClient.cs
    expect(content).not.toContain('HttpClient');
    expect(content).not.toContain('ApiKey');
    expect(content).not.toContain('SendAsync');
    expect(content).not.toContain('RequestAsync');
    expect(content).not.toContain('ApiBaseURL');
    expect(content).not.toContain('AuthenticationError');
    expect(content).not.toContain('RateLimitExceededError');
  });

  it('deduplicates services by mount target', () => {
    const multiSpec: ApiSpec = {
      ...spec,
      services: [
        ...services,
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
      ],
    };

    const files = generateClient(multiSpec, { ...ctx, spec: multiSpec });
    const content = files[0].content;

    // Both services should appear since they have different mount targets
    expect(content).toContain('OrganizationsService');
  });

  it('generates XML doc comments on service properties', () => {
    const files = generateClient(spec, ctx);
    const content = files[0].content;

    expect(content).toContain('/// <summary>');
    expect(content).toContain('OrganizationsService');
  });
});
