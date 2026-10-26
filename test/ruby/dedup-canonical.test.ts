import { describe, it, expect } from 'vitest';
import { generateModels } from '../../src/ruby/models.js';
import type { EmitterContext, ApiSpec, Model, Service } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';

const codeMessage: Model['fields'] = [
  { name: 'code', type: { kind: 'primitive', type: 'string' }, required: true },
  { name: 'message', type: { kind: 'primitive', type: 'string' }, required: true },
];
// `Err` is reached only through an error response; `AuthenticationFailedDataError`
// through the field of a response model. Both have the same shape, and `Err` is
// the shorter and alphabetically earlier name.
const models: Model[] = [
  { name: 'Err', fields: codeMessage },
  { name: 'AuthenticationFailedDataError', fields: codeMessage },
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

describe('ruby/models canonical election', () => {
  it('keeps a live model canonical over a shorter twin only errors reach', () => {
    const files = generateModels(models, ctx);
    const live = files.find((f) => f.path.endsWith('/authentication_failed_data_error.rb'))!;
    expect(live.content).toContain('class AuthenticationFailedDataError');
    const err = files.find((f) => f.path.endsWith('/err.rb'))!;
    expect(err.content).toContain('Err = AuthenticationFailedDataError');
  });

  it('scoped run: force-emits an out-of-scope canonical that an in-scope alias points at', () => {
    // Only the service that uses `Err` is selected; the live twin it now
    // aliases is out of scope and brand-new (absent from the prior manifest).
    const scopedCtx: EmitterContext = {
      ...ctx,
      scopedServices: new Set(['Events']),
      scopedModelNames: new Set(['Err']),
      priorTargetManifestPaths: new Set<string>(),
    };
    const files = generateModels(models, scopedCtx);

    expect(files.find((f) => f.path.endsWith('/err.rb'))!.content).toContain('Err = AuthenticationFailedDataError');
    const canonical = files.find((f) => f.path.endsWith('/authentication_failed_data_error.rb'))!;
    expect(canonical).toBeDefined();
    expect(canonical.content).toContain('class AuthenticationFailedDataError');
  });
});
