import { describe, it, expect } from 'vitest';
import { generateEnums } from '../../src/python/enums.js';
import type { EmitterContext, ApiSpec, Enum, Service } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';

const emptySpec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: '',
  services: [],
  models: [],
  enums: [],
  sdk: defaultSdkBehavior(),
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
    expect(files[0].content).toContain('def _missing_(cls, value: object) -> Optional["Status"]:');
    expect(files[0].content).toContain('unknown = str.__new__(cls, value)');
    expect(files[0].content).toContain('StatusLiteral: TypeAlias = Literal["active", "inactive", "pending"]');
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

  it('places enum in common/ when referenced by 2+ services', () => {
    const makeService = (name: string, opName: string): Service => ({
      name,
      operations: [
        {
          name: opName,
          httpMethod: 'get',
          path: `/${name.toLowerCase()}`,
          pathParams: [],
          queryParams: [
            {
              name: 'order',
              type: { kind: 'enum', name: 'PaginationOrder' },
              required: false,
            },
          ],
          headerParams: [],
          response: { kind: 'primitive', type: 'unknown' },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    });

    const enums: Enum[] = [
      {
        name: 'PaginationOrder',
        values: [
          { name: 'NORMAL', value: 'normal' },
          { name: 'DESC', value: 'desc' },
          { name: 'ASC', value: 'asc' },
        ],
      },
    ];

    // Authorization comes alphabetically first; without the shared rule the
    // enum would land under authorization/. Two services referencing it must
    // route it to common/ instead.
    const services = [makeService('Authorization', 'listAuthz'), makeService('Organizations', 'listOrgs')];

    const files = generateEnums(enums, {
      ...ctx,
      spec: { ...emptySpec, services },
    });

    const enumFile = files.find((f) => f.path.endsWith('pagination_order.py'));
    expect(enumFile).toBeDefined();
    expect(enumFile!.path).toBe('src/workos/common/models/pagination_order.py');
    // No service-local copy should exist.
    expect(files.find((f) => f.path === 'src/workos/authorization/models/pagination_order.py')).toBeUndefined();
    expect(files.find((f) => f.path === 'src/workos/organizations/models/pagination_order.py')).toBeUndefined();
  });

  it('keeps enum in service dir when only one service references it', () => {
    const service: Service = {
      name: 'Organizations',
      operations: [
        {
          name: 'listOrgs',
          httpMethod: 'get',
          path: '/orgs',
          pathParams: [],
          queryParams: [
            {
              name: 'order',
              type: { kind: 'enum', name: 'OnlyOrgsOrder' },
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
        name: 'OnlyOrgsOrder',
        values: [{ name: 'ASC', value: 'asc' }],
      },
    ];

    const files = generateEnums(enums, {
      ...ctx,
      spec: { ...emptySpec, services: [service] },
    });
    expect(files[0].path).toBe('src/workos/organizations/models/only_orgs_order.py');
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
    expect(alias.content).toContain('ProfileConnectionType: TypeAlias = ConnectionType');
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

  it('preserves canonical enum values from the spec', () => {
    const enums: Enum[] = [
      {
        name: 'Provider',
        values: [{ name: 'GITHUB_OAUTH', value: 'GithubOAuth' }],
      },
    ];

    const files = generateEnums(enums, ctx);
    expect(files[0].content).toContain('"GithubOAuth"');
    expect(files[0].content).not.toContain('"GitHubOAuth"');
  });

  it('adds .. deprecated:: docstring for deprecated enum values', () => {
    const enums: Enum[] = [
      {
        name: 'Status',
        values: [
          { name: 'ACTIVE', value: 'active' },
          { name: 'OLD_STATUS', value: 'old_status', deprecated: true, description: 'Use ACTIVE instead' },
          { name: 'LEGACY', value: 'legacy', deprecated: true },
        ],
      },
    ];

    const files = generateEnums(enums, ctx);
    expect(files.length).toBe(1);
    const content = files[0].content;

    // Deprecated value with description gets both
    expect(content).toContain('OLD_STATUS = "old_status"');
    expect(content).toContain('"""Use ACTIVE instead\n\n    .. deprecated::"""');

    // Deprecated value without description gets just .. deprecated::
    expect(content).toContain('LEGACY = "legacy"');
    expect(content).toContain('""".. deprecated::"""');

    // Non-deprecated value should not get a docstring
    expect(content).toContain('ACTIVE = "active"');
    const activeIdx = content.indexOf('ACTIVE = "active"');
    const nextLine = content.slice(activeIdx).split('\n')[1];
    expect(nextLine).not.toContain('"""');
  });
  it('prefixes members whose wire value starts with a digit', () => {
    const enums: Enum[] = [
      {
        name: 'RetentionPeriod',
        values: [
          { name: '1_MONTH', value: '1_MONTH' },
          { name: '10_YEARS', value: '10_YEARS' },
        ],
      },
    ];

    const files = generateEnums(enums, ctx);
    expect(files.length).toBe(1);
    expect(files[0].content).toContain('    VALUE_1_MONTH = "1_MONTH"');
    expect(files[0].content).toContain('    VALUE_10_YEARS = "10_YEARS"');
  });
});
