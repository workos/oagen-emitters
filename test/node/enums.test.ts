import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Enum } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateEnums } from '../../src/node/enums.js';

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

    const result = generateEnums(enums, ctx);

    expect(result).toHaveLength(1);
    expect(result[0].content).toContain('export type Status =');
    expect(result[0].content).toContain("| 'active'");
    expect(result[0].content).toContain("| 'inactive'");
    expect(result[0].content).toContain("| 'pending';");
  });

  it('places enum in common when not referenced by service', () => {
    const enums: Enum[] = [
      {
        name: 'Status',
        values: [{ name: 'ACTIVE', value: 'active' }],
      },
    ];

    const result = generateEnums(enums, ctx);

    expect(result[0].path).toBe('src/common/interfaces/status.interface.ts');
  });

  it('places enum in service directory when referenced', () => {
    const enums: Enum[] = [
      {
        name: 'OrgStatus',
        values: [{ name: 'ACTIVE', value: 'active' }],
      },
    ];

    const specWithServices: ApiSpec = {
      ...emptySpec,
      enums,
      services: [
        {
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
                  type: { kind: 'enum', name: 'OrgStatus', values: ['active'] },
                  required: false,
                },
              ],
              headerParams: [],
              response: { kind: 'primitive', type: 'unknown' },
              errors: [],
              injectIdempotencyKey: false,
            },
          ],
        },
      ],
    };

    const ctxWithServices: EmitterContext = {
      ...ctx,
      spec: specWithServices,
    };

    const result = generateEnums(enums, ctxWithServices);

    expect(result[0].path).toBe('src/organizations/interfaces/org-status.interface.ts');
  });

  it('renders @deprecated on enum values', () => {
    const enums: Enum[] = [
      {
        name: 'Method',
        values: [
          { name: 'ACTIVE', value: 'active' },
          { name: 'OLD', value: 'old', deprecated: true, description: 'No longer supported.' },
          { name: 'BARE', value: 'bare', deprecated: true },
        ],
      },
    ];

    const result = generateEnums(enums, ctx);

    expect(result[0].content).toContain('No longer supported.\n   * @deprecated');
    expect(result[0].content).toContain('/** @deprecated */');
  });
});
