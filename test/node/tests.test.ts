import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ApiSpec, EmitterContext, Service, Model } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { nodeEmitter } from '../../src/node/index.js';

const groupModel: Model = {
  name: 'Group',
  fields: [
    { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
    { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
  ],
};

const groupService: Service = {
  name: 'Groups',
  operations: [
    {
      name: 'getGroup',
      httpMethod: 'get',
      path: '/organizations/{organizationId}/groups/{groupId}',
      pathParams: [
        { name: 'organizationId', type: { kind: 'primitive', type: 'string' }, required: true },
        { name: 'groupId', type: { kind: 'primitive', type: 'string' }, required: true },
      ],
      queryParams: [],
      headerParams: [],
      response: { kind: 'model', name: 'Group' },
      errors: [],
      injectIdempotencyKey: false,
    },
  ],
};

const spec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: '',
  services: [groupService],
  models: [groupModel],
  enums: [],
  sdk: defaultSdkBehavior(),
};

const ctx: EmitterContext = {
  namespace: 'workos',
  namespacePascal: 'WorkOS',
  spec,
};

function createTrackedSdkRoot(withHandTests = false): string {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'node-owned-tests-'));
  fs.mkdirSync(path.join(tmpRoot, 'src', 'groups'), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'src', 'groups', 'fixtures'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'src', 'workos.ts'), '// @oagen-ignore-file\nexport class WorkOS {}\n');
  if (withHandTests) {
    fs.writeFileSync(path.join(tmpRoot, 'src', 'groups', 'groups.spec.ts'), "describe('old', () => {});\n");
    fs.writeFileSync(path.join(tmpRoot, 'src', 'groups', 'fixtures', 'group.json'), '{"id":"old"}\n');
  }
  execFileSync('git', ['init'], { cwd: tmpRoot, stdio: 'ignore' });
  execFileSync('git', ['add', 'src'], { cwd: tmpRoot, stdio: 'ignore' });
  return tmpRoot;
}

