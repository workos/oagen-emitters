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
  irVersion: 6,
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
    expect(files[0].content).toContain('  createdAt: string;');
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
});
