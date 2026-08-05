import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Service } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateClient } from '../../src/android/client.js';
import { buildOperationsMap } from '../../src/android/manifest.js';

const service: Service = {
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
    },
  ],
};

const ssoService: Service = {
  name: 'SSO',
  operations: [
    {
      name: 'list_connections',
      httpMethod: 'get',
      path: '/connections',
      pathParams: [],
      queryParams: [],
      headerParams: [],
      response: { kind: 'model', name: 'Connection' },
      errors: [],
      injectIdempotencyKey: false,
    },
  ],
};

function makeCtx(services: Service[]): EmitterContext {
  const spec: ApiSpec = {
    name: 'Test',
    version: '1.0.0',
    baseUrl: 'https://api.example.com',
    services,
    models: [
      { name: 'Organization', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
      { name: 'Connection', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
    ],
    enums: [],
    sdk: defaultSdkBehavior(),
  };
  return { namespace: 'workos', namespacePascal: 'WorkOS', spec };
}

describe('android/client', () => {
  it('emits extension-property accessors plus the smoke-plan sidecar', () => {
    const ctx = makeCtx([service, ssoService]);
    const files = generateClient(ctx);
    expect(files).toHaveLength(2);

    const accessors = files[0];
    expect(accessors.path).toBe('src/main/kotlin/com/workos/android/WorkOSClientResources.kt');
    expect(accessors.overwriteExisting).toBe(true);
    expect(accessors.content).toContain('package com.workos.android');
    expect(accessors.content).toContain('public val WorkOSClient.organizations: Organizations');
    expect(accessors.content).toContain('get() = Organizations(transport)');
    expect(accessors.content).toContain('public val WorkOSClient.sso: SSO');
    expect(accessors.content).toContain('import com.workos.android.resources.Organizations');
  });

  it('marks the smoke plan as staging-only so it is never merged into a live SDK', () => {
    const plan = generateClient(makeCtx([service]))[1];
    expect(plan.path).toBe('.oagen-android-smoke.json');
    // `integrateTarget: false` only suppresses it during `--target` integration.
    // A `--output` run still writes it next to the SDK, so the SDK repo must
    // gitignore it (workos-ios does the same with .oagen-ios-smoke.json).
    expect(plan.integrateTarget).toBe(false);
    expect(plan.headerPlacement).toBe('skip');
    const parsed: unknown = JSON.parse(plan.content ?? '{}');
    expect(parsed).toMatchObject({
      version: 1,
      operations: { 'GET /organizations/{id}': { service: 'organizations', method: 'get' } },
    });
  });

  it('sorts accessors so regeneration is byte-stable', () => {
    const a = generateClient(makeCtx([service, ssoService]))[0].content;
    const b = generateClient(makeCtx([ssoService, service]))[0].content;
    expect(a).toBe(b);
  });

  it('capitalizes a lower-case namespace rather than emitting workosClient', () => {
    const ctx = makeCtx([service]);
    // Callers only pass the cased namespace for languages whose namespace also
    // names a type; a lower-case one must still yield a valid Kotlin class name.
    const content = generateClient({ ...ctx, namespacePascal: 'workos' })[0].content;
    expect(content).toContain('public val WorkosClient.organizations: Organizations');
    expect(content).not.toContain('workosClient');
  });

  it('builds an operations manifest keyed by METHOD /path', () => {
    const ctx = makeCtx([service, ssoService]);
    expect(buildOperationsMap(ctx.spec, ctx)).toEqual({
      'GET /organizations/{id}': { sdkMethod: 'get', service: 'organizations' },
      'GET /connections': { sdkMethod: 'listConnections', service: 'sso' },
    });
  });
});
