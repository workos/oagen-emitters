import { describe, it, expect } from 'vitest';
import { generateModels } from '../../src/python/models.js';
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

  it('generates a dataclass for a model', () => {
    const service: Service = {
      name: 'Organizations',
      operations: [
        {
          name: 'getOrganization',
          httpMethod: 'get',
          path: '/organizations/{id}',
          pathParams: [
            {
              name: 'id',
              type: { kind: 'primitive', type: 'string' },
              required: true,
            },
          ],
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
    // Model file + barrel __init__.py
    expect(files.length).toBe(2);

    const modelFile = files.find((f) => f.path === 'workos/organizations/models/organization.py')!;
    expect(modelFile).toBeDefined();

    // Has dataclass decorator
    expect(modelFile.content).toContain('@dataclass');
    expect(modelFile.content).toContain('class Organization:');

    // Required fields
    expect(modelFile.content).toContain('    id: str');
    expect(modelFile.content).toContain('    name: str');
    expect(modelFile.content).toContain('    created_at: str');

    // Optional/nullable field
    expect(modelFile.content).toContain('    external_id: Optional[str] = None');

    // from_dict method
    expect(modelFile.content).toContain('def from_dict(cls, data: Dict[str, Any])');

    // to_dict method
    expect(modelFile.content).toContain('def to_dict(self) -> Dict[str, Any]:');
  });

  it('handles array fields with model refs', () => {
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
    // 2 model files + 1 barrel __init__.py
    expect(files.length).toBe(3);

    const orgFile = files.find((f) => f.path.includes('organization.py') && !f.path.includes('organization_domain'));
    expect(orgFile).toBeDefined();
    expect(orgFile!.content).toContain('domains: List["OrganizationDomain"]');
    expect(orgFile!.content).toContain('OrganizationDomain.from_dict(item) for item in');
  });

  it('handles map fields', () => {
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
            name: 'metadata',
            type: {
              kind: 'map',
              valueType: { kind: 'primitive', type: 'string' },
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
    // 1 model file + 1 barrel __init__.py
    expect(files.length).toBe(2);
    const modelFile = files.find((f) => f.path.endsWith('organization.py'))!;
    expect(modelFile.content).toContain('metadata: Optional[Dict[str, str]] = None');
  });
});
