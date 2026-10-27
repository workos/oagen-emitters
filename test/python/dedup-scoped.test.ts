import { describe, it, expect } from 'vitest';
import { generateModels } from '../../src/python/models.js';
import type { EmitterContext, ApiSpec, Model, Service, Enum } from '@workos/oagen';
import { forcedModelNames } from '../../src/shared/resolved-ops.js';
import { generateEnums } from '../../src/python/enums.js';
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

describe('python scoped canonical election', () => {
  it('force-emits the out-of-scope canonical an in-scope alias imports, and what it reaches', () => {
    const files = generateModels(models, scopedCtx);
    const modelFiles = files.filter((f) => f.path.includes('/models/') && !f.path.endsWith('__init__.py'));
    const has = (suffix: string) => modelFiles.some((f) => f.path.endsWith(suffix));

    expect(modelFiles.find((f) => f.path.endsWith('/err.py'))!.content).toContain(
      'Err: TypeAlias = AuthenticationFailedDataError',
    );
    expect(has('/authentication_failed_data_error.py')).toBe(true);
    expect(has('/detail_info.py')).toBe(true);
    expect(has('/detail.py')).toBe(true);
    expect(has('/authentication_failed_data.py')).toBe(false);
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
    expect(files.some((f) => f.path.endsWith('/live_status.py'))).toBe(true);
  });

  it('scoped run: the barrel exports the canonical an aliased forced enum resolves to', () => {
    // `ZStatus` and `AStatus` share their values, so `ZStatus` aliases `AStatus`.
    // Only the error side is selected; the live tree it aliases names `ZStatus`.
    const status = (name: string): Model['fields'][number] => ({
      name: 'status',
      type: { kind: 'enum', name },
      required: true,
    });
    const withEnum: Model[] = models.map((m) =>
      m.name === 'Err'
        ? { ...m, fields: [...m.fields, status('AStatus')] }
        : m.name === 'AuthenticationFailedDataError'
          ? { ...m, fields: [...m.fields, status('ZStatus')] }
          : m,
    );
    const values = [
      { name: 'OK', value: 'ok' },
      { name: 'FAILED', value: 'failed' },
    ];
    const enums: Enum[] = [
      { name: 'ZStatus', values },
      { name: 'AStatus', values },
    ];
    const enumCtx: EmitterContext = { ...scopedCtx, spec: { ...scopedCtx.spec, models: withEnum, enums } };

    const files = generateModels(withEnum, enumCtx);
    const barrels = files
      .filter((f) => f.path.endsWith('/models/__init__.py'))
      .map((f) => f.content)
      .join('\n');
    expect(barrels).toContain('AStatus');
  });
});
