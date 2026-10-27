import { describe, it, expect } from 'vitest';
import type { ApiSpec, Model, Service } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import {
  collectErrorOnlyModelNames,
  preferLiveCanonical,
  forcedModelNames,
  forcedEnumNames,
} from '../../src/shared/resolved-ops.js';

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

describe('collectErrorOnlyModelNames', () => {
  it('names the models only error responses reach', () => {
    expect([...collectErrorOnlyModelNames(spec)]).toEqual(['Err']);
  });

  it('treats a model a body-owned query parameter reaches as live', () => {
    const op = services[0].operations[0];
    const viaParam: ApiSpec = {
      ...spec,
      services: [
        {
          name: 'Events',
          operations: [
            {
              ...op,
              bodyOwnedQueryParams: [{ name: 'filter', type: { kind: 'model', name: 'Err' }, required: false }],
            },
          ],
        },
      ],
    };
    expect(collectErrorOnlyModelNames(viaParam).size).toBe(0);
  });

  it('treats a model that a success response also reaches as live', () => {
    const op = services[0].operations[0];
    const alsoReturned: ApiSpec = {
      ...spec,
      services: [
        {
          name: 'Events',
          operations: [
            op,
            { ...op, name: 'getError', path: '/errors/{id}', response: { kind: 'model', name: 'Err' }, errors: [] },
          ],
        },
      ],
    };
    expect(collectErrorOnlyModelNames(alsoReturned).size).toBe(0);
  });
});

describe('preferLiveCanonical', () => {
  it('sorts error-only names last and keeps plain string order otherwise', () => {
    expect(['Err', 'Zed', 'Alpha'].sort(preferLiveCanonical(new Set(['Err'])))).toEqual(['Alpha', 'Zed', 'Err']);
  });

  it('applies the tie-break among names of one kind', () => {
    const shorterFirst = (a: string, b: string) => a.length - b.length || a.localeCompare(b);
    expect(['Err', 'Zed', 'Alpha', 'Bo'].sort(preferLiveCanonical(new Set(['Err', 'Bo']), shorterFirst))).toEqual([
      'Zed',
      'Alpha',
      'Bo',
      'Err',
    ]);
  });
});

describe('forcedModelNames', () => {
  const withEnum: Model[] = [
    ...models,
    {
      name: 'Live',
      fields: [
        { name: 'status', type: { kind: 'enum', name: 'LiveStatus' }, required: true },
        { name: 'child', type: { kind: 'model', name: 'LiveChild' }, required: true },
      ],
    },
    { name: 'LiveChild', fields: [{ name: 'kind', type: { kind: 'enum', name: 'ChildKind' }, required: true }] },
  ];
  const scopedCtx = {
    namespace: 'workos',
    namespacePascal: 'WorkOS',
    spec: { ...spec, models: withEnum },
    scopedServices: new Set(['Events']),
    scopedModelNames: new Set(['Err']),
    scopedEnumNames: new Set<string>(),
    priorTargetManifestPaths: new Set<string>(),
  } as any;

  it('forces the canonical of an in-scope alias, what it reaches, and records the enums on the way', () => {
    const forced = forcedModelNames(withEnum, new Map([['Err', 'Live']]), scopedCtx);
    expect([...forced].sort()).toEqual(['Live', 'LiveChild']);
    expect([...forcedEnumNames(scopedCtx)].sort()).toEqual(['ChildKind', 'LiveStatus']);
  });

  it('forces nothing on a full run and reports no enums for another spec', () => {
    const fullCtx = { ...scopedCtx, scopedServices: undefined, scopedModelNames: undefined } as any;
    expect(forcedModelNames(withEnum, new Map([['Err', 'Live']]), fullCtx).size).toBe(0);
    expect(forcedEnumNames({ ...scopedCtx, spec: { ...spec } } as any).size).toBe(0);
  });
});
