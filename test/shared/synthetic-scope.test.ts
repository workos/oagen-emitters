import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiSpec, EmitterContext, Model } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { enrichModelsFromSpec, getSyntheticEnums, getSyntheticParent } from '../../src/shared/model-utils.js';
import { isEnumInScope, isModelInScope } from '../../src/shared/resolved-ops.js';

// A scoped (`--services`) run's allow-lists come from the engine's IR
// reachability, which cannot know about the synthetic models/enums the
// emitters mint from inline schemas during enrichment. Those synthetics must
// follow their parent model's scope, or the rewritten parent file references
// a type whose file the scoped run never wrote.
const SPEC = {
  openapi: '3.0.0',
  info: { title: 'fixture', version: '1.0.0' },
  paths: {},
  components: {
    schemas: {
      Parent: {
        oneOf: [
          {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['a', 'b'] },
              child: {
                type: 'object',
                properties: {
                  mode: { type: 'string', enum: ['x', 'y'] },
                  id: { type: 'string' },
                },
              },
            },
          },
        ],
      },
      Other: { type: 'object', properties: { id: { type: 'string' } } },
    },
  },
};

const models: Model[] = [
  { name: 'Parent', fields: [] },
  { name: 'Other', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
];

const spec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: '',
  services: [],
  models,
  enums: [],
  sdk: defaultSdkBehavior(),
};

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'synthetic-scope-'));
  const specPath = join(dir, 'spec.yaml');
  writeFileSync(specPath, JSON.stringify(SPEC));
  process.env.OPENAPI_SPEC_PATH = specPath;
  enrichModelsFromSpec(models, []);
});

afterAll(() => {
  delete process.env.OPENAPI_SPEC_PATH;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('synthetic types follow their parent model into scope', () => {
  it('records the minting parent, including for nested synthetics', () => {
    expect(getSyntheticParent('Parent_kind')).toBe('Parent');
    expect(getSyntheticParent('Parent_child')).toBe('Parent');
    expect(getSyntheticParent('Parent_child_mode')).toBe('Parent_child');
    expect(getSyntheticParent('Parent')).toBeUndefined();
    expect(getSyntheticEnums().map((e) => e.name)).toEqual(['Parent_kind', 'Parent_child_mode']);
  });

  it('treats a synthetic as in scope exactly when its declared root model is', () => {
    const scoped: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec,
      scopedServices: new Set(['Parents']),
      scopedModelNames: new Set(['Parent']),
      scopedEnumNames: new Set(),
    };
    expect(isModelInScope('Parent', scoped)).toBe(true);
    expect(isModelInScope('Parent_child', scoped)).toBe(true);
    expect(isEnumInScope('Parent_kind', scoped)).toBe(true);
    expect(isEnumInScope('Parent_child_mode', scoped)).toBe(true);
    // Declared types outside the allow-list stay out.
    expect(isModelInScope('Other', scoped)).toBe(false);
    expect(isEnumInScope('SomeDeclaredEnum', scoped)).toBe(false);
  });

  it('keeps a synthetic out of scope when its parent is', () => {
    const scoped: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec,
      scopedServices: new Set(['Others']),
      scopedModelNames: new Set(['Other']),
      scopedEnumNames: new Set(),
    };
    expect(isModelInScope('Parent_child', scoped)).toBe(false);
    expect(isEnumInScope('Parent_kind', scoped)).toBe(false);
    expect(isEnumInScope('Parent_child_mode', scoped)).toBe(false);
  });
});
