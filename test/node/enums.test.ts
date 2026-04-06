import { describe, it, expect } from 'vitest';
import { generateEnums } from '../../src/node/enums.js';
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

  it('generates string literal union type', () => {
    const service: Service = {
      name: 'Organizations',
      operations: [
        {
          name: 'getOrganization',
          httpMethod: 'get',
          path: '/organizations/{id}',
          pathParams: [
            {
              name: 'id',
              type: { kind: 'primitive', type: 'string' },
              required: true,
            },
          ],
          queryParams: [],
          headerParams: [],
          response: {
            kind: 'model',
            name: 'Organization',
          },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    };

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

    // Enum not referenced by any service → placed in common/
    const files = generateEnums(enums, {
      ...ctx,
      spec: { ...emptySpec, services: [service] },
    });
    expect(files.length).toBe(1);
    expect(files[0].content).toMatchInlineSnapshot(`
      "export type Status =
        | 'active'
        | 'inactive'
        | 'pending';"
    `);
  });

  it('places enum in service directory when referenced', () => {
    const service: Service = {
      name: 'Organizations',
      operations: [
        {
          name: 'getOrganization',
          httpMethod: 'get',
          path: '/organizations/{id}',
          pathParams: [
            {
              name: 'id',
              type: { kind: 'primitive', type: 'string' },
              required: true,
            },
          ],
          queryParams: [],
          headerParams: [],
          response: { kind: 'enum', name: 'OrgStatus' },
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
    expect(files[0].path).toBe('src/organizations/interfaces/org-status.interface.ts');
  });

  it('derives PascalCase member names when merging new enum values into baseline', () => {
    const enums: Enum[] = [
      {
        name: 'OrganizationDomainState',
        values: [
          { name: 'FAILED', value: 'failed' },
          { name: 'PENDING', value: 'pending' },
          { name: 'VERIFIED', value: 'verified' },
          { name: 'LEGACY_VERIFIED', value: 'legacy_verified' },
          { name: 'UNVERIFIED', value: 'unverified' },
        ],
      },
    ];

    const testCtx: EmitterContext = {
      ...ctx,
      apiSurface: {
        language: 'node',
        extractedFrom: 'test',
        extractedAt: '2024-01-01',
        classes: {},
        interfaces: {},
        typeAliases: {},
        enums: {
          OrganizationDomainState: {
            name: 'OrganizationDomainState',
            members: {
              Failed: 'failed',
              Pending: 'pending',
              Verified: 'verified',
            },
          },
        },
        exports: {},
      },
    };

    const files = generateEnums(enums, testCtx);
    const content = files[0].content;

    // Existing members should be preserved as-is
    expect(content).toContain("Failed = 'failed',");
    expect(content).toContain("Pending = 'pending',");
    expect(content).toContain("Verified = 'verified',");

    // New members should be PascalCase, not lowercased
    expect(content).toContain("LegacyVerified = 'legacy_verified',");
    expect(content).toContain("Unverified = 'unverified',");

    // Should NOT produce lowercased member names
    expect(content).not.toContain('legacyverified');
  });

  it('renders @deprecated on enum values', () => {
    const enums: Enum[] = [
      {
        name: 'Status',
        values: [
          { name: 'ACTIVE', value: 'active' },
          {
            name: 'LEGACY',
            value: 'legacy',
            description: 'No longer supported.',
            deprecated: true,
          },
          { name: 'OLD', value: 'old', deprecated: true },
        ],
      },
    ];

    const files = generateEnums(enums, ctx);
    const content = files[0].content;

    // Value with description + deprecated gets multiline JSDoc
    expect(content).toContain('  /**\n   * No longer supported.\n   * @deprecated\n   */');

    // Value with only deprecated gets single-line JSDoc
    expect(content).toContain('  /** @deprecated */');
  });
});
