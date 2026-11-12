import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiSpec, EmitterContext, GeneratedFile, Model, Service } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { rubyEmitter } from '../../src/ruby/index.js';

// The model pass receives enriched models: enrichment adds the variant fields
// of a oneOf schema (`Application`) and mints a model for an inline object
// (`Parent_item`, the items of `Parent.items`). lib/ has an accessor or a
// class for each of them, so rbi/ must too.
//
// The minted `Parent_item` has the same fields as the declared `ZDetail` and
// the earlier name, so it is the canonical and `ZDetail` the alias. Without a
// .rbi for `ParentItem`, `ZDetail = ParentItem` is all rbi/ says about
// `ZDetail`, and it names a constant rbi/ never declares.
const RAW_SPEC = {
  openapi: '3.0.0',
  info: { title: 'fixture', version: '1.0.0' },
  paths: {},
  components: {
    schemas: {
      Parent: {
        type: 'object',
        required: ['id', 'items'],
        properties: {
          id: { type: 'string' },
          items: {
            type: 'array',
            items: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
          },
        },
      },
      ZDetail: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      Application: {
        allOf: [
          { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
          {
            oneOf: [
              { type: 'object', properties: { secret: { type: 'string' } } },
              { type: 'object', properties: { uses_pkce: { type: 'boolean' } } },
            ],
          },
        ],
      },
    },
  },
};

// The IR the parser hands over for that spec: the inline array items are
// `unknown`, and the oneOf variant fields are missing.
const id: Model['fields'][number] = { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true };
const models: Model[] = [
  {
    name: 'Parent',
    fields: [
      id,
      { name: 'items', type: { kind: 'array', items: { kind: 'primitive', type: 'unknown' } }, required: true },
    ],
  },
  { name: 'ZDetail', fields: [id] },
  { name: 'Application', fields: [id] },
];
const services: Service[] = [
  {
    name: 'Things',
    operations: [
      {
        name: 'getThing',
        httpMethod: 'get',
        path: '/things/{id}',
        pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
        queryParams: [],
        headerParams: [],
        response: { kind: 'model', name: 'Parent' },
        errors: [],
        injectIdempotencyKey: false,
      },
    ],
  },
];
const spec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: '',
  services,
  models,
  enums: [],
  sdk: defaultSdkBehavior(),
};
const ctx: EmitterContext = { namespace: 'workos', namespacePascal: 'WorkOS', spec };
const scopedTo = (...modelNames: string[]): EmitterContext =>
  ({
    ...ctx,
    scopedServices: new Set(['Things']),
    scopedModelNames: new Set(modelNames),
    scopedEnumNames: new Set<string>(),
    priorTargetManifestPaths: new Set<string>(),
  }) as EmitterContext;

/** File contents keyed by base name (`parent_item`), for one extension. */
const byName = (files: GeneratedFile[], extension: string): Map<string, string> =>
  new Map(
    files
      .filter((f) => f.path.endsWith(extension))
      .map((f) => [f.path.split('/').pop()!.slice(0, -extension.length), f.content]),
  );
/** What a model file declares: `class X` or `X = Y`. lib/ names the superclass on the class line; rbi/ leaves it out. */
const declaration = (content: string): string | undefined =>
  /^ {2}(class \w+|\w+ = \w+)(?: < [\w:]+)?$/m.exec(content)?.[1];
/** Accessor names in a lib/ model: the values of its HASH_ATTRS. */
const libAccessors = (content: string): string[] => [...content.matchAll(/^ {6}\S+ :(\w+),?$/gm)].map((m) => m[1]);
/** Accessor names in a rbi/ model: its readers, without `to_h`. */
const rbiAccessors = (content: string): string[] =>
  [...content.matchAll(/^ {4}def (\w+); end$/gm)].map((m) => m[1]).filter((name) => name !== 'to_h');
/** The .rbi files that are not model files: the service and the client. */
const NOT_MODELS = ['things', 'client'];

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ruby-rbi-enriched-'));
  const specPath = join(dir, 'spec.yaml');
  writeFileSync(specPath, JSON.stringify(RAW_SPEC));
  process.env.OPENAPI_SPEC_PATH = specPath;
});

afterAll(() => {
  delete process.env.OPENAPI_SPEC_PATH;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('ruby/rbi model files cover the enriched models', () => {
  it('writes the signatures of a minted model that a declared model is an alias of', () => {
    const rb = byName(rubyEmitter.generateModels(models, ctx), '.rb');
    const rbi = byName(rubyEmitter.generateTypeSignatures!(spec, ctx), '.rbi');

    // The premise: the minted model won the election in lib/.
    expect(declaration(rb.get('parent_item')!)).toBe('class ParentItem');
    expect(declaration(rb.get('z_detail')!)).toBe('ZDetail = ParentItem');

    expect(declaration(rbi.get('z_detail')!)).toBe('ZDetail = ParentItem');
    expect(rbi.get('parent_item'), 'parent_item.rbi').toBeDefined();
    expect(declaration(rbi.get('parent_item')!)).toBe('class ParentItem');
    expect(rbi.get('parent_item')).toContain('    sig { returns(String) }\n    def id; end');
  });

  it('types an enriched field as lib/ builds it', () => {
    const rbi = byName(rubyEmitter.generateTypeSignatures!(spec, ctx), '.rbi');

    expect(rbi.get('parent')).toContain('    sig { returns(T::Array[WorkOS::ParentItem]) }\n    def items; end');
    expect(rbi.get('application')).toContain('    sig { returns(T.nilable(String)) }\n    def secret; end');
    expect(rbi.get('application')).toContain('    sig { returns(T.nilable(T::Boolean)) }\n    def uses_pkce; end');
  });

  it('declares every model lib/ has, with the same accessors', () => {
    const rb = byName(rubyEmitter.generateModels(models, ctx), '.rb');
    const rbi = byName(rubyEmitter.generateTypeSignatures!(spec, ctx), '.rbi');

    expect([...rb.keys()].sort()).toEqual(['application', 'parent', 'parent_item', 'z_detail']);
    expect([...rbi.keys()].filter((file) => !NOT_MODELS.includes(file)).sort()).toEqual([...rb.keys()].sort());
    for (const [file, content] of rb) {
      expect(declaration(rbi.get(file)!), file).toBe(declaration(content));
      expect(rbiAccessors(rbi.get(file)!), file).toEqual(libAccessors(content));
    }
  });

  it.each([
    // The minted model follows the model that minted it into scope.
    { selected: 'Parent', written: ['parent', 'parent_item'] },
    // The alias is selected; its minted canonical is out of scope and forced.
    { selected: 'ZDetail', written: ['parent_item', 'z_detail'] },
  ])('scoped run on $selected: writes a .rbi for exactly the models whose .rb it writes', ({ selected, written }) => {
    const scoped = scopedTo(selected);
    const rb = byName(rubyEmitter.generateModels(models, scoped), '.rb');
    const rbi = byName(rubyEmitter.generateTypeSignatures!(spec, scoped), '.rbi');

    expect([...rb.keys()].sort()).toEqual(written);
    expect([...rbi.keys()].filter((file) => !NOT_MODELS.includes(file)).sort()).toEqual(written);
    for (const [file, content] of rb) expect(declaration(rbi.get(file)!), file).toBe(declaration(content));
  });
});
