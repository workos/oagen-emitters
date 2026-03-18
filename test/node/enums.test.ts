import { describe, it, expect } from 'vitest';
import { generateEnums } from '../../src/node/enums.js';
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
  irVersion: 6,
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
          pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
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
          pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
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

  it('renders @deprecated on enum values', () => {
    const enums: Enum[] = [
      {
        name: 'Status',
        values: [
          { name: 'ACTIVE', value: 'active' },
          { name: 'LEGACY', value: 'legacy', description: 'No longer supported.', deprecated: true },
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
