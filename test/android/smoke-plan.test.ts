import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Service, Model, Enum } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateResources } from '../../src/android/resources.js';
import { generateClient } from '../../src/android/client.js';

/**
 * The smoke driver (`smoke/sdk-android.ts`) writes literal Kotlin calls straight
 * from the `.oagen-android-smoke.json` sidecar, so any drift between the sidecar
 * and the generated resource signatures is a driver COMPILE error — the slowest
 * possible way to find out. These tests assert the two agree statically.
 */

const organizationModel: Model = {
  name: 'Organization',
  fields: [
    { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
    { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
  ],
};

const createBody: Model = {
  name: 'CreateOrganizationOptions',
  fields: [
    { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
    { name: 'domains', type: { kind: 'array', items: { kind: 'primitive', type: 'string' } }, required: false },
  ],
};

const stateEnum: Enum = { name: 'OrganizationState', values: [{ name: 'active', value: 'active' }] };

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
      queryParams: [
        { name: 'state', type: { kind: 'enum', name: 'OrganizationState' }, required: false },
        { name: 'limit', type: { kind: 'primitive', type: 'integer' }, required: false },
        { name: 'object', type: { kind: 'primitive', type: 'string' }, required: false },
      ],
      headerParams: [],
      response: { kind: 'model', name: 'Organization' },
      errors: [],
      injectIdempotencyKey: false,
    },
  ],
};

function makeCtx(): EmitterContext {
  const spec: ApiSpec = {
    name: 'Test',
    version: '1.0.0',
    baseUrl: 'https://api.example.com',
    services: [service],
    models: [organizationModel, createBody],
    enums: [stateEnum],
    sdk: defaultSdkBehavior(),
  };
  return { namespace: 'workos', namespacePascal: 'WorkOS', spec };
}

interface PlanParam {
  label: string;
  wire: string;
  source: string;
  optional: boolean;
  serialize: { kind: string; enumType?: string };
}
interface PlanEntry {
  service: string;
  method: string;
  params: PlanParam[];
}

function readPlan(ctx: EmitterContext): Record<string, PlanEntry> {
  const plan = generateClient(ctx).find((f) => f.path === '.oagen-android-smoke.json');
  expect(plan).toBeDefined();
  const parsed: unknown = JSON.parse(plan?.content ?? '{}');
  expect(parsed).toHaveProperty('operations');
  return (parsed as { operations: Record<string, PlanEntry> }).operations;
}

/** Parse `accessor -> resource type` out of the generated client extensions. */
function readAccessors(ctx: EmitterContext): Map<string, string> {
  const content = generateClient(ctx)[0].content ?? '';
  const map = new Map<string, string>();
  for (const m of content.matchAll(/public val WorkOSClient\.(\S+): (\S+)/g)) {
    map.set(m[1].replace(/`/g, ''), m[2]);
  }
  return map;
}

/** Parse `resourceType -> method -> param names` out of the generated resources. */
function readSignatures(ctx: EmitterContext): Map<string, Map<string, Set<string>>> {
  const out = new Map<string, Map<string, Set<string>>>();
  for (const file of generateResources([service], ctx)) {
    const type = (file.path.split('/').pop() ?? '').replace(/\.kt$/, '');
    const src = file.content ?? '';
    const methods = new Map<string, Set<string>>();
    for (const m of src.matchAll(/public (?:suspend )?fun (\w+|`[^`]+`)\(([\s\S]*?)\n {4}\)/g)) {
      const params = new Set<string>();
      for (const p of m[2].matchAll(/^ {8}(\w+|`[^`]+`):/gm)) params.add(p[1].replace(/`/g, ''));
      methods.set(m[1].replace(/`/g, ''), params);
    }
    for (const m of src.matchAll(/public (?:suspend )?fun (\w+|`[^`]+`)\(\)/g)) {
      const name = m[1].replace(/`/g, '');
      if (!methods.has(name)) methods.set(name, new Set());
    }
    out.set(type, methods);
  }
  return out;
}

describe('android/smoke-plan', () => {
  it('every plan entry resolves to a real accessor, method, and parameter', () => {
    const ctx = makeCtx();
    const plan = readPlan(ctx);
    const accessors = readAccessors(ctx);
    const sigs = readSignatures(ctx);

    expect(Object.keys(plan).length).toBeGreaterThan(0);

    for (const [httpKey, entry] of Object.entries(plan)) {
      const resourceType = accessors.get(entry.service);
      expect(resourceType, `${httpKey}: accessor '${entry.service}' missing on client`).toBeDefined();

      const methods = sigs.get(resourceType ?? '');
      expect(methods, `${httpKey}: no resource file for '${resourceType}'`).toBeDefined();

      const params = methods?.get(entry.method);
      expect(params, `${httpKey}: ${resourceType} has no method '${entry.method}'`).toBeDefined();

      for (const p of entry.params) {
        const label = p.label.replace(/`/g, '');
        expect(params?.has(label), `${httpKey}: ${resourceType}.${entry.method} has no param '${label}'`).toBe(true);
      }
    }
  });

  it('records the resolved enum type so the driver can construct the value', () => {
    const plan = readPlan(makeCtx());
    const entry = plan['GET /organizations/{id}'];
    const stateParam = entry.params.find((p) => p.wire === 'state');
    expect(stateParam?.serialize).toEqual({ kind: 'enum', enumType: 'OrganizationState' });
  });

  it('describes integers as long, matching the generated Kotlin type', () => {
    const plan = readPlan(makeCtx());
    const limit = plan['GET /organizations/{id}'].params.find((p) => p.wire === 'limit');
    // the emitter maps a format-less integer to Long, so the driver must emit `1L`
    expect(limit?.serialize).toEqual({ kind: 'long' });
  });

  it('strips back-ticks from labels so the driver re-escapes deliberately', () => {
    const plan = readPlan(makeCtx());
    const objectParam = plan['GET /organizations/{id}'].params.find((p) => p.wire === 'object');
    expect(objectParam?.label).toBe('object');
    expect(objectParam?.label).not.toContain('`');
  });

  it('marks path params as required and query params as optional', () => {
    const plan = readPlan(makeCtx());
    const entry = plan['GET /organizations/{id}'];
    expect(entry.params.find((p) => p.wire === 'id')).toMatchObject({ source: 'path', optional: false });
    expect(entry.params.find((p) => p.wire === 'limit')).toMatchObject({ source: 'query', optional: true });
  });

  it('expands a model request body into individual body params', () => {
    const plan = readPlan(makeCtx());
    const entry = plan['POST /organizations'];
    expect(entry.params.map((p) => p.wire)).toEqual(['name', 'domains']);
    expect(entry.params.every((p) => p.source === 'body')).toBe(true);
  });

  it('is byte-stable across runs', () => {
    const a = generateClient(makeCtx()).find((f) => f.path === '.oagen-android-smoke.json')?.content;
    const b = generateClient(makeCtx()).find((f) => f.path === '.oagen-android-smoke.json')?.content;
    expect(a).toBe(b);
  });
});
