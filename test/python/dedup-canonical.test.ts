import { describe, it, expect } from 'vitest';
import type { ApiSpec, Model, Service } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { computeModelAliases } from '../../src/python/shared-schemas.js';

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

describe('python canonical election', () => {
  it('aliases the twin only errors reach onto the live model', () => {
    const aliases = computeModelAliases(spec);
    expect(aliases.get('Err')).toBe('AuthenticationFailedDataError');
    expect(aliases.has('AuthenticationFailedDataError')).toBe(false);
  });
});
