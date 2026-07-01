import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Model, Service } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateClient } from '../../src/rust/client.js';
import { generateModels } from '../../src/rust/models.js';
import { UnionRegistry } from '../../src/rust/type-map.js';

function makeCtx(spec: ApiSpec): EmitterContext {
  return { namespace: 'workos', namespacePascal: 'WorkOS', spec };
}

const emptySpec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: '',
  services: [],
  models: [],
  enums: [],
  sdk: defaultSdkBehavior(),
};

describe('rust/client', () => {
  it('emits the unions module and an empty resources_api shell when there are no mount targets', () => {
    const files = generateClient(emptySpec, makeCtx(emptySpec), new UnionRegistry());
    expect(files.map((f) => f.path).sort()).toEqual(['src/models/_unions.rs', 'src/resources_api.rs']);
    const unions = files.find((f) => f.path === 'src/models/_unions.rs')!;
    expect(unions.content).toContain('No oneOf-style unions registered');
    const api = files.find((f) => f.path === 'src/resources_api.rs')!;
    expect(api.content).toContain('impl Client {');
  });

  it('scoped run: resources_api wires only surface accessors (no orphan for a never-generated service)', () => {
    const svc = (name: string): Service => ({
      name,
      operations: [
        {
          name: `list${name}`,
          httpMethod: 'get',
          path: `/${name.toLowerCase()}`,
          pathParams: [],
          queryParams: [],
          headerParams: [],
          response: { kind: 'model', name },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    });
    const pipes = svc('Pipes');
    const agents = svc('Agents');
    // ctx resolves the FULL spec (both mounts); the run's surface is Pipes only.
    const ctx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec: { ...emptySpec, services: [pipes, agents] },
      scopedServices: new Set(['Pipes']),
      resolvedOperations: [pipes, agents].flatMap((s) =>
        s.operations.map((operation) => ({
          service: s,
          operation,
          methodName: operation.name,
          mountOn: s.name,
          defaults: {},
          inferFromClient: [],
          urlBuilder: false,
        })),
      ),
    };
    // The core passes surfaceSpec (services = selected ∪ on-disk = [Pipes]).
    const surfaceSpec: ApiSpec = { ...emptySpec, services: [pipes] };
    const api = generateClient(surfaceSpec, ctx, new UnionRegistry()).find((f) => f.path === 'src/resources_api.rs')!;
    expect(api.content).toContain('pub fn pipes');
    // Pre-fix: `resources_api.rs` wired `pub fn agents() -> AgentsApi` for a
    // resource never emitted → compile break.
    expect(api.content).not.toContain('AgentsApi');
    expect(api.content).not.toContain('pub fn agents');
  });

  it('renders unions registered earlier in the emit run', () => {
    const registry = new UnionRegistry();
    const models: Model[] = [
      {
        name: 'Event',
        fields: [
          {
            name: 'payload',
            type: {
              kind: 'union',
              variants: [
                { kind: 'model', name: 'UserCreated' },
                { kind: 'model', name: 'UserDeleted' },
              ],
              discriminator: {
                property: 'event',
                mapping: { 'user.created': 'UserCreated', 'user.deleted': 'UserDeleted' },
              },
            },
            required: true,
          },
        ],
      },
    ];
    generateModels(models, makeCtx(emptySpec), registry);
    const files = generateClient(emptySpec, makeCtx(emptySpec), registry);
    const unions = files.find((f) => f.path === 'src/models/_unions.rs')!;
    expect(unions.content).toContain('#[serde(tag = "event")]');
    expect(unions.content).toContain('pub enum EventPayloadOneOf {');
  });
});
