import { describe, it, expect } from 'vitest';
import { generateModels } from '../../src/node/models.js';
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

describe('generateModels', () => {
  it('returns empty for no models', () => {
    expect(generateModels([], ctx)).toEqual([]);
  });

  it('generates domain and response interfaces for a model', () => {
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
            name: 'name',
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

    const files = generateModels(models, ctxWithServices);
    expect(files.length).toBe(1);
    expect(files[0].path).toBe('src/organizations/interfaces/organization.interface.ts');

    // Domain interface has camelCase fields
    expect(files[0].content).toContain('export interface Organization {');
    expect(files[0].content).toContain('  id: string;');
    expect(files[0].content).toContain('  name: string;');
    expect(files[0].content).toContain('  createdAt: Date;');
    expect(files[0].content).toContain('  externalId?: string | null;');

    // Response interface has snake_case fields
    expect(files[0].content).toContain('export interface OrganizationResponse {');
    expect(files[0].content).toContain('  created_at: string;');
    expect(files[0].content).toContain('  external_id?: string | null;');
  });

  it('generates imports for referenced models', () => {
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
          {
            name: 'domain',
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

    const files = generateModels(models, ctxWithServices);

    // Organization file should import OrganizationDomain
    const orgFile = files.find((f) => f.path.includes('organization.interface.ts'))!;
    expect(orgFile.content).toContain(
      "import type { OrganizationDomain, OrganizationDomainResponse } from './organization-domain.interface';",
    );

    // Domain interface uses OrganizationDomain[]
    expect(orgFile.content).toContain('  domains: OrganizationDomain[];');

    // Response interface uses OrganizationDomainResponse[]
    expect(orgFile.content).toContain('  domains: OrganizationDomainResponse[];');
  });

  it('handles generic type params', () => {
    const models: Model[] = [
      {
        name: 'DirectoryUser',
        typeParams: [
          {
            name: 'TCustom',
            default: {
              kind: 'map',
              valueType: { kind: 'primitive', type: 'unknown' },
            },
          },
        ],
        fields: [
          {
            name: 'id',
            type: { kind: 'primitive', type: 'string' },
            required: true,
          },
        ],
      },
    ];

    const files = generateModels(models, ctx);
    expect(files[0].content).toContain('export interface DirectoryUser<TCustom = Record<string, any>> {');
    expect(files[0].content).toContain('export interface DirectoryUserResponse<TCustom = Record<string, any>> {');
  });

  it('uses Wire suffix for models already ending in Response', () => {
    const service: Service = {
      name: 'PortalSessions',
      operations: [
        {
          name: 'createPortalSession',
          httpMethod: 'post',
          path: '/portal/sessions',
          pathParams: [],
          queryParams: [],
          headerParams: [],
          response: { kind: 'model', name: 'PortalSessionsCreateResponse' },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    };

    const models: Model[] = [
      {
        name: 'PortalSessionsCreateResponse',
        fields: [
          {
            name: 'link',
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

    const files = generateModels(models, ctxWithServices);
    const content = files[0].content;

    // Should use Wire suffix, not ResponseResponse
    expect(content).toContain('export interface PortalSessionsCreateResponseWire {');
    expect(content).not.toContain('PortalSessionsCreateResponseResponse');
  });

  it('renders @deprecated on fields', () => {
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
            name: 'legacy_slug',
            type: { kind: 'primitive', type: 'string' },
            required: false,
            description: 'Use external_id instead.',
            deprecated: true,
          },
          {
            name: 'old_field',
            type: { kind: 'primitive', type: 'string' },
            required: false,
            deprecated: true,
          },
        ],
      },
    ];

    const ctxWithServices: EmitterContext = {
      ...ctx,
      spec: { ...emptySpec, services: [service], models },
    };

    const files = generateModels(models, ctxWithServices);
    const content = files[0].content;

    // Field with description + deprecated gets multiline JSDoc
    expect(content).toContain('  /**\n   * Use external_id instead.\n   * @deprecated\n   */');

    // Field with only deprecated gets single-line JSDoc
    expect(content).toContain('  /** @deprecated */');
  });

  it('renders field-level JSDoc from OpenAPI descriptions', () => {
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
        description: 'An organization in the WorkOS system.',
        fields: [
          {
            name: 'id',
            type: { kind: 'primitive', type: 'string' },
            required: true,
            description: 'Unique identifier for the organization.',
          },
          {
            name: 'name',
            type: { kind: 'primitive', type: 'string' },
            required: true,
            description: 'The display name of the organization.',
          },
          {
            name: 'created_at',
            type: { kind: 'primitive', type: 'string', format: 'date-time' },
            required: true,
            // No description — should not get JSDoc
          },
          {
            name: 'allow_profiles_outside_organization',
            type: { kind: 'primitive', type: 'boolean' },
            required: false,
            description:
              'Whether connections within the organization allow profiles\nthat do not have a domain that is verified by the organization.',
          },
        ],
      },
    ];

    const ctxWithServices: EmitterContext = {
      ...ctx,
      spec: { ...emptySpec, services: [service], models },
    };

    const files = generateModels(models, ctxWithServices);
    const content = files[0].content;

    // Model-level JSDoc is emitted
    expect(content).toContain('/** An organization in the WorkOS system. */');

    // Fields with description get per-field JSDoc
    expect(content).toContain('/** Unique identifier for the organization. */');
    expect(content).toContain('/** The display name of the organization. */');

    // Multiline description renders correctly
    expect(content).toContain(
      '  /**\n   * Whether connections within the organization allow profiles\n   * that do not have a domain that is verified by the organization.\n   */',
    );

    // Field without description does NOT get JSDoc
    const lines = content.split('\n');
    const createdAtIdx = lines.findIndex((l) => l.includes('createdAt'));
    expect(createdAtIdx).toBeGreaterThan(0);
    // The line before createdAt should not be a JSDoc closing tag
    expect(lines[createdAtIdx - 1].trim()).not.toBe('*/');
  });

  it('renders readOnly/writeOnly/default annotations', () => {
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
            readOnly: true,
          },
          {
            name: 'secret_key',
            type: { kind: 'primitive', type: 'string' },
            required: true,
            writeOnly: true,
          },
          {
            name: 'status',
            type: { kind: 'primitive', type: 'string' },
            required: false,
            default: 'active',
          },
        ],
      },
    ];

    const ctxWithServices: EmitterContext = {
      ...ctx,
      spec: { ...emptySpec, services: [service], models },
    };

    const files = generateModels(models, ctxWithServices);
    const content = files[0].content;

    // readOnly field gets @readonly JSDoc and readonly TS modifier
    expect(content).toContain('/** @readonly */');
    expect(content).toContain('  readonly id: string;');

    // writeOnly field gets @writeonly JSDoc
    expect(content).toContain('/** @writeonly */');

    // default field gets @default JSDoc
    expect(content).toContain('@default "active"');
  });

  it('skips per-domain ListMetadata models (Fix #4)', () => {
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

    const files = generateModels(models, ctxWithServices);

    // The ListMetadata model should be skipped entirely
    const listMetadataFile = files.find((f) => f.path.includes('list-metadata'));
    expect(listMetadataFile).toBeUndefined();

    // The Connection model should still be generated
    const connectionFile = files.find((f) => f.path.includes('connection.interface.ts'));
    expect(connectionFile).toBeDefined();
  });

  it('skips per-domain list wrapper models (Fix #6)', () => {
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

    const files = generateModels(models, ctxWithServices);

    // The list wrapper model should be skipped
    const listFile = files.find((f) => f.path.includes('connection-list.interface.ts'));
    expect(listFile).toBeUndefined();

    // The ListMetadata model should also be skipped
    const listMetadataFile = files.find((f) => f.path.includes('list-metadata'));
    expect(listMetadataFile).toBeUndefined();

    // The Connection model should still be generated
    const connectionFile = files.find((f) => f.path.includes('connection.interface.ts'));
    expect(connectionFile).toBeDefined();
  });

  it('does not skip models that only partially match list-metadata shape', () => {
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
          response: { kind: 'model', name: 'Pagination' },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    };

    const models: Model[] = [
      {
        name: 'Pagination',
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
          {
            name: 'total',
            type: { kind: 'primitive', type: 'integer' },
            required: true,
          },
        ],
      },
    ];

    const ctxWithServices: EmitterContext = {
      ...ctx,
      spec: { ...emptySpec, services: [service], models },
    };

    const files = generateModels(models, ctxWithServices);
    // Model with 3 fields should NOT be skipped even if it has before/after
    expect(files.length).toBe(1);
    expect(files[0].path).toContain('pagination.interface.ts');
  });
});

describe('model deduplication', () => {
  it('emits type alias for structurally identical models', () => {
    const service: Service = {
      name: 'Roles',
      operations: [
        {
          name: 'getRole',
          httpMethod: 'get',
          path: '/roles/{id}',
          pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
          queryParams: [],
          headerParams: [],
          response: { kind: 'model', name: 'EnvironmentRole' },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    };

    const models: Model[] = [
      {
        name: 'EnvironmentRole',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'type', type: { kind: 'literal', value: 'environment_role' }, required: true },
        ],
      },
      {
        name: 'OrganizationRole',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'type', type: { kind: 'literal', value: 'environment_role' }, required: true },
        ],
      },
    ];

    const ctxWithServices: EmitterContext = {
      ...ctx,
      spec: { ...emptySpec, services: [service], models },
    };

    const files = generateModels(models, ctxWithServices);
    expect(files.length).toBe(2);

    // First model: full interface
    expect(files[0].content).toContain('export interface EnvironmentRole');

    // Second model: type alias referencing canonical
    expect(files[1].content).toContain('export type OrganizationRole = EnvironmentRole');
    expect(files[1].content).toContain('export type OrganizationRoleResponse = EnvironmentRoleResponse');
  });
});
