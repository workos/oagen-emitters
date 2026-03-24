import { describe, it, expect } from 'vitest';
import { generateSerializers } from '../../src/node/serializers.js';
import type { EmitterContext, ApiSpec, Model, Service } from '@workos/oagen';

const emptySpec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: '',
  services: [],
  models: [],
  enums: [],
};

const ctx: EmitterContext = {
  namespace: 'workos',
  namespacePascal: 'WorkOS',
  spec: emptySpec,
};

describe('generateSerializers', () => {
  it('returns empty for no models', () => {
    expect(generateSerializers([], ctx)).toEqual([]);
  });

  it('generates deserializer with camelCase→snake_case mapping', () => {
    const service: Service = {
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
    };

    const models: Model[] = [
      {
        name: 'Organization',
        fields: [
          {
            name: 'id',
            type: { kind: 'primitive', type: 'string' },
            required: true,
          },
          {
            name: 'created_at',
            type: { kind: 'primitive', type: 'string', format: 'date-time' },
            required: true,
          },
          {
            name: 'external_id',
            type: {
              kind: 'nullable',
              inner: { kind: 'primitive', type: 'string' },
            },
            required: false,
          },
        ],
      },
    ];

    const ctxWithServices: EmitterContext = {
      ...ctx,
      spec: { ...emptySpec, services: [service], models },
    };

    const files = generateSerializers(models, ctxWithServices);
    expect(files.length).toBe(1);
    expect(files[0].path).toBe('src/organizations/serializers/organization.serializer.ts');

    const content = files[0].content;
    expect(content).toContain('export const deserializeOrganization');
    expect(content).toContain('  id: response.id,');
    expect(content).toContain('  createdAt: new Date(response.created_at),');
    expect(content).toContain('  externalId: response.external_id ?? null,');
  });

  it('generates nested model deserialization', () => {
    const service: Service = {
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
    };

    const models: Model[] = [
      {
        name: 'Organization',
        fields: [
          {
            name: 'id',
            type: { kind: 'primitive', type: 'string' },
            required: true,
          },
          {
            name: 'domains',
            type: {
              kind: 'array',
              items: { kind: 'model', name: 'OrganizationDomain' },
            },
            required: true,
          },
        ],
      },
      {
        name: 'OrganizationDomain',
        fields: [
          {
            name: 'id',
            type: { kind: 'primitive', type: 'string' },
            required: true,
          },
        ],
      },
    ];

    const ctxWithServices: EmitterContext = {
      ...ctx,
      spec: { ...emptySpec, services: [service], models },
    };

    const files = generateSerializers(models, ctxWithServices);
    const orgSerializer = files.find((f) => f.path.includes('organization.serializer.ts'))!;

    expect(orgSerializer.content).toContain('domains: response.domains.map(deserializeOrganizationDomain),');
    expect(orgSerializer.content).toContain('import { deserializeOrganizationDomain }');
    expect(orgSerializer.content).toContain('import { serializeOrganizationDomain }');
  });

  it('preserves null fallback for optional nullable model fields', () => {
    const service: Service = {
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
    };

    const models: Model[] = [
      {
        name: 'Organization',
        fields: [
          {
            name: 'id',
            type: { kind: 'primitive', type: 'string' },
            required: true,
          },
          {
            name: 'parent',
            type: {
              kind: 'nullable',
              inner: { kind: 'model', name: 'ParentOrg' },
            },
            required: false,
          },
        ],
      },
      {
        name: 'ParentOrg',
        fields: [
          {
            name: 'id',
            type: { kind: 'primitive', type: 'string' },
            required: true,
          },
        ],
      },
    ];

    const ctxWithServices: EmitterContext = {
      ...ctx,
      spec: { ...emptySpec, services: [service], models },
    };

    const files = generateSerializers(models, ctxWithServices);
    const orgSerializer = files.find((f) => f.path.includes('organization.serializer.ts'))!;
    const content = orgSerializer.content;

    // Deserialize: optional nullable model field should fall back to null, not undefined
    expect(content).toContain('parent: response.parent != null ?');
    expect(content).toContain(': null,');
    expect(content).not.toMatch(/parent:.*: undefined,/);

    // Serialize: optional nullable model field should fall back to null, not undefined
    expect(content).toContain('parent: model.parent != null ?');
    // Ensure the serialize side also uses null fallback
    const serializeSection = content.split('serializeOrganization')[1];
    expect(serializeSection).toContain(': null,');
    expect(serializeSection).not.toMatch(/parent:.*: undefined/);
  });

  it('generates serialize function for request body models', () => {
    const service: Service = {
      name: 'Organizations',
      operations: [
        {
          name: 'createOrganization',
          httpMethod: 'post',
          path: '/organizations',
          pathParams: [],
          queryParams: [],
          headerParams: [],
          requestBody: { kind: 'model', name: 'CreateOrganizationInput' },
          response: { kind: 'model', name: 'Organization' },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    };

    const models: Model[] = [
      {
        name: 'Organization',
        fields: [
          {
            name: 'id',
            type: { kind: 'primitive', type: 'string' },
            required: true,
          },
        ],
      },
      {
        name: 'CreateOrganizationInput',
        fields: [
          {
            name: 'name',
            type: { kind: 'primitive', type: 'string' },
            required: true,
          },
          {
            name: 'external_id',
            type: { kind: 'primitive', type: 'string' },
            required: false,
          },
        ],
      },
    ];

    const ctxWithServices: EmitterContext = {
      ...ctx,
      spec: { ...emptySpec, services: [service], models },
    };

    const files = generateSerializers(models, ctxWithServices);
    const inputSerializer = files.find((f) => f.path.includes('create-organization-input.serializer.ts'))!;

    // Should have both deserialize AND serialize
    expect(inputSerializer.content).toContain('export const deserializeCreateOrganizationInput');
    expect(inputSerializer.content).toContain('export const serializeCreateOrganizationInput');
  });

  it('skips per-domain ListMetadata serializers (Fix #5)', () => {
    const service: Service = {
      name: 'Connections',
      operations: [
        {
          name: 'listConnections',
          httpMethod: 'get',
          path: '/connections',
          pathParams: [],
          queryParams: [],
          headerParams: [],
          response: { kind: 'model', name: 'ConnectionList' },
          errors: [],
          injectIdempotencyKey: false,
          pagination: {
            strategy: 'cursor',
            param: 'after',
            itemType: { kind: 'model', name: 'Connection' },
          },
        },
      ],
    };

    const models: Model[] = [
      {
        name: 'ConnectionListListMetadata',
        fields: [
          {
            name: 'before',
            type: { kind: 'nullable', inner: { kind: 'primitive', type: 'string' } },
            required: false,
          },
          {
            name: 'after',
            type: { kind: 'nullable', inner: { kind: 'primitive', type: 'string' } },
            required: false,
          },
        ],
      },
      {
        name: 'Connection',
        fields: [
          {
            name: 'id',
            type: { kind: 'primitive', type: 'string' },
            required: true,
          },
        ],
      },
    ];

    const ctxWithServices: EmitterContext = {
      ...ctx,
      spec: { ...emptySpec, services: [service], models },
    };

    const files = generateSerializers(models, ctxWithServices);

    // The ListMetadata serializer should be skipped
    const listMetadataSerializer = files.find((f) => f.path.includes('list-metadata'));
    expect(listMetadataSerializer).toBeUndefined();

    // The Connection serializer should still be generated
    const connectionSerializer = files.find((f) => f.path.includes('connection.serializer.ts'));
    expect(connectionSerializer).toBeDefined();
  });

  it('skips per-domain list wrapper serializers (Fix #7)', () => {
    const service: Service = {
      name: 'Connections',
      operations: [
        {
          name: 'listConnections',
          httpMethod: 'get',
          path: '/connections',
          pathParams: [],
          queryParams: [],
          headerParams: [],
          response: { kind: 'model', name: 'ConnectionList' },
          errors: [],
          injectIdempotencyKey: false,
          pagination: {
            strategy: 'cursor',
            param: 'after',
            itemType: { kind: 'model', name: 'Connection' },
          },
        },
      ],
    };

    const models: Model[] = [
      {
        name: 'ConnectionList',
        fields: [
          {
            name: 'object',
            type: { kind: 'literal', value: 'list' },
            required: true,
          },
          {
            name: 'data',
            type: { kind: 'array', items: { kind: 'model', name: 'Connection' } },
            required: true,
          },
          {
            name: 'list_metadata',
            type: { kind: 'model', name: 'ConnectionListListMetadata' },
            required: true,
          },
        ],
      },
      {
        name: 'Connection',
        fields: [
          {
            name: 'id',
            type: { kind: 'primitive', type: 'string' },
            required: true,
          },
        ],
      },
    ];

    const ctxWithServices: EmitterContext = {
      ...ctx,
      spec: { ...emptySpec, services: [service], models },
    };

    const files = generateSerializers(models, ctxWithServices);

    // The list wrapper serializer should be skipped
    const listSerializer = files.find((f) => f.path.includes('connection-list.serializer.ts'));
    expect(listSerializer).toBeUndefined();

    // The Connection serializer should still be generated
    const connectionSerializer = files.find((f) => f.path.includes('connection.serializer.ts'));
    expect(connectionSerializer).toBeDefined();
  });
});
