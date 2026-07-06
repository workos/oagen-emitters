import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Service, Operation, Model } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateTests } from '../../src/go/tests.js';

function makeOp(overrides: Partial<Operation>): Operation {
  return {
    name: 'getOrganization',
    httpMethod: 'get',
    path: '/organizations/{id}',
    pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
    queryParams: [],
    headerParams: [],
    requestBody: undefined,
    response: { kind: 'model', name: 'Organization' },
    errors: [],
    injectIdempotencyKey: false,
    ...overrides,
  };
}

function makeSpec(services: Service[], models: Model[] = []): ApiSpec {
  return {
    name: 'Test',
    version: '1.0.0',
    baseUrl: '',
    services,
    models: [
      {
        name: 'Organization',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
        ],
      },
      ...models,
    ],
    enums: [],
    sdk: defaultSdkBehavior(),
  };
}

function makeCtx(spec: ApiSpec): EmitterContext {
  return {
    namespace: 'workos',
    namespacePascal: 'WorkOS',
    spec,
  };
}

describe('go/tests', () => {
  it('generates test files and fixtures', () => {
    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [makeOp({})],
      },
    ];
    const spec = makeSpec(services);
    const files = generateTests(spec, makeCtx(spec));

    // Should have fixture files and test files
    const testFiles = files.filter((f) => f.path.endsWith('_test.go'));
    const fixtureFiles = files.filter((f) => f.path.startsWith('testdata/'));

    expect(testFiles.length).toBeGreaterThanOrEqual(1);
    expect(fixtureFiles.length).toBeGreaterThanOrEqual(1);
    // Fixtures overwrite rather than deep-merge, so a regen can't preserve
    // stale entries (e.g. an old `metadata: { "key": {} }` map placeholder).
    expect(fixtureFiles.every((f) => f.overwriteExisting === true)).toBe(true);
  });

  it('generates httptest-based tests', () => {
    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [makeOp({})],
      },
    ];
    const spec = makeSpec(services);
    const files = generateTests(spec, makeCtx(spec));
    const testFile = files.find((f) => f.path.endsWith('_test.go') && !f.path.includes('helpers'))!;
    const content = testFile.content;

    expect(content).toContain('package workos_test');
    expect(content).toContain('httptest.NewServer');
    expect(content).toContain('require.Equal');
    expect(content).toContain('workos.NewClient');
  });

  it('generates shared test helpers file', () => {
    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [makeOp({})],
      },
    ];
    const spec = makeSpec(services);
    const files = generateTests(spec, makeCtx(spec));
    const helperFile = files.find((f) => f.path === 'helpers_test.go')!;
    expect(helperFile).toBeDefined();
    expect(helperFile.content).toContain('ptrString');
    expect(helperFile.content).toContain('ptrInt');
    expect(helperFile.content).toContain('setupTestServer');
  });

  it('generates error test for 404 and 422', () => {
    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [makeOp({})],
      },
    ];
    const spec = makeSpec(services);
    const files = generateTests(spec, makeCtx(spec));
    const testFile = files.find((f) => f.path.endsWith('_test.go') && !f.path.includes('helpers'))!;
    const content = testFile.content;

    expect(content).toContain('Error404');
    expect(content).toContain('NotFoundError');
    expect(content).toContain('Error422');
    expect(content).toContain('UnprocessableEntityError');
  });

  it('generates delete operation tests with no response assertion', () => {
    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [
          makeOp({
            name: 'deleteOrganization',
            httpMethod: 'delete',
            response: { kind: 'primitive', type: 'unknown' },
          }),
        ],
      },
    ];
    const spec = makeSpec(services);
    const files = generateTests(spec, makeCtx(spec));
    const testFile = files.find((f) => f.path.endsWith('_test.go') && !f.path.includes('helpers'))!;
    const content = testFile.content;

    expect(content).toContain('StatusNoContent');
    expect(content).toContain('require.NoError(t, err)');
  });
});
