import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Service, Model } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateResources, resolveResourceClassName, hasCompatibleConstructor } from '../../src/node/resources.js';

const emptySpec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: '',
  services: [],
  models: [],
  enums: [],
  sdk: defaultSdkBehavior(),
};

const ctx: EmitterContext = {
  namespace: 'workos',
  namespacePascal: 'WorkOS',
  spec: emptySpec,
};

describe('generateResources', () => {
  it('returns empty for no services', () => {
    expect(generateResources([], ctx)).toEqual([]);
  });

  it('generates a resource class with GET method', () => {
    const orgModel: Model = {
      name: 'Organization',
      fields: [
        { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
        { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
      ],
    };

    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [
          {
            name: 'getOrganization',
            httpMethod: 'get',
            path: '/organizations/{id}',
            pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model', name: 'Organization' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const spec: ApiSpec = { ...emptySpec, services, models: [orgModel] };
    const ctxWithSpec: EmitterContext = { ...ctx, spec };
    const result = generateResources(services, ctxWithSpec);

    expect(result.length).toBeGreaterThan(0);
    const resourceFile = result.find((f) => f.path.includes('organizations.ts'));
    expect(resourceFile).toBeDefined();
    expect(resourceFile!.content).toContain('export class Organizations');
    expect(resourceFile!.content).toContain('constructor(private readonly workos: WorkOS)');
    expect(resourceFile!.content).toContain('async getOrganization(id: string): Promise<Organization>');
    expect(resourceFile!.content).toContain('deserializeOrganization(data)');
  });

  it('generates DELETE method returning void', () => {
    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [
          {
            name: 'deleteOrganization',
            httpMethod: 'delete',
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
    ];

    const spec: ApiSpec = { ...emptySpec, services };
    const ctxWithSpec: EmitterContext = { ...ctx, spec };
    const result = generateResources(services, ctxWithSpec);

    const resourceFile = result.find((f) => f.path.includes('organizations.ts'));
    expect(resourceFile).toBeDefined();
    expect(resourceFile!.content).toContain('Promise<void>');
  });
});

describe('resolveResourceClassName', () => {
  it('uses overlay name when baseline has compatible constructor', () => {
    const service: Service = { name: 'Organizations', operations: [] };
    const ctxWithBaseline: EmitterContext = {
      ...ctx,
      apiSurface: {
        classes: {
          Organizations: {
            constructorParams: [{ name: 'workos', type: 'WorkOS' }],
          },
        },
      } as any,
    };
    expect(resolveResourceClassName(service, ctxWithBaseline)).toBe('Organizations');
  });

  it('appends Endpoints suffix when IR name collides with overlay name', () => {
    const service: Service = {
      name: 'Webhooks',
      operations: [
        {
          name: 'listWebhooks',
          httpMethod: 'get',
          path: '/webhooks',
          pathParams: [],
          queryParams: [],
          headerParams: [],
          response: { kind: 'primitive', type: 'unknown' },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    };
    const ctxWithIncompat: EmitterContext = {
      ...ctx,
      apiSurface: {
        classes: {
          Webhooks: {
            constructorParams: [{ name: 'crypto', type: 'CryptoProvider' }],
          },
        },
      } as any,
      resolvedOperations: [
        {
          operation: service.operations[0],
          service,
          methodName: 'list_webhooks',
          mountOn: 'Webhooks',
          defaults: {},
          inferFromClient: [],
          urlBuilder: false,
        },
      ],
    };
    expect(resolveResourceClassName(service, ctxWithIncompat)).toBe('WebhooksEndpoints');
  });
});

describe('hasCompatibleConstructor', () => {
  it('returns true when no baseline exists', () => {
    expect(hasCompatibleConstructor('NewService', ctx)).toBe(true);
  });

  it('returns true when baseline has workos: WorkOS param', () => {
    const ctxWithBaseline: EmitterContext = {
      ...ctx,
      apiSurface: {
        classes: {
          Organizations: {
            constructorParams: [{ name: 'workos', type: 'WorkOS' }],
          },
        },
      } as any,
    };
    expect(hasCompatibleConstructor('Organizations', ctxWithBaseline)).toBe(true);
  });

  it('returns false when baseline has incompatible constructor', () => {
    const ctxWithIncompat: EmitterContext = {
      ...ctx,
      apiSurface: {
        classes: {
          Webhooks: {
            constructorParams: [{ name: 'crypto', type: 'CryptoProvider' }],
          },
        },
      } as any,
    };
    expect(hasCompatibleConstructor('Webhooks', ctxWithIncompat)).toBe(false);
  });

  it('returns true when baseline has no constructor params', () => {
    const ctxWithEmptyCtor: EmitterContext = {
      ...ctx,
      apiSurface: {
        classes: {
          Utils: {
            constructorParams: [],
          },
        },
      } as any,
    };
    expect(hasCompatibleConstructor('Utils', ctxWithEmptyCtor)).toBe(true);
  });
});
