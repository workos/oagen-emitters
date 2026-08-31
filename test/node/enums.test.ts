import { describe, it, expect, vi } from 'vitest';
import type { EmitterContext, ApiSpec, Enum, Model, Service } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateEnums, assignEnumsToServices } from '../../src/node/enums.js';
import { nodeEmitter } from '../../src/node/index.js';
import { emptyLiveSurface, setActiveLiveSurface } from '../../src/node/live-surface.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

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

  it('prefixes member names derived from values that start with a digit', () => {
    const enums: Enum[] = [
      {
        name: 'AuditLogsRetentionPeriod',
        values: [
          { name: '1_MONTH', value: '1_MONTH' },
          { name: '10_YEARS', value: '10_YEARS' },
        ],
      },
    ];

    const result = generateEnums(enums, ctx);
    const content = result[0].content;

    expect(content).toContain("Value1Month: '1_MONTH',");
    expect(content).toContain("Value10Years: '10_YEARS',");
    // A bare `1Month:` key is not a valid unquoted identifier.
    expect(content).not.toMatch(/^\s+\d/m);
  });

  it('keeps every wire value when the digit prefix collides with a sibling', () => {
    // `1_MONTH` guards to Value1Month; `VALUE_1_MONTH` pascal-cases to it
    // directly. Dropping the loser would omit a value from the union type.
    const enums: Enum[] = [
      {
        name: 'RetentionPeriod',
        values: [
          { name: '1_MONTH', value: '1_MONTH' },
          { name: 'VALUE_1_MONTH', value: 'VALUE_1_MONTH' },
        ],
      },
    ];

    const content = generateEnums(enums, ctx)[0].content;

    expect(content).toContain("Value1Month: '1_MONTH',");
    expect(content).toContain("Value1Month2: 'VALUE_1_MONTH',");
    // Both wire values survive into the const object, so the derived union
    // covers both. A duplicate key would also be a TS error.
    expect(content.match(/Value1Month2?:/g)).toHaveLength(2);
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

describe('assignEnumsToServices common-home unassignment under ownership', () => {
  // Inverse of the reassignment case above: an enum referenced by an OWNED
  // service is first-reference-assigned into that service, but its canonical
  // declaration already lives under `src/common/`. The unassignment guard
  // must drop it back to `common` so the owned-service exception in
  // `generateEnums` does not emit a SECOND copy alongside the existing
  // `common` one (a duplicate `export *` / TS2308).
  const connectionType: Enum = {
    name: 'ConnectionType',
    values: [
      { name: 'GOOGLE_SAML', value: 'GoogleSAML' },
      { name: 'OKTA_SAML', value: 'OktaSAML' },
    ],
  };
  const ssoService: Service = {
    name: 'SSO',
    operations: [
      {
        name: 'listConnections',
        httpMethod: 'get',
        path: '/connections',
        pathParams: [],
        queryParams: [
          {
            name: 'connectionType',
            type: { kind: 'enum', name: 'ConnectionType', values: ['GoogleSAML', 'OktaSAML'] },
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

  const makeCtx = (overrides: Partial<EmitterContext>): EmitterContext =>
    ({
      ...ctx,
      spec: { ...emptySpec, enums: [connectionType], services: [ssoService] },
      emitterOptions: { ownedServices: ['SSO'] },
      ...overrides,
    }) as EmitterContext;

  it('unassigns an owned-service enum whose apiSurface sourceFile is under src/common/', () => {
    const ctxOwned = makeCtx({
      apiSurface: {
        classes: {},
        interfaces: {},
        typeAliases: {},
        exports: {},
        enums: { ConnectionType: { sourceFile: 'src/common/interfaces/connection-type.interface.ts' } },
      },
    } as unknown as Partial<EmitterContext>);

    const map = assignEnumsToServices([connectionType], [ssoService], [], ctxOwned);
    // Unassigned → resolves to `common`, not the owned `SSO` directory.
    expect(map.has('ConnectionType')).toBe(false);
  });

  it('unassigns via the typeAliases sourceFile lookup (literal-union baseline form)', () => {
    const ctxOwned = makeCtx({
      apiSurface: {
        classes: {},
        interfaces: {},
        enums: {},
        exports: {},
        typeAliases: {
          ConnectionType: {
            value: "'GoogleSAML' | 'OktaSAML'",
            sourceFile: 'src/common/interfaces/connection-type.interface.ts',
          },
        },
      },
    } as unknown as Partial<EmitterContext>);

    const map = assignEnumsToServices([connectionType], [ssoService], [], ctxOwned);
    expect(map.has('ConnectionType')).toBe(false);
  });

  it('falls back to the live-surface interface path when no apiSurface entry exists', () => {
    // Guards the `liveSurfaceInterfacePath(name)` fallback: with no apiSurface,
    // the canonical home is only discoverable through the scanned live surface.
    const surface = emptyLiveSurface();
    surface.files.add('src/workos.ts');
    surface.interfaces.set('ConnectionType', {
      filePath: 'src/common/interfaces/connection-type.interface.ts',
      fields: new Set(),
    });
    setActiveLiveSurface(surface);
    try {
      const map = assignEnumsToServices([connectionType], [ssoService], [], makeCtx({}));
      expect(map.has('ConnectionType')).toBe(false);
    } finally {
      setActiveLiveSurface(emptyLiveSurface());
    }
  });

  it('keeps an owned-service enum whose canonical home is NOT under src/common/', () => {
    // The guard is specific to `src/common/`: an enum that genuinely belongs to
    // the owned service must stay assigned there.
    const ctxOwned = makeCtx({
      apiSurface: {
        classes: {},
        interfaces: {},
        typeAliases: {},
        exports: {},
        enums: { ConnectionType: { sourceFile: 'src/sso/interfaces/connection-type.interface.ts' } },
      },
    } as unknown as Partial<EmitterContext>);

    const map = assignEnumsToServices([connectionType], [ssoService], [], ctxOwned);
    expect(map.get('ConnectionType')).toBe('SSO');
  });

  it('does not unassign for a non-owned service even when the home is under src/common/', () => {
    // The unassignment only applies under ownership — a non-owned service keeps
    // its first-reference assignment regardless of where the enum's home is.
    const ctxNotOwned = {
      ...ctx,
      spec: { ...emptySpec, enums: [connectionType], services: [ssoService] },
      apiSurface: {
        classes: {},
        interfaces: {},
        typeAliases: {},
        exports: {},
        enums: { ConnectionType: { sourceFile: 'src/common/interfaces/connection-type.interface.ts' } },
      },
    } as unknown as EmitterContext;

    const map = assignEnumsToServices([connectionType], [ssoService], [], ctxNotOwned);
    expect(map.get('ConnectionType')).toBe('SSO');
  });
});

describe('owned-service enum emission under the live-surface skip', () => {
  function ownedDomainSpec(enums: Enum[], models: Model[]): ApiSpec {
    return {
      ...emptySpec,
      enums,
      models,
      services: [
        {
          name: 'OrganizationDomains',
          operations: [
            {
              name: 'getOrganizationDomain',
              httpMethod: 'get',
              path: '/organization_domains/{id}',
              pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
              queryParams: [],
              headerParams: [],
              response: { kind: 'model', name: 'OrganizationDomain' },
              errors: [],
              injectIdempotencyKey: false,
            },
          ],
        },
      ],
    };
  }

  const stateEnum: Enum = {
    name: 'OrganizationDomainState',
    values: [
      { name: 'VERIFIED', value: 'verified' },
      { name: 'PENDING', value: 'pending' },
    ],
  };
  const domainModel: Model = {
    name: 'OrganizationDomain',
    fields: [
      { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
      {
        name: 'state',
        type: { kind: 'enum', name: 'OrganizationDomainState', values: ['verified', 'pending'] },
        required: true,
      },
    ],
  };

  it('still emits the union module when the name is declared in a file the owned regeneration overwrites', () => {
    // Real instance (OrganizationDomains rebuild, service OWNED): the
    // on-disk organization-domain.interface.ts declared the enum names, so
    // the live-surface skip suppressed emitting the canonical modules — but
    // that very file was simultaneously being OVERWRITTEN by the owned
    // regeneration, leaving the names declared nowhere.
    const surface = emptyLiveSurface();
    surface.files.add('src/workos.ts'); // existing SDK
    surface.files.add('src/organization-domains/interfaces/organization-domain.interface.ts');
    surface.interfaces.set('OrganizationDomainState', {
      filePath: 'src/organization-domains/interfaces/organization-domain.interface.ts',
      fields: new Set(),
    });
    setActiveLiveSurface(surface);
    try {
      const ctxOwned: EmitterContext = {
        ...ctx,
        spec: ownedDomainSpec([stateEnum], [domainModel]),
        emitterOptions: { ownedServices: ['OrganizationDomains'] },
      } as EmitterContext;

      const result = generateEnums([stateEnum], ctxOwned);
      const enumFile = result.find(
        (f) => f.path === 'src/organization-domains/interfaces/organization-domain-state.interface.ts',
      );
      expect(enumFile).toBeDefined();
      expect(enumFile!.content).toContain('export const OrganizationDomainState = {');
      expect(enumFile!.content).toContain('export type OrganizationDomainState =');
    } finally {
      setActiveLiveSurface(emptyLiveSurface());
    }
  });

  it('keeps the skip for non-owned services whose enum genuinely lives elsewhere', () => {
    const surface = emptyLiveSurface();
    surface.files.add('src/workos.ts');
    surface.interfaces.set('OrganizationDomainState', {
      filePath: 'src/common/interfaces/organization-domain-state.interface.ts',
      fields: new Set(),
    });
    setActiveLiveSurface(surface);
    try {
      const ctxNotOwned: EmitterContext = {
        ...ctx,
        spec: ownedDomainSpec([stateEnum], [domainModel]),
      } as EmitterContext;

      const result = generateEnums([stateEnum], ctxNotOwned);
      expect(result).toHaveLength(0);
    } finally {
      setActiveLiveSurface(emptyLiveSurface());
    }
  });

  it('emits the module, resolves the barrel export, and imports the name in the model file', () => {
    // End-to-end shape of the OrganizationDomains failure: generated
    // organization-domain.interface.ts used `OrganizationDomainState` with
    // NO import, and interfaces/index.ts exported
    // ./organization-domain-state.interface — a module no hook ever emitted.
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'node-owned-enum-'));
    try {
      const ifaceDir = path.join(tmpRoot, 'src', 'organization-domains', 'interfaces');
      fs.mkdirSync(ifaceDir, { recursive: true });
      fs.writeFileSync(path.join(tmpRoot, 'src', 'workos.ts'), 'export class WorkOS {}\n');
      fs.writeFileSync(
        path.join(ifaceDir, 'organization-domain.interface.ts'),
        [
          "export type OrganizationDomainState = 'verified' | 'pending';",
          '',
          'export interface OrganizationDomain {',
          '  id: string;',
          '  state: OrganizationDomainState;',
          '}',
        ].join('\n'),
      );
      execFileSync('git', ['init'], { cwd: tmpRoot, stdio: 'ignore' });
      execFileSync('git', ['add', 'src'], { cwd: tmpRoot, stdio: 'ignore' });

      const spec = ownedDomainSpec([stateEnum], [domainModel]);
      const runCtx = {
        ...ctx,
        spec,
        outputDir: tmpRoot,
        emitterOptions: { ownedServices: ['OrganizationDomains'] },
      } as EmitterContext;

      const modelFiles = nodeEmitter.generateModels([domainModel], runCtx);
      const enumFiles = nodeEmitter.generateEnums([stateEnum], runCtx);
      const clientFiles = nodeEmitter.generateClient(spec, runCtx);

      // The canonical union module IS emitted…
      const enumPath = 'src/organization-domains/interfaces/organization-domain-state.interface.ts';
      expect(enumFiles.some((f) => f.path === enumPath)).toBe(true);

      // …the model file imports the name from it…
      const modelFile = modelFiles.find(
        (f) => f.path === 'src/organization-domains/interfaces/organization-domain.interface.ts',
      );
      expect(modelFile).toBeDefined();
      expect(modelFile!.content).toContain(
        "import type { OrganizationDomainState } from './organization-domain-state.interface';",
      );

      // …and the barrel export resolves to an emitted module instead of a
      // phantom the import-invariant pass has to drop.
      const barrel = clientFiles.find((f) => f.path === 'src/organization-domains/interfaces/index.ts');
      expect(barrel).toBeDefined();
      expect(barrel!.content).toContain("export * from './organization-domain-state.interface';");

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        nodeEmitter.generateTests(spec, runCtx);
        const dropped = warnSpy.mock.calls.filter((call) => String(call[0]).includes('dropped unresolvable'));
        expect(dropped).toEqual([]);
      } finally {
        warnSpy.mockRestore();
      }
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
