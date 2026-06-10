import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Enum } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateEnums } from '../../src/node/enums.js';
import { emptyLiveSurface, setActiveLiveSurface } from '../../src/node/live-surface.js';

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

  it('generates const-object enum with derived type alias', () => {
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
    expect(result[0].content).toContain('export const Status = {');
    expect(result[0].content).toContain("Active: 'active'");
    expect(result[0].content).toContain("Inactive: 'inactive'");
    expect(result[0].content).toContain("Pending: 'pending'");
    expect(result[0].content).toContain('} as const;');
    expect(result[0].content).toContain('export type Status =');
    expect(result[0].content).toContain('(typeof Status)[keyof typeof Status]');
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

describe('assignEnumsToServices owned-service dependency reassignment', () => {
  it('follows a reassigned dependency model into the owned service', () => {
    // The enum is referenced only through `AuditLogsRetention`, whose
    // first-reference assignment is Organizations (unemittable this run).
    // When the owned AuditLogs service pulls the model into `audit-logs/`,
    // the enum must follow — otherwise the model file imports an enum file
    // that is emitted nowhere.
    const surface = emptyLiveSurface();
    surface.files.add('src/workos.ts'); // existing SDK
    setActiveLiveSurface(surface);
    try {
      const enums: Enum[] = [
        {
          name: 'RetentionPeriod',
          values: [
            { name: 'THIRTY_DAYS', value: '30d' },
            { name: 'NINETY_DAYS', value: '90d' },
          ],
        },
      ];
      const models = [
        {
          name: 'AuditLogsRetention',
          fields: [
            {
              name: 'period',
              type: { kind: 'enum' as const, name: 'RetentionPeriod', values: ['30d', '90d'] },
              required: true,
            },
          ],
        },
      ];
      const retentionOp = (name: string, path: string) => ({
        name,
        httpMethod: 'get' as const,
        path,
        pathParams: [],
        queryParams: [],
        headerParams: [],
        response: { kind: 'model' as const, name: 'AuditLogsRetention' },
        errors: [],
        injectIdempotencyKey: false,
      });
      const services = [
        { name: 'Organizations', operations: [retentionOp('getRetention', '/organizations/{id}/retention')] },
        { name: 'AuditLogs', operations: [retentionOp('getAuditLogsRetention', '/audit_logs/retention')] },
      ];
      const ctxOwned: EmitterContext = {
        ...ctx,
        spec: { ...emptySpec, enums, models, services },
        emitterOptions: { ownedServices: ['AuditLogs'] },
      } as EmitterContext;

      const result = generateEnums(enums, ctxOwned);
      expect(result).toHaveLength(1);
      expect(result[0].path).toBe('src/audit-logs/interfaces/retention-period.interface.ts');
    } finally {
      setActiveLiveSurface(emptyLiveSurface());
    }
  });
});
