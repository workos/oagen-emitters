import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Service, Model } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateTests } from '../../src/android/tests.js';

const organizationModel: Model = {
  name: 'Organization',
  fields: [
    { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
    { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
  ],
};

const createBody: Model = {
  name: 'CreateOrganizationOptions',
  fields: [{ name: 'name', type: { kind: 'primitive', type: 'string' }, required: true }],
};

const service: Service = {
  name: 'Organizations',
  operations: [
    {
      name: 'create_organization',
      httpMethod: 'post',
      path: '/organizations',
      pathParams: [],
      queryParams: [],
      headerParams: [],
      requestBody: { kind: 'model', name: 'CreateOrganizationOptions' },
      response: { kind: 'model', name: 'Organization' },
      errors: [],
      injectIdempotencyKey: false,
    },
    {
      name: 'get_organization',
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

function makeCtx(services: Service[], models: Model[]): EmitterContext {
  const spec: ApiSpec = {
    name: 'Test',
    version: '1.0.0',
    baseUrl: 'https://api.example.com',
    services,
    models,
    enums: [],
    sdk: defaultSdkBehavior(),
  };
  return { namespace: 'workos', namespacePascal: 'WorkOS', spec };
}

describe('android/tests', () => {
  it('generates one JUnit suite per mount group plus the round-trip suite', () => {
    const ctx = makeCtx([service], [organizationModel, createBody]);
    const files = generateTests(ctx.spec, ctx);
    const paths = files.map((f) => f.path);
    expect(paths).toContain('src/test/kotlin/com/workos/android/OrganizationsTest.kt');
    expect(paths).toContain('src/test/kotlin/com/workos/android/ModelRoundTripTest.kt');
    const content = files[0].content;
    expect(content).toContain('package com.workos.android');
    expect(content).toContain('class OrganizationsTest {');
    expect(content).toContain('import org.junit.jupiter.api.Test');
    expect(content).toContain('import kotlinx.coroutines.test.runTest');
    expect(content).toContain('import com.workos.android.support.testClient');
  });

  it('emits no existence-only test (runtime contract §6 anti-pattern)', () => {
    const ctx = makeCtx([service], [organizationModel, createBody]);
    const content = generateTests(ctx.spec, ctx)[0].content ?? '';
    // Reachability is proven by the per-operation calls, not by asserting a symbol exists.
    expect(content).not.toContain('resource is reachable');
    expect(content).not.toMatch(/assertNotNull\(client\.\w+\)/);
  });

  it('emits §6 error-path tests derived from the spec error policy', () => {
    const ctx = makeCtx([service], [organizationModel, createBody]);
    const content = generateTests(ctx.spec, ctx)[0].content ?? '';
    // names come from ErrorPolicy.statusCodeMap, not hardcoded
    for (const [status, exc] of [
      [401, 'AuthenticationException'],
      [404, 'NotFoundException'],
      [429, 'RateLimitExceededException'],
      [400, 'BadRequestException'],
      [422, 'UnprocessableEntityException'],
      [500, 'ServerException'],
    ] as const) {
      expect(content, `missing ${status} test`).toContain(`assertFailsWith<${exc}>`);
      expect(content).toContain(`assertEquals(${status}, error.statusCode)`);
    }
    // a 429 must exercise the Retry-After path
    expect(content).toContain('mapOf("Retry-After" to "0")');
  });

  it('emits a §6 per-request-options test that asserts the header reached the wire', () => {
    const ctx = makeCtx([service], [organizationModel, createBody]);
    const content = generateTests(ctx.spec, ctx)[0].content ?? '';
    expect(content).toContain('fun `request options are honored on the wire`()');
    expect(content).toContain('RequestOptions(headers = mapOf("X-Custom" to "value"))');
    expect(content).toContain('assertEquals("value", request.headerValue("X-Custom"))');
  });

  it('emits §6 model round-trip tests that assert equality after encode+decode', () => {
    const ctx = makeCtx([service], [organizationModel, createBody]);
    const rt = generateTests(ctx.spec, ctx).find((f) => f.path.endsWith('ModelRoundTripTest.kt'));
    const content = rt?.content ?? '';
    expect(content).toContain('class ModelRoundTripTest {');
    expect(content).toContain('fun `Organization round-trips through JSON`()');
    expect(content).toContain('json.encodeToString(Organization.serializer(), original)');
    expect(content).toContain('assertEquals(original, decoded)');
  });

  it('asserts the HTTP method, path, and decoded response per operation', () => {
    const ctx = makeCtx([service], [organizationModel, createBody]);
    const content = generateTests(ctx.spec, ctx)[0].content;
    // backtick test names are the Kotlin convention
    expect(content).toContain('fun `create sends expected request`() =');
    expect(content).toContain('runTest {');
    expect(content).toContain('assertEquals("POST", request.method)');
    expect(content).toContain('assertEquals("/organizations", request.pathOnly())');
    // required body field is passed with a named argument
    expect(content).toContain('client.organizations.create(name = "test_name")');
    expect(content).toContain('assertTrue(request.bodyJson().containsKey("name"))');
    // the fixture id decodes back out
    expect(content).toContain('assertEquals("org_01234", result.id)');
  });

  it('substitutes a sample value for path params and asserts the rendered path', () => {
    const ctx = makeCtx([service], [organizationModel, createBody]);
    const content = generateTests(ctx.spec, ctx)[0].content;
    expect(content).toContain('client.organizations.get(id = "sample-id")');
    expect(content).toContain('assertEquals("/organizations/sample-id", request.pathOnly())');
  });

  it('escapes the fixture JSON as a Kotlin string literal', () => {
    const ctx = makeCtx([service], [organizationModel, createBody]);
    const content = generateTests(ctx.spec, ctx)[0].content;
    // quotes are escaped rather than emitted raw; a raw string would also
    // interpolate `$`, so an escaped literal is the safe form
    expect(content).toContain('testClient(responding = "{\\"id\\":');
    expect(content).not.toContain('"""');
  });

  it('skips an operation whose required body cannot be sample-constructed', () => {
    const unionService: Service = {
      name: 'Weird',
      operations: [
        {
          name: 'do_thing',
          httpMethod: 'post',
          path: '/weird',
          pathParams: [],
          queryParams: [],
          headerParams: [],
          requestBody: { kind: 'model', name: 'UnionBody' },
          response: { kind: 'model', name: 'Organization' },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    };
    const unionBody: Model = {
      name: 'UnionBody',
      fields: [
        {
          name: 'payload',
          type: {
            kind: 'union',
            variants: [
              { kind: 'model', name: 'A' },
              { kind: 'model', name: 'B' },
            ],
          },
          required: true,
        },
      ],
    };
    const ctx = makeCtx([unionService], [organizationModel, unionBody]);
    const suites = generateTests(ctx.spec, ctx).filter((f) => f.path.endsWith('WeirdTest.kt'));
    // No sampleable operation means no tests — emit no file rather than an empty
    // class, which would read as coverage while asserting nothing.
    expect(suites).toHaveLength(0);
  });

  it('suppresses the deprecation warning when calling a deprecated operation', () => {
    const deprecatedService: Service = {
      name: 'Organizations',
      operations: [
        {
          name: 'get_organization',
          httpMethod: 'get',
          path: '/organizations/{id}',
          pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
          queryParams: [],
          headerParams: [],
          response: { kind: 'model', name: 'Organization' },
          errors: [],
          injectIdempotencyKey: false,
          deprecated: true,
        },
      ],
    };
    const ctx = makeCtx([deprecatedService], [organizationModel]);
    expect(generateTests(ctx.spec, ctx)[0].content).toContain('@Suppress("DEPRECATION")');
  });

  it('imports every test-support extension it calls', () => {
    // pathOnly/bodyJson/queryParam are extension functions on RecordedRequest.
    // Kotlin only resolves an extension that is explicitly imported, so calling
    // one without its import is a compile error in every generated suite.
    const ctx = makeCtx([service], [organizationModel, createBody]);
    const content = generateTests(ctx.spec, ctx)[0].content ?? '';
    const support = 'com.workos.android.support';
    for (const helper of ['pathOnly', 'bodyJson']) {
      if (content.includes(`.${helper}()`)) {
        expect(content, `${helper} is called but not imported`).toContain(`import ${support}.${helper}`);
      }
    }
    if (content.includes('.queryParam(')) {
      expect(content).toContain(`import ${support}.queryParam`);
    }
    expect(content).toContain(`import ${support}.testClient`);
  });

  it('is deterministic across runs', () => {
    const ctx = makeCtx([service], [organizationModel, createBody]);
    expect(generateTests(ctx.spec, ctx)[0].content).toBe(generateTests(ctx.spec, ctx)[0].content);
  });
});
