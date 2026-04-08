import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Service, Model } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateTests } from '../../src/php/tests.js';

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
        name: 'listOrganizations',
        httpMethod: 'get',
        path: '/organizations',
        pathParams: [],
        queryParams: [{ name: 'after', type: { kind: 'primitive', type: 'string' }, required: false }],
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
    ],
  },
];

const spec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: '',
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

describe('generateTests', () => {
  it('does not generate TestHelper (now hand-maintained)', () => {
    const result = generateTests(spec, ctx);

    const helper = result.find((f) => f.path === 'tests/TestHelper.php');
    expect(helper).toBeUndefined();
  });

  it('generates resource test files', () => {
    const result = generateTests(spec, ctx);

    const resourceTest = result.find((f) => f.path === 'tests/Service/OrganizationsTest.php');
    expect(resourceTest).toBeDefined();
    expect(resourceTest!.content).toContain('class OrganizationsTest extends TestCase');
    expect(resourceTest!.content).toContain('use TestHelper;');
    expect(resourceTest!.content).toContain('testGet');
    // Round-trip assertion: fromArray → toArray must not throw
    expect(resourceTest!.content).toContain('$result->toArray()');
  });

  it('generates client test', () => {
    const result = generateTests(spec, ctx);

    const clientTest = result.find((f) => f.path === 'tests/ClientTest.php');
    expect(clientTest).toBeDefined();
    expect(clientTest!.content).toContain('testConstructor');
  });

  it('generates pagination boundary test with cursor null assertions', () => {
    const result = generateTests(spec, ctx);

    const resourceTest = result.find((f) => f.path === 'tests/Service/OrganizationsTest.php');
    expect(resourceTest).toBeDefined();
    expect(resourceTest!.content).toContain('testPaginationBoundary');
    // Cursor null assertions
    expect(resourceTest!.content).toContain("$this->assertNull($result->listMetadata['before'])");
    expect(resourceTest!.content).toContain("$this->assertNull($result->listMetadata['after'])");
    // Iteration still tested
    expect(resourceTest!.content).toContain('foreach ($result as $item)');
  });

  it('generates fixture JSON files', () => {
    const result = generateTests(spec, ctx);

    const fixture = result.find((f) => f.path.includes('Fixtures/organization.json'));
    expect(fixture).toBeDefined();
    const parsed = JSON.parse(fixture!.content);
    expect(parsed).toHaveProperty('id');
    expect(parsed).toHaveProperty('name');
  });
});
