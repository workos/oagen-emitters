import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Service, Model } from '@workos/oagen';
import { generateResources } from '../../src/php/resources.js';
import { initializeNaming } from '../../src/php/naming.js';

const models: Model[] = [
  {
    name: 'Organization',
    fields: [
      { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
      { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
    ],
  },
  {
    name: 'CreateOrganizationRequest',
    fields: [
      { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
      { name: 'slug', type: { kind: 'primitive', type: 'string' }, required: false },
    ],
  },
];

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
      {
        name: 'listOrganizations',
        httpMethod: 'get',
        path: '/organizations',
        pathParams: [],
        queryParams: [
          { name: 'limit', type: { kind: 'primitive', type: 'integer' }, required: false },
          { name: 'after', type: { kind: 'primitive', type: 'string' }, required: false },
        ],
        headerParams: [],
        response: { kind: 'model', name: 'Organization' },
        errors: [],
        pagination: {
          strategy: 'cursor',
          param: 'after',
          dataPath: 'data',
          itemType: { kind: 'model', name: 'Organization' },
        },
        injectIdempotencyKey: false,
      },
      {
        name: 'createOrganization',
        httpMethod: 'post',
        path: '/organizations',
        pathParams: [],
        queryParams: [],
        headerParams: [],
        requestBody: { kind: 'model', name: 'CreateOrganizationRequest' },
        response: { kind: 'model', name: 'Organization' },
        errors: [],
        injectIdempotencyKey: false,
      },
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

const emptySpec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: '',
  services,
  models,
  enums: [],
};

const ctx: EmitterContext = {
  namespace: 'workos',
  namespacePascal: 'WorkOS',
  spec: emptySpec,
};

describe('generateResources', () => {
  it('returns empty array for no services', () => {
    expect(generateResources([], ctx)).toEqual([]);
  });

  it('generates a resource class with methods', () => {
    initializeNaming(models.map((m) => m.name));
    const result = generateResources(services, ctx);

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('lib/Resources/Organizations.php');
    expect(result[0].content).toContain('class Organizations');
    expect(result[0].content).toContain('private readonly \\WorkOS\\HttpClient $client');
  });

  it('generates GET by ID method with path interpolation', () => {
    initializeNaming(models.map((m) => m.name));
    const result = generateResources(services, ctx);

    expect(result[0].content).toContain('public function get(');
    expect(result[0].content).toContain('string $id');
    expect(result[0].content).toContain('"organizations/{$id}"');
    expect(result[0].content).toContain('Organization::fromArray($response)');
  });

  it('generates paginated list method', () => {
    initializeNaming(models.map((m) => m.name));
    const result = generateResources(services, ctx);

    expect(result[0].content).toContain('public function list(');
    expect(result[0].content).toContain('?int $limit = null');
    expect(result[0].content).toContain('PaginatedResponse');
  });

  it('generates create method with body params', () => {
    initializeNaming(models.map((m) => m.name));
    const result = generateResources(services, ctx);

    expect(result[0].content).toContain('public function create(');
    expect(result[0].content).toContain('string $name');
    expect(result[0].content).toContain('?string $slug = null');
  });

  it('generates delete method returning void', () => {
    initializeNaming(models.map((m) => m.name));
    const result = generateResources(services, ctx);

    expect(result[0].content).toContain('): void');
  });

  it('generates correct namespace', () => {
    initializeNaming(models.map((m) => m.name));
    const result = generateResources(services, ctx);

    expect(result[0].content).toContain('namespace WorkOS\\Resources;');
  });
});
