import { describe, it, expect } from 'vitest';
import { generateModels } from '../../src/ruby/models.js';
import { generateRbiFiles } from '../../src/ruby/rbi.js';
import type { EmitterContext, ApiSpec, GeneratedFile, Model, Service, Enum } from '@workos/oagen';
import { forcedModelNames } from '../../src/shared/resolved-ops.js';
import { generateEnums } from '../../src/ruby/enums.js';
import { defaultSdkBehavior } from '@workos/oagen';

const codeMessage = (detail: string): Model['fields'] => [
  { name: 'code', type: { kind: 'primitive', type: 'string' }, required: true },
  { name: 'message', type: { kind: 'primitive', type: 'string' }, required: true },
  { name: 'detail', type: { kind: 'model', name: detail }, required: true },
];
const reason: Model['fields'] = [{ name: 'reason', type: { kind: 'primitive', type: 'string' }, required: true }];
// `Err` (with `ErrDetail`) is reached only through an error response;
// `AuthenticationFailedDataError` (with `DetailInfo`) through the field of a
// response model. Structurally the two trees are identical, `Err` is the
// shorter and alphabetically earlier name, and a third identical `Detail`
// (reached by nothing) is the shortest / earliest child name.
const models: Model[] = [
  { name: 'Err', fields: codeMessage('ErrDetail') },
  { name: 'ErrDetail', fields: reason },
  { name: 'AuthenticationFailedDataError', fields: codeMessage('DetailInfo') },
  { name: 'DetailInfo', fields: reason },
  { name: 'Detail', fields: reason },
  {
    name: 'AuthenticationFailedData',
    fields: [{ name: 'error', type: { kind: 'model', name: 'AuthenticationFailedDataError' }, required: true }],
  },
];
const services: Service[] = [
  {
    name: 'Events',
    operations: [
      {
        name: 'getEvent',
        httpMethod: 'get',
        path: '/events/{id}',
        pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
        queryParams: [],
        headerParams: [],
        response: { kind: 'model', name: 'AuthenticationFailedData' },
        errors: [{ statusCode: 400, type: { kind: 'model', name: 'Err' } }],
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
// Only the error side is selected; the live tree it aliases is out of scope and brand-new.
const scopedCtx: EmitterContext = {
  ...ctx,
  scopedServices: new Set(['Events']),
  scopedModelNames: new Set(['Err', 'ErrDetail']),
  scopedEnumNames: new Set<string>(),
  priorTargetManifestPaths: new Set<string>(),
} as EmitterContext;

describe('ruby/models canonical election', () => {
  it('keeps a live model canonical over a shorter twin only errors reach', () => {
    const files = generateModels(models, ctx);
    expect(files.find((f) => f.path.endsWith('/authentication_failed_data_error.rb'))!.content).toContain(
      'class AuthenticationFailedDataError',
    );
    expect(files.find((f) => f.path.endsWith('/err.rb'))!.content).toContain('Err = AuthenticationFailedDataError');
    expect(files.find((f) => f.path.endsWith('/detail.rb'))!.content).toContain('class Detail');
    expect(files.find((f) => f.path.endsWith('/detail_info.rb'))!.content).toContain('DetailInfo = Detail');
  });

  it('scoped run: force-emits the out-of-scope canonical an in-scope alias points at, and what it reaches', () => {
    const files = generateModels(models, scopedCtx);
    const has = (suffix: string) => files.some((f) => f.path.endsWith(suffix));

    expect(files.find((f) => f.path.endsWith('/err.rb'))!.content).toContain('Err = AuthenticationFailedDataError');
    const canonical = files.find((f) => f.path.endsWith('/authentication_failed_data_error.rb'))!;
    expect(canonical.content).toContain('class AuthenticationFailedDataError');
    expect(canonical.content).toContain('WorkOS::DetailInfo.new');
    expect(has('/detail_info.rb')).toBe(true);
    expect(has('/detail.rb')).toBe(true);
    expect(has('/authentication_failed_data.rb')).toBe(false);
  });

  it('scoped run: writes the enum a forced model reaches', () => {
    // Prime the forced set as the model pass does, pointing the in-scope alias
    // at a canonical whose field names an out-of-scope, brand-new enum.
    const withEnum: Model[] = [
      ...models,
      { name: 'Live', fields: [{ name: 'status', type: { kind: 'enum', name: 'LiveStatus' }, required: true }] },
    ];
    const enums: Enum[] = [
      {
        name: 'LiveStatus',
        values: [
          { name: 'OK', value: 'ok' },
          { name: 'FAILED', value: 'failed' },
        ],
      },
    ];
    const enumCtx: EmitterContext = { ...scopedCtx, spec: { ...scopedCtx.spec, models: withEnum, enums } };
    forcedModelNames(withEnum, new Map([['Err', 'Live']]), enumCtx);

    const files = generateEnums(enums, enumCtx);
    expect(files.some((f) => f.path.endsWith('/live_status.rb'))).toBe(true);
  });
});

// lib/ and rbi/ describe the same constants. An alias model is
// `Alias = Canonical` in lib/; a full `class Alias` in rbi/ contradicts that
// assignment (Sorbet error 4022) and gives the alias a type of its own.
describe('ruby/rbi model files match the model files', () => {
  /**
   * What each model file declares, keyed by file name: `class X` or `X = Y`.
   * lib/ names the superclass on the class line; rbi/ leaves it out.
   */
  const declarations = (files: GeneratedFile[], extension: string): Map<string, string> => {
    const byFile = new Map<string, string>();
    for (const f of files) {
      if (!f.path.endsWith(extension)) continue;
      const declaration = /^ {2}(class \w+|\w+ = \w+)(?: < [\w:]+)?$/m.exec(f.content);
      if (declaration) byFile.set(f.path.split('/').pop()!.slice(0, -extension.length), declaration[1]);
    }
    return byFile;
  };

  it('declares an alias model as the constant assignment lib/ has', () => {
    const rbi = generateRbiFiles(spec, ctx);
    const content = (suffix: string) => rbi.find((f) => f.path.endsWith(suffix))!.content;

    expect(content('/err.rbi')).toContain('  Err = AuthenticationFailedDataError');
    expect(content('/err.rbi')).not.toContain('class Err');
    expect(content('/err.rbi')).not.toContain('sig {');
    expect(content('/detail_info.rbi')).toContain('  DetailInfo = Detail');
    expect(content('/authentication_failed_data_error.rbi')).toContain('  class AuthenticationFailedDataError');
    expect(content('/detail.rbi')).toContain('  class Detail');
  });

  it('declares the same kind of constant as lib/ for every model', () => {
    const rb = declarations(generateModels(models, ctx), '.rb');
    const rbi = declarations(generateRbiFiles(spec, ctx), '.rbi');

    expect(rb.size).toBe(models.length);
    for (const [file, declaration] of rb) expect(rbi.get(file), file).toBe(declaration);
  });

  it('scoped run: writes a .rbi for exactly the models whose .rb it writes', () => {
    const rb = declarations(generateModels(models, scopedCtx), '.rb');
    const rbi = declarations(generateRbiFiles(spec, scopedCtx), '.rbi');

    // The forced canonical and what it reaches get their .rbi too, so an
    // older `Canonical = Alias` signature on disk cannot survive next to the
    // new `Alias = Canonical` one.
    expect(rbi.get('authentication_failed_data_error')).toBe('class AuthenticationFailedDataError');
    for (const [file, declaration] of rb) expect(rbi.get(file), file).toBe(declaration);
    for (const file of rbi.keys()) {
      if (!rb.has(file)) expect(['events', 'client'], file).toContain(file);
    }
  });
});
