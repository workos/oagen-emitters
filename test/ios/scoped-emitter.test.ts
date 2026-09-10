import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiSpec, EmitterContext, Model } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { iosEmitter } from '../../src/ios/index.js';

// Emitter-level coverage for scoped runs: goes through `iosEmitter` so model
// enrichment runs and mints synthetic dependents from the raw spec. An
// in-scope model's synthetic model/enum files must be emitted alongside it;
// out-of-scope declared models must be left untouched.
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
              child: { type: 'object', properties: { id: { type: 'string' } } },
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
  enums: [{ name: 'DeclaredOther', values: [{ name: 'z', value: 'z' }] }],
  sdk: defaultSdkBehavior(),
};

const scopedCtx: EmitterContext = {
  namespace: 'workos',
  namespacePascal: 'WorkOS',
  spec,
  scopedServices: new Set(['Parents']),
  scopedModelNames: new Set(['Parent']),
  scopedEnumNames: new Set(),
};

const fullCtx: EmitterContext = { namespace: 'workos', namespacePascal: 'WorkOS', spec };

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ios-scoped-emitter-'));
  const specPath = join(dir, 'spec.yaml');
  writeFileSync(specPath, JSON.stringify(SPEC));
  process.env.OPENAPI_SPEC_PATH = specPath;
});

afterAll(() => {
  delete process.env.OPENAPI_SPEC_PATH;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const paths = (files: { path: string }[]) => files.map((f) => f.path).sort();

describe('ios emitter under --services', () => {
  it('emits the in-scope model with its synthetic dependents and skips the rest', () => {
    const modelFiles = iosEmitter.generateModels(models, scopedCtx);
    const enumFiles = iosEmitter.generateEnums(spec.enums, scopedCtx);

    expect(paths(modelFiles)).toEqual([
      'Sources/WorkOS/Models/Parent.swift',
      'Sources/WorkOS/Models/ParentChild.swift',
    ]);
    expect(paths(enumFiles)).toEqual(['Sources/WorkOS/Enums/ParentKind.swift']);

    // The rewritten parent references both dependents by their emitted names.
    const parent = modelFiles.find((f) => f.path.endsWith('/Parent.swift'))!.content;
    expect(parent).toContain('ParentKind');
    expect(parent).toContain('ParentChild');
  });

  it('emits everything in a full run', () => {
    expect(paths(iosEmitter.generateModels(models, fullCtx))).toEqual([
      'Sources/WorkOS/Models/Other.swift',
      'Sources/WorkOS/Models/Parent.swift',
      'Sources/WorkOS/Models/ParentChild.swift',
    ]);
    expect(paths(iosEmitter.generateEnums(spec.enums, fullCtx))).toEqual([
      'Sources/WorkOS/Enums/DeclaredOther.swift',
      'Sources/WorkOS/Enums/ParentKind.swift',
    ]);
  });
});
