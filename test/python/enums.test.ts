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

  it('generates str, Enum class', () => {
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
    expect(files[0].content).toContain('from enum import Enum');
    expect(files[0].content).toContain('class Status(str, Enum):');
    expect(files[0].content).toContain('    ACTIVE = "active"');
    expect(files[0].content).toContain('    INACTIVE = "inactive"');
    expect(files[0].content).toContain('    PENDING = "pending"');
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
    expect(files[0].path).toBe('src/workos/organizations/models/org_status.py');
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
    expect(files[0].content).toContain('class Action(str, Enum):');
    expect(files[0].content).toContain('SIGN_UP = "sign-up"');
    expect(files[0].content).toContain('SIGN_UP_2 = "sign_up"');
    expect(files[0].content).toContain('SIGN_UP_3 = "sign up"');
  });

  it('generates type alias for structurally identical enums', () => {
    const enums: Enum[] = [
      {
        name: 'ConnectionType',
        values: [
          { name: 'SAML', value: 'saml' },
          { name: 'OIDC', value: 'oidc' },
        ],
      },
      {
        name: 'ProfileConnectionType',
        values: [
          { name: 'SAML', value: 'saml' },
          { name: 'OIDC', value: 'oidc' },
        ],
      },
    ];

    const files = generateEnums(enums, ctx);
    expect(files.length).toBe(2);

    // Canonical (alphabetically first) should be a full enum
    const canonical = files.find((f) => f.path.includes('connection_type.py') && !f.path.includes('profile'))!;
    expect(canonical).toBeDefined();
    expect(canonical.content).toContain('class ConnectionType(str, Enum):');

    // Alias should import canonical and create assignment alias
    const alias = files.find((f) => f.path.includes('profile_connection_type.py'))!;
    expect(alias).toBeDefined();
    expect(alias.content).toContain('import ConnectionType');
    expect(alias.content).toContain('ProfileConnectionType = ConnectionType');
    expect(alias.content).not.toContain('Literal');
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
    expect(files[0].content).toContain('class Role(str, Enum):');
    expect(files[0].content).toContain('ADMIN = "admin"');
    expect(files[0].content).toContain('Administrator role');
  });
});
