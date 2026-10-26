import { describe, it, expect } from 'vitest';
import { generateModels } from '../../src/kotlin/models.js';
import { generateEnums } from '../../src/kotlin/enums.js';
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

describe('kotlin/models canonical election', () => {
  it('keeps a live model canonical over a shorter twin only errors reach', () => {
    generateEnums([], ctx);
    const files = generateModels(models, ctx);

    const live = files.find((f) => f.path.endsWith('/AuthenticationFailedDataError.kt'))!;
    expect(live.content).toContain('data class AuthenticationFailedDataError(');
    const err = files.find((f) => f.path.endsWith('/Err.kt'))!;
    expect(err.content).toContain('typealias Err = AuthenticationFailedDataError');
  });
});
