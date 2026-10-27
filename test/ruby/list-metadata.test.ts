import { describe, it, expect } from 'vitest';
import { generateModels } from '../../src/ruby/models.js';
import type { EmitterContext, ApiSpec, Model, Service } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';

const cursors: Model['fields'] = [
  { name: 'before', type: { kind: 'nullable', inner: { kind: 'primitive', type: 'string' } }, required: true },
  { name: 'after', type: { kind: 'nullable', inner: { kind: 'primitive', type: 'string' } }, required: true },
];
const models: Model[] = [
  { name: 'Version', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
  { name: 'User', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
  // Returned as-is by a non-paginated operation: kept, with the metadata it reaches.
  {
    name: 'VersionListResponse',
    fields: [
      { name: 'data', type: { kind: 'array', items: { kind: 'model', name: 'Version' } }, required: true },
      { name: 'list_metadata', type: { kind: 'model', name: 'ListMetadata' }, required: true },
    ],
  },
  { name: 'ListMetadata', fields: cursors },
  // Unwrapped by the pagination iterator: neither the wrapper nor its metadata is emitted.
  {
    name: 'UserList',
    fields: [
      { name: 'data', type: { kind: 'array', items: { kind: 'model', name: 'User' } }, required: true },
      { name: 'list_metadata', type: { kind: 'model', name: 'UserListListMetadata' }, required: true },
    ],
  },
  { name: 'UserListListMetadata', fields: cursors },
];
const services: Service[] = [
  {
    name: 'Vault',
    operations: [
      {
        name: 'listKvVersions',
        httpMethod: 'get',
        path: '/vault/v1/kv/{id}/versions',
        pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
        queryParams: [],
        headerParams: [],
        response: { kind: 'model', name: 'VersionListResponse' },
        errors: [],
        injectIdempotencyKey: false,
      },
      {
        name: 'listUsers',
        httpMethod: 'get',
        path: '/users',
        pathParams: [],
        queryParams: [],
        headerParams: [],
        response: { kind: 'model', name: 'UserList' },
        pagination: { strategy: 'cursor', itemType: { kind: 'model', name: 'User' } } as any,
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

describe('ruby/models list scaffolding', () => {
  it('emits the metadata model a kept non-paginated wrapper references', () => {
    const files = generateModels(models, ctx);
    const paths = files.map((f) => f.path);

    const wrapper = files.find((f) => f.path.endsWith('/version_list_response.rb'))!;
    expect(wrapper.content).toContain('WorkOS::ListMetadata.new');
    const metadata = files.find((f) => f.path.endsWith('/list_metadata.rb'))!;
    expect(metadata).toBeDefined();
    expect(metadata.content).toContain('class ListMetadata');

    expect(paths.some((p) => p.endsWith('/user_list.rb'))).toBe(false);
    expect(paths.some((p) => p.endsWith('/user_list_list_metadata.rb'))).toBe(false);
  });
});
