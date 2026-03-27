import { describe, it, expect } from 'vitest';
import { generateTests } from '../../src/python/tests.js';
import type { EmitterContext, ApiSpec, Service, Model } from '@workos/oagen';

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

describe('generateTests', () => {
  it('generates conftest.py', () => {
    const files = generateTests(spec, ctx);
    const conftest = files.find((f) => f.path === 'tests/conftest.py');
    expect(conftest).toBeDefined();
    expect(conftest!.content).toContain('import pytest');
    expect(conftest!.content).toContain('from workos import WorkOS');
    expect(conftest!.content).toContain('def load_fixture(name: str)');
    expect(conftest!.content).toContain('@pytest.fixture');
  });

  it('generates per-service test file', () => {
    const files = generateTests(spec, ctx);
    const testFile = files.find((f) => f.path === 'tests/test_organizations.py');
    expect(testFile).toBeDefined();

    const content = testFile!.content;
    expect(content).toContain('class TestOrganizations:');
    expect(content).toContain('def test_get_organization(');
    expect(content).toContain('def test_delete_organization(');
    expect(content).toContain('assert result is None');
    expect(content).toContain('isinstance(result, Organization)');
  });

  it('generates error test', () => {
    const files = generateTests(spec, ctx);
    const testFile = files.find((f) => f.path === 'tests/test_organizations.py');
    expect(testFile!.content).toContain('def test_get_organization_unauthorized(');
    expect(testFile!.content).toContain('pytest.raises(AuthenticationError)');
  });

  it('generates fixture JSON files', () => {
    const files = generateTests(spec, ctx);
    const fixture = files.find((f) => f.path === 'tests/fixtures/organization.json');
    expect(fixture).toBeDefined();
    expect(fixture!.headerPlacement).toBe('skip');

    const data = JSON.parse(fixture!.content);
    expect(data).toHaveProperty('id');
    expect(data).toHaveProperty('name');
  });
});
