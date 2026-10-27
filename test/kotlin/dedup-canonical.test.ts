import { describe, it, expect } from 'vitest';
import { generateModels } from '../../src/kotlin/models.js';
import { generateEnums } from '../../src/kotlin/enums.js';
import type { EmitterContext, ApiSpec, Model, Service } from '@workos/oagen';
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

describe('kotlin/models canonical election', () => {
  it('keeps a live model canonical over a shorter twin only errors reach', () => {
    generateEnums([], ctx);
    const files = generateModels(models, ctx);

    expect(files.find((f) => f.path.endsWith('/AuthenticationFailedDataError.kt'))!.content).toContain(
      'data class AuthenticationFailedDataError(',
    );
    expect(files.find((f) => f.path.endsWith('/Err.kt'))!.content).toContain(
      'typealias Err = AuthenticationFailedDataError',
    );
    expect(files.find((f) => f.path.endsWith('/Detail.kt'))!.content).toContain('data class Detail(');
    expect(files.find((f) => f.path.endsWith('/DetailInfo.kt'))!.content).toContain('typealias DetailInfo = Detail');
  });

  it('scoped run: force-emits the out-of-scope canonical an in-scope alias points at, and what it reaches', () => {
    generateEnums([], scopedCtx);
    const files = generateModels(models, scopedCtx);
    const has = (suffix: string) => files.some((f) => f.path.endsWith(suffix));

    expect(files.find((f) => f.path.endsWith('/Err.kt'))!.content).toContain(
      'typealias Err = AuthenticationFailedDataError',
    );
    // The canonical itself …
    expect(files.find((f) => f.path.endsWith('/AuthenticationFailedDataError.kt'))!.content).toContain(
      'data class AuthenticationFailedDataError(',
    );
    // … the alias its field names, and that alias's canonical.
    expect(has('/DetailInfo.kt')).toBe(true);
    expect(has('/Detail.kt')).toBe(true);
    // Nothing else out of scope leaks in.
    expect(has('/AuthenticationFailedData.kt')).toBe(false);
  });
});