describe('node test generation ownership', () => {
  it('regenerates tests and fixtures for owned services', () => {
    const tmpRoot = createTrackedSdkRoot();
    try {
      const result = nodeEmitter.generateTests!(spec, {
        ...ctx,
        outputDir: tmpRoot,
        emitterOptions: { ownedServices: ['Groups'], regenerateOwnedTests: true },
      } as EmitterContext);

      const testFile = result.find((f) => f.path === 'src/groups/groups.spec.ts');
      const fixtureFile = result.find((f) => f.path === 'src/groups/fixtures/group.json');
      expect(testFile).toBeDefined();
      expect(testFile!.overwriteExisting).toBe(true);
      expect(fixtureFile).toBeDefined();
      expect(fixtureFile!.overwriteExisting).toBe(true);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('regenerates over hand-written tests and fixtures for owned services', () => {
    const tmpRoot = createTrackedSdkRoot(true);
    try {
      const result = nodeEmitter.generateTests!(spec, {
        ...ctx,
        outputDir: tmpRoot,
        emitterOptions: { ownedServices: ['Groups'], regenerateOwnedTests: true },
      } as EmitterContext);

      expect(result.some((f) => f.path === 'src/groups/groups.spec.ts')).toBe(true);
      expect(result.some((f) => f.path === 'src/groups/fixtures/group.json')).toBe(true);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('skips tests and fixtures when the service is not owned', () => {
    const tmpRoot = createTrackedSdkRoot();
    try {
      const result = nodeEmitter.generateTests!(spec, {
        ...ctx,
        outputDir: tmpRoot,
        emitterOptions: { regenerateOwnedTests: true },
      } as EmitterContext);

      expect(result.some((f) => f.path.startsWith('src/groups/'))).toBe(false);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('emits tests and fixtures for adopted services when regenerateOwnedTests is true', () => {
    // Adopted dirs are created by oagen from scratch — no hand-written content
    // to preserve, so scaffolding tests/fixtures is safe and useful.
    const tmpRoot = createTrackedSdkRoot();
    try {
      const result = nodeEmitter.generateTests!(spec, {
        ...ctx,
        outputDir: tmpRoot,
        emitterOptions: { adoptMissingServices: true, regenerateOwnedTests: true },
      } as EmitterContext);

      const testFile = result.find((f) => f.path === 'src/groups/groups.spec.ts');
      const fixtureFile = result.find((f) => f.path === 'src/groups/fixtures/group.json');
      expect(testFile).toBeDefined();
      expect(fixtureFile).toBeDefined();
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('skips tests for adopted services when regenerateOwnedTests is false', () => {
    const tmpRoot = createTrackedSdkRoot();
    try {
      const result = nodeEmitter.generateTests!(spec, {
        ...ctx,
        outputDir: tmpRoot,
        emitterOptions: { adoptMissingServices: true },
      } as EmitterContext);

      expect(result.some((f) => f.path.startsWith('src/groups/'))).toBe(false);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('skips tests when the resource class diverges from the mount accessor', () => {
    // Hand-written `Webhooks` has a constructor incompatible with WorkOS,
    // so the emitter forks endpoint methods onto a `WebhooksEndpoints`
    // helper class. A generated test would call `workos.webhooks.foo(...)`
    // — but those methods live on the helper, not the crypto class. Skip
    // these tests so we don't ship a spec that fails to compile.
    const webhookOp = {
      name: 'listWebhookEndpoints',
      httpMethod: 'get' as const,
      path: '/webhook_endpoints',
      pathParams: [],
      queryParams: [],
      headerParams: [],
      response: { kind: 'primitive' as const, type: 'unknown' as const },
      errors: [],
      injectIdempotencyKey: false,
    };
    const webhookService: Service = { name: 'Webhooks', operations: [webhookOp] };
    const webhookSpec: ApiSpec = {
      ...spec,
      services: [webhookService],
    };

    const tmpRoot = createTrackedSdkRoot();
    try {
      const result = nodeEmitter.generateTests!(webhookSpec, {
        ...ctx,
        spec: webhookSpec,
        outputDir: tmpRoot,
        emitterOptions: { adoptMissingServices: true, regenerateOwnedTests: true },
        apiSurface: {
          classes: {
            Webhooks: {
              constructorParams: [{ name: 'crypto', type: 'CryptoProvider' }],
            },
            WorkOS: {
              properties: { webhooks: { type: 'Webhooks' } },
            },
          },
        },
        resolvedOperations: [
          {
            operation: webhookOp,
            service: webhookService,
            methodName: 'list_webhook_endpoints',
            mountOn: 'Webhooks',
            defaults: {},
            inferFromClient: [],
            urlBuilder: false,
          },
        ],
      } as unknown as EmitterContext);

      expect(result.some((f) => f.path === 'src/webhooks/webhooks-endpoints.spec.ts')).toBe(false);
      expect(result.some((f) => f.path === 'src/webhooks/webhooks.spec.ts')).toBe(false);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('asserts wire format on all-optional request bodies instead of toBeDefined()', () => {
    // For PATCH/Update bodies where every field is optional, the test
    // emitter previously fell back to `expect(fetchBody()).toBeDefined()`,
    // which passes even if the serializer writes the wrong keys. Picking a
    // couple of optional fields with deterministic fixture values makes the
    // test actually validate snake_case conversion on the wire.
    const updateModel: Model = {
      name: 'UpdateGroup',
      fields: [
        { name: 'name', type: { kind: 'primitive', type: 'string' }, required: false },
        { name: 'description', type: { kind: 'primitive', type: 'string' }, required: false },
      ],
    };

    const updateOp = {
      name: 'updateGroup',
      httpMethod: 'patch' as const,
      path: '/organizations/{organizationId}/groups/{id}',
      pathParams: [
        { name: 'organizationId', type: { kind: 'primitive' as const, type: 'string' as const }, required: true },
        { name: 'id', type: { kind: 'primitive' as const, type: 'string' as const }, required: true },
      ],
      queryParams: [],
      headerParams: [],
      response: { kind: 'model' as const, name: 'Group' },
      requestBody: { kind: 'model' as const, name: 'UpdateGroup' },
      errors: [],
      injectIdempotencyKey: false,
    };

    const updateService: Service = { name: 'Groups', operations: [updateOp] };
    const updateSpec: ApiSpec = {
      ...spec,
      models: [groupModel, updateModel],
      services: [updateService],
    };
    const tmpRoot = createTrackedSdkRoot();
    try {
      const result = nodeEmitter.generateTests!(updateSpec, {
        ...ctx,
        spec: updateSpec,
        outputDir: tmpRoot,
        emitterOptions: { ownedServices: ['Groups'], regenerateOwnedTests: true },
      } as EmitterContext);

      const testFile = result.find((f) => f.path === 'src/groups/groups.spec.ts');
      expect(testFile).toBeDefined();
      const content = testFile!.content;
      // The body assertion picks at least one optional field and checks its
      // snake_case wire format — not just `.toBeDefined()`.
      expect(content).toContain('expect(fetchBody()).toEqual(');
      expect(content).toMatch(/expect\.objectContaining\(\{[^}]*\bname\b/);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('asserts toBeNull() for nullable fields whose example is null', () => {
    // When the spec gives `example: null` on a nullable field — common for
    // optional date-times like `last_used_at` — the previous emitter would
    // emit `expect(x.toISOString()).toBe(null)`, which both blows up at
    // runtime on a null `x` and never matches when `x` is a Date.
    const secretModel: Model = {
      name: 'Secret',
      fields: [
        { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true, example: 'sec_1' },
        {
          name: 'last_used_at',
          type: {
            kind: 'nullable',
            inner: { kind: 'primitive', type: 'string', format: 'date-time' },
          },
          required: true,
          example: null,
        },
        {
          name: 'created_at',
          type: { kind: 'primitive', type: 'string', format: 'date-time' },
          required: true,
          example: '2026-01-15T12:00:00.000Z',
        },
      ],
    };

    const showOp = {
      name: 'showSecret',
      httpMethod: 'get' as const,
      path: '/secrets/{id}',
      pathParams: [{ name: 'id', type: { kind: 'primitive' as const, type: 'string' as const }, required: true }],
      queryParams: [],
      headerParams: [],
      response: { kind: 'model' as const, name: 'Secret' },
      errors: [],
      injectIdempotencyKey: false,
    };
    const secretService: Service = { name: 'Secrets', operations: [showOp] };
    const secretSpec: ApiSpec = {
      ...spec,
      models: [secretModel],
      services: [secretService],
    };
    const tmpRoot = createTrackedSdkRoot();
    try {
      fs.mkdirSync(path.join(tmpRoot, 'src', 'secrets', 'fixtures'), { recursive: true });
      execFileSync('git', ['add', 'src'], { cwd: tmpRoot, stdio: 'ignore' });

      const result = nodeEmitter.generateTests!(secretSpec, {
        ...ctx,
        spec: secretSpec,
        outputDir: tmpRoot,
        emitterOptions: { ownedServices: ['Secrets'], regenerateOwnedTests: true },
      } as EmitterContext);

      const testFile = result.find((f) => f.path === 'src/secrets/secrets.spec.ts');
      expect(testFile).toBeDefined();
      const content = testFile!.content;
      // Null example on a nullable date-time → toBeNull(), not `.toISOString().toBe(null)`.
      expect(content).toContain('expect(result.lastUsedAt).toBeNull();');
      expect(content).not.toContain('lastUsedAt.toISOString()).toBe(null)');
      // Non-null date-time examples still go through `.toISOString()`.
      expect(content).toContain("expect(result.createdAt.toISOString()).toBe('2026-01-15T12:00:00.000Z');");
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('emits Idempotency-Key header coverage for idempotent POSTs', () => {
    // The happy-path body test never inspects request headers, so a regression
    // that stopped forwarding/auto-generating the key would go unnoticed. An
    // idempotent POST should get both a caller-supplied and an auto-generated
    // key assertion, reading the header via the fetchHeaders util.
    const createGroupModel: Model = {
      name: 'CreateGroup',
      fields: [{ name: 'name', type: { kind: 'primitive', type: 'string' }, required: true }],
    };
    const createOp = {
      name: 'createGroup',
      httpMethod: 'post' as const,
      path: '/groups',
      pathParams: [],
      queryParams: [],
      headerParams: [],
      requestBody: { kind: 'model' as const, name: 'CreateGroup' },
      response: { kind: 'model' as const, name: 'Group' },
      errors: [],
      injectIdempotencyKey: true,
    };
    const createService: Service = { name: 'Groups', operations: [createOp] };
    const createSpec: ApiSpec = {
      ...spec,
      models: [groupModel, createGroupModel],
      services: [createService],
    };
    const tmpRoot = createTrackedSdkRoot();
    try {
      const result = nodeEmitter.generateTests!(createSpec, {
        ...ctx,
        spec: createSpec,
        outputDir: tmpRoot,
        emitterOptions: { ownedServices: ['Groups'], regenerateOwnedTests: true },
      } as EmitterContext);

      const testFile = result.find((f) => f.path === 'src/groups/groups.spec.ts');
      expect(testFile).toBeDefined();
      const content = testFile!.content;
      // fetchHeaders is imported only when an idempotent POST exists.
      expect(content).toContain('fetchHeaders,');
      // Caller-supplied key is forwarded verbatim as the Idempotency-Key header.
      expect(content).toContain(
        "expect((fetchHeaders() as Record<string, string>)['Idempotency-Key']).toBe('test-idempotency-key');",
      );
      // defaultSdkBehavior enables autoGenerateForPost, so the auto-gen path is asserted too.
      expect(content).toContain('expect.stringMatching(/^workos-node-/)');
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('omits idempotency-key coverage for non-idempotent operations', () => {
    const tmpRoot = createTrackedSdkRoot();
    try {
      const result = nodeEmitter.generateTests!(spec, {
        ...ctx,
        outputDir: tmpRoot,
        emitterOptions: { ownedServices: ['Groups'], regenerateOwnedTests: true },
      } as EmitterContext);

      const testFile = result.find((f) => f.path === 'src/groups/groups.spec.ts');
      expect(testFile).toBeDefined();
      expect(testFile!.content).not.toContain('fetchHeaders');
      expect(testFile!.content).not.toContain('Idempotency-Key');
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('serializer.spec assertions are meaningful (not toBeDefined smoke tests)', () => {
  // Request-only model (POST body): has serialize, no deserialize → serialize-only branch.
  const createThingModel: Model = {
    name: 'CreateThing',
    fields: [
      { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
      { name: 'organization_id', type: { kind: 'primitive', type: 'string' }, required: true },
    ],
  };
  // Response model: has deserialize, serialize skipped → deserialize-only branch.
  const thingModel: Model = {
    name: 'Thing',
    fields: [
      { name: 'object', type: { kind: 'literal', value: 'thing' }, required: true },
      { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
      { name: 'organization_id', type: { kind: 'primitive', type: 'string' }, required: true },
      { name: 'created_at', type: { kind: 'primitive', type: 'string', format: 'date-time' }, required: true },
    ],
  };
  const thingsService: Service = {
    name: 'Things',
    operations: [
      {
        name: 'createThing',
        httpMethod: 'post' as const,
        path: '/things',
        pathParams: [],
        queryParams: [],
        headerParams: [],
        requestBody: { kind: 'model' as const, name: 'CreateThing' },
        response: { kind: 'model' as const, name: 'Thing' },
        errors: [],
        injectIdempotencyKey: false,
      },
    ],
  };
  const thingSpec: ApiSpec = { ...spec, models: [createThingModel, thingModel], services: [thingsService] };

  function setup(): { content: string; cleanup: () => void } {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'node-serializer-spec-'));
    fs.mkdirSync(path.join(tmpRoot, 'src', 'things', 'fixtures'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'src', 'workos.ts'), '// @oagen-ignore-file\nexport class WorkOS {}\n');
    // Hand-owned fixtures on disk drive serializer-test generation.
    fs.writeFileSync(
      path.join(tmpRoot, 'src', 'things', 'fixtures', 'create-thing.json'),
      JSON.stringify({ name: 'Acme', organization_id: 'org_123' }, null, 2),
    );
    fs.writeFileSync(
      path.join(tmpRoot, 'src', 'things', 'fixtures', 'thing.json'),
      JSON.stringify(
        { object: 'thing', id: 'thing_1', organization_id: 'org_123', created_at: '2026-01-15T12:00:00.000Z' },
        null,
        2,
      ),
    );
    execFileSync('git', ['init'], { cwd: tmpRoot, stdio: 'ignore' });
    execFileSync('git', ['add', 'src'], { cwd: tmpRoot, stdio: 'ignore' });

    const result = nodeEmitter.generateTests!(thingSpec, {
      ...ctx,
      spec: thingSpec,
      outputDir: tmpRoot,
      emitterOptions: { ownedServices: ['Things'], regenerateOwnedTests: true },
      // Internal sets normally stashed by the models pass.
      _responseReachableModels: new Set(['Thing']),
      _skippedSerializeModels: new Set(['Thing']),
      _generatedSerializerModels: new Set(['CreateThing', 'Thing']),
    } as EmitterContext);

    const testFile = result.find((f) => f.path === 'src/things/serializers.spec.ts');
    expect(testFile).toBeDefined();
    return { content: testFile!.content, cleanup: () => fs.rmSync(tmpRoot, { recursive: true, force: true }) };
  }

  it('feeds the serializer a reconstructed camelCase model, not the snake_case wire fixture', () => {
    const { content, cleanup } = setup();
    try {
      // Builds the domain model from the wire fixture (snake → camel)…
      expect(content).toContain('organizationId: fixture.organization_id');
      // …and asserts the serialized output matches the wire fixture.
      expect(content).toContain('expect(serialized).toEqual(expect.objectContaining(fixture));');
      // The old bug: snake_case wire fixture passed straight in + a vacuous assertion.
      expect(content).not.toContain('serializeCreateThing(fixture as any)');
    } finally {
      cleanup();
    }
  });

  it('asserts the deserialized field mapping instead of toBeDefined()', () => {
    const { content, cleanup } = setup();
    try {
      expect(content).toContain('expect(deserialized.organizationId).toEqual(fixture.organization_id);');
      expect(content).toContain('expect(deserialized.createdAt.toISOString()).toEqual(fixture.created_at);');
      // The Thing deserialize block no longer leans on a bare toBeDefined().
      const thingBlock = content.slice(content.indexOf("describe('ThingSerializer'"));
      expect(thingBlock).not.toContain('expect(deserialized).toBeDefined();');
    } finally {
      cleanup();
    }
  });
});
