import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Service, Model, ResolvedOperation } from '@workos/oagen';
import { defaultSdkBehavior, toSnakeCase, toPascalCase, assignModelsToServices } from '@workos/oagen';
import { generateTests } from '../../src/ruby/tests.js';
import { fileName, buildMountDirMap } from '../../src/ruby/naming.js';
import { classifyUnassignedModel } from '../../src/ruby/models.js';

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

/** Compute the per-model `.rb` path exactly as ruby/models.ts (and tests.ts) does. */
function modelFilePath(modelName: string, spec: ApiSpec, ctx: EmitterContext): string {
  const modelToService = assignModelsToServices(spec.models as Model[], spec.services, ctx.modelHints);
  const mountDirMap = buildMountDirMap(ctx);
  const service = modelToService.get(modelName);
  const dir = service
    ? (mountDirMap.get(service) ?? classifyUnassignedModel(modelName))
    : classifyUnassignedModel(modelName);
  return `lib/workos/${dir}/${fileName(modelName)}.rb`;
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

  it('scoped run: keeps in-scope + on-disk models, drops brand-new out-of-scope models', () => {
    const onDiskPath = modelFilePath('Connection', spec, {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec,
      resolvedOperations: buildResolvedOps(services),
    });

    const ctx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec,
      resolvedOperations: buildResolvedOps(services),
      // Scoped to the Organizations service / Organization model only.
      scopedServices: new Set(['Organizations']),
      scopedModelNames: new Set(['Organization']),
      // Connection's per-model file already exists on disk from a prior run.
      priorTargetManifestPaths: new Set([onDiskPath]),
    };

    const content = findRoundTripFile(generateTests(spec, ctx)).content;

    // In-scope model: kept.
    expect(content).toContain('WorkOS::Organization.new');
    // On-disk (prior manifest) model: retained even though out-of-scope.
    expect(content).toContain('WorkOS::Connection.new');
    // Brand-new out-of-scope model: NO round-trip test (would NameError).
    expect(content).not.toContain('WorkOS::Directory.new');
    expect(content).not.toContain('def test_directory_round_trip');
  });
});
