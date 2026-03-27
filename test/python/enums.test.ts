import { describe, it, expect } from 'vitest';
import { generateEnums } from '../../src/python/enums.js';
import type { EmitterContext, ApiSpec, Enum, Service } from '@workos/oagen';

const emptySpec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: '',
  services: [],
  models: [],
  enums: [],
};

const ctx: EmitterContext = {
  namespace: 'workos',
  namespacePascal: 'WorkOS',
  spec: emptySpec,
};

describe('generateEnums', () => {
  it('returns empty for no enums', () => {
    expect(generateEnums([], ctx)).toEqual([]);
  });

  it('generates Union[Literal[...], str] type alias', () => {
    const enums: Enum[] = [
      {
        name: 'Status',
        values: [
          { name: 'ACTIVE', value: 'active' },
          { name: 'INACTIVE', value: 'inactive' },
          { name: 'PENDING', value: 'pending' },
        ],
      },
    ];

    const service: Service = {
      name: 'Organizations',
      operations: [
        {
          name: 'getOrganization',
          httpMethod: 'get',
          path: '/organizations/{id}',
          pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
          queryParams: [],
          headerParams: [],
          response: { kind: 'model', name: 'Organization' },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    };

    const files = generateEnums(enums, {
      ...ctx,
      spec: { ...emptySpec, services: [service] },
    });
    expect(files.length).toBe(1);
    expect(files[0].content).toContain('from typing_extensions import Literal, TypeAlias');
    expect(files[0].content).toContain('Status: TypeAlias = Union[Literal["active", "inactive", "pending"], str]');
  });

  it('places enum in service directory when referenced', () => {
    const service: Service = {
      name: 'Organizations',
      operations: [
        {
          name: 'listOrganizations',
          httpMethod: 'get',
          path: '/organizations',
          pathParams: [],
          queryParams: [
            {
              name: 'status',
              type: { kind: 'enum', name: 'OrgStatus' },
              required: false,
            },
          ],
          headerParams: [],
          response: { kind: 'primitive', type: 'unknown' },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    };

    const enums: Enum[] = [
      {
        name: 'OrgStatus',
        values: [
          { name: 'ACTIVE', value: 'active' },
          { name: 'INACTIVE', value: 'inactive' },
        ],
      },
    ];

    const files = generateEnums(enums, {
      ...ctx,
      spec: { ...emptySpec, services: [service] },
    });
    expect(files.length).toBe(1);
    expect(files[0].path).toBe('workos/organizations/models/org_status.py');
  });

  it('deduplicates values that produce the same string', () => {
    const enums: Enum[] = [
      {
        name: 'Action',
        values: [
          { name: 'SIGN_UP', value: 'sign-up' },
          { name: 'SIGN_UP_2', value: 'sign_up' },
          { name: 'SIGN_UP_3', value: 'sign up' },
        ],
      },
    ];

    const files = generateEnums(enums, ctx);
    expect(files.length).toBe(1);
    expect(files[0].content).toContain('Literal["sign-up", "sign_up", "sign up"]');
  });

  it('handles enum with descriptions', () => {
    const enums: Enum[] = [
      {
        name: 'Role',
        values: [
          { name: 'ADMIN', value: 'admin', description: 'Administrator role' },
          { name: 'MEMBER', value: 'member', description: 'Regular member' },
        ],
      },
    ];

    const files = generateEnums(enums, ctx);
    expect(files.length).toBe(1);
    expect(files[0].content).toContain('Union[Literal["admin", "member"], str]');
    expect(files[0].content).toContain('Administrator role');
  });
});
