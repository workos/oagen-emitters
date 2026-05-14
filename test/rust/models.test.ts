import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Model } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateModels } from '../../src/rust/models.js';
import { generateClient } from '../../src/rust/client.js';
import { UnionRegistry } from '../../src/rust/type-map.js';

const emptySpec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: '',
  services: [],
  models: [],
  enums: [],
  sdk: defaultSdkBehavior(),
};

const ctx: EmitterContext = {
  namespace: 'workos',
  namespacePascal: 'WorkOS',
  spec: emptySpec,
};

describe('rust/models', () => {
  it('emits only an empty barrel when no models', () => {
    const files = generateModels([], ctx, new UnionRegistry());
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe('src/models/mod.rs');
  });

  it('generates a struct with required and optional fields', () => {
    const models: Model[] = [
      {
        name: 'Organization',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
          {
            name: 'metadata',
            type: { kind: 'map', valueType: { kind: 'primitive', type: 'string' } },
            required: false,
          },
        ],
      },
    ];
    const files = generateModels(models, ctx, new UnionRegistry());
    expect(files.length).toBeGreaterThanOrEqual(2); // model + barrel
    const orgFile = files.find((f) => f.path === 'src/models/organization.rs')!;
    expect(orgFile).toBeDefined();
    const content = orgFile.content;
    expect(content).toContain('use serde::{Deserialize, Serialize};');
    expect(content).toContain('pub struct Organization {');
    expect(content).toContain('pub id: String,');
    expect(content).toContain('pub name: String,');
    expect(content).toContain('pub metadata: Option<std::collections::HashMap<String, String>>,');
    expect(content).toContain('#[derive(Debug, Clone, Serialize, Deserialize)]');
  });

  it('renames struct fields when serde wire name differs', () => {
    const models: Model[] = [
      {
        name: 'User',
        fields: [{ name: 'userId', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ];
    const files = generateModels(models, ctx, new UnionRegistry());
    const userFile = files.find((f) => f.path === 'src/models/user.rs')!;
    expect(userFile.content).toContain('#[serde(rename = "userId")]');
    expect(userFile.content).toContain('pub user_id: String,');
  });

  it('skips serializing None for optional fields', () => {
    const models: Model[] = [
      {
        name: 'Maybe',
        fields: [{ name: 'value', type: { kind: 'primitive', type: 'string' }, required: false }],
      },
    ];
    const files = generateModels(models, ctx, new UnionRegistry());
    const f = files.find((x) => x.path === 'src/models/maybe.rs')!;
    expect(f.content).toContain('#[serde(skip_serializing_if = "Option::is_none", default)]');
    expect(f.content).toContain('pub value: Option<String>,');
  });

  it('synthesises a _unions module when a model has an inline union field', () => {
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
    const registry = new UnionRegistry();
    const files = generateModels(models, ctx, registry);
    const event = files.find((f) => f.path === 'src/models/event.rs')!;
    expect(event.content).toContain('pub payload: EventPayloadOneOf,');
    const barrel = files.find((f) => f.path === 'src/models/mod.rs')!;
    expect(barrel.content).toContain('pub mod _unions;');
    // The _unions.rs file is rendered by generateClient (the final structural
    // pass) so resource-side body unions can join the same registry.
    const clientFiles = generateClient(emptySpec, ctx, registry);
    const unions = clientFiles.find((f) => f.path === 'src/models/_unions.rs')!;
    expect(unions.content).toContain('#[serde(tag = "event")]');
    expect(unions.content).toContain('pub enum EventPayloadOneOf {');
  });

  it('documents Field.default as a "Defaults to" doc comment', () => {
    const models: Model[] = [
      {
        name: 'Pagination',
        fields: [
          {
            name: 'limit',
            type: { kind: 'primitive', type: 'integer' },
            required: false,
            description: 'Page size.',
            default: 10,
          },
          {
            name: 'order',
            type: { kind: 'primitive', type: 'string' },
            required: false,
            default: 'desc',
          },
          {
            name: 'verbose',
            type: { kind: 'primitive', type: 'boolean' },
            required: false,
            default: true,
          },
        ],
      },
    ];
    const files = generateModels(models, ctx, new UnionRegistry());
    const f = files.find((x) => x.path === 'src/models/pagination.rs')!;
    // Number default with description: description first, blank `///`, then defaults.
    expect(f.content).toContain('/// Page size.');
    expect(f.content).toContain('/// Defaults to `10`.');
    // String default renders bare (no JSON quotes).
    expect(f.content).toContain('/// Defaults to `desc`.');
    // Boolean default uses JSON encoding (`true`, not `"true"`).
    expect(f.content).toContain('/// Defaults to `true`.');
  });

  it('emits a barrel re-exporting each module', () => {
    const models: Model[] = [
      {
        name: 'Alpha',
        fields: [{ name: 'x', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
      {
        name: 'Beta',
        fields: [{ name: 'y', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ];
    const files = generateModels(models, ctx, new UnionRegistry());
    const barrel = files.find((f) => f.path === 'src/models/mod.rs')!;
    expect(barrel.content).toContain('pub mod alpha;');
    expect(barrel.content).toContain('pub mod beta;');
    expect(barrel.content).toContain('pub use alpha::*;');
  });
});
