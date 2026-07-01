import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Service, Model, ResolvedOperation } from '@workos/oagen';
import { defaultSdkBehavior, toSnakeCase, toPascalCase } from '@workos/oagen';
import { generateTests } from '../../src/ruby/tests.js';

function makeSpec(services: Service[], models: Model[]): ApiSpec {
  return {
    name: 'Test',
    version: '1.0.0',
    baseUrl: 'https://api.workos.com',
    services,
    models,
    enums: [],
    sdk: defaultSdkBehavior(),
  };
}

function buildResolvedOps(services: Service[]): ResolvedOperation[] {
  const ops: ResolvedOperation[] = [];
  for (const service of services) {
    const mountOn = toPascalCase(service.name);
    for (const op of service.operations) {
      ops.push({
        operation: op,
        service,
        methodName: toSnakeCase(op.name),
        mountOn,
        defaults: {},
        inferFromClient: [],
        urlBuilder: false,
      });
    }
  }
  return ops;
}

const models: Model[] = [
  // In-scope: selected service's model.
  { name: 'Organization', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
  // On-disk: out-of-scope this run, but its file is recorded in the prior manifest.
  { name: 'Connection', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
  // Brand-new out-of-scope: out-of-scope AND not in the prior manifest.
  { name: 'Directory', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
];

const services: Service[] = [
  {
    name: 'Organizations',
    operations: [
      {
        name: 'listOrganizations',
        httpMethod: 'get',
        path: '/organizations',
        pathParams: [],
        queryParams: [],
        headerParams: [],
        response: { kind: 'model', name: 'Organization' },
        errors: [],
        injectIdempotencyKey: false,
      },
    ],
  },
];

const spec = makeSpec(services, models);

function findRoundTripFile(files: { path: string; content: string }[]): { path: string; content: string } {
  const file = files.find((f) => f.path === 'test/workos/test_model_round_trip.rb');
  if (!file) throw new Error('round-trip test file not emitted');
  return file;
}

describe('ruby/tests model round-trip aggregate scoping', () => {
  it('full run: round-trips every model', () => {
    const ctx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec,
      resolvedOperations: buildResolvedOps(services),
    };
    const content = findRoundTripFile(generateTests(spec, ctx)).content;
    expect(content).toContain('WorkOS::Organization.new');
    expect(content).toContain('WorkOS::Connection.new');
    expect(content).toContain('WorkOS::Directory.new');
  });

  it('scoped run: does NOT emit the wholesale round-trip test (leaves the on-disk one untouched)', () => {
    const ctx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec,
      resolvedOperations: buildResolvedOps(services),
      scopedServices: new Set(['Organizations']),
      scopedModelNames: new Set(['Organization']),
    };

    const files = generateTests(spec, ctx);
    // Minimal scope: the monolithic round-trip test is skipped in a scoped run so
    // it never drags in (surface) — nor drops — other services' models. The
    // on-disk file is left untouched; the selected service's own test still emits.
    expect(files.some((f) => f.path === 'test/workos/test_model_round_trip.rb')).toBe(false);
    expect(files.length).toBeGreaterThan(0);
  });
});
