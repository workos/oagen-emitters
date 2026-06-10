import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Model, Service } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { modelHasNewFields, createServiceDirResolver } from '../../src/node/utils.js';
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

describe('modelHasNewFields', () => {
  it('returns true when no apiSurface (Scenario B)', () => {
    const model: Model = {
      name: 'Organization',
      fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
    };
    expect(modelHasNewFields(model, ctx)).toBe(true);
  });

  it('returns true when model not in baseline', () => {
    const model: Model = {
      name: 'NewModel',
      fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
    };
    const ctxWithSurface: EmitterContext = {
      ...ctx,
      apiSurface: { interfaces: { Organization: { fields: {} } } } as any,
    };
    expect(modelHasNewFields(model, ctxWithSurface)).toBe(true);
  });

  it('returns false when all fields in baseline', () => {
    const model: Model = {
      name: 'Organization',
      fields: [
        { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
        { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
      ],
    };
    const ctxWithSurface: EmitterContext = {
      ...ctx,
      apiSurface: {
        interfaces: {
          Organization: {
            fields: {
              id: { type: 'string', optional: false },
              name: { type: 'string', optional: false },
            },
          },
        },
      } as any,
    };
    expect(modelHasNewFields(model, ctxWithSurface)).toBe(false);
  });

  it('returns true when new field added', () => {
    const model: Model = {
      name: 'Organization',
      fields: [
        { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
        { name: 'new_field', type: { kind: 'primitive', type: 'string' }, required: false },
      ],
    };
    const ctxWithSurface: EmitterContext = {
      ...ctx,
      apiSurface: {
        interfaces: {
          Organization: {
            fields: {
              id: { type: 'string', optional: false },
            },
          },
        },
      } as any,
    };
    expect(modelHasNewFields(model, ctxWithSurface)).toBe(true);
  });
});

describe('createServiceDirResolver owned-service dependency reassignment', () => {
  const retentionModel: Model = {
    name: 'AuditLogsRetention',
    fields: [{ name: 'retention_period_in_days', type: { kind: 'primitive', type: 'integer' }, required: true }],
  };

  function retentionOp(name: string, path: string) {
    return {
      name,
      httpMethod: 'get' as const,
      path,
      pathParams: [],
      queryParams: [],
      headerParams: [],
      response: { kind: 'model' as const, name: 'AuditLogsRetention' },
      errors: [],
      injectIdempotencyKey: false,
    };
  }

  // Organizations comes first, so first-reference-wins assignment parks the
  // model in `organizations/` even though only AuditLogs is owned this run.
  const services: Service[] = [
    { name: 'Organizations', operations: [retentionOp('getRetention', '/organizations/{id}/retention')] },
    { name: 'AuditLogs', operations: [retentionOp('getAuditLogsRetention', '/audit_logs/retention')] },
  ];

  function makeCtx(): EmitterContext {
    return {
      ...ctx,
      spec: { ...emptySpec, models: [retentionModel], services },
      emitterOptions: { ownedServices: ['AuditLogs'] },
    } as EmitterContext;
  }

  it('reassigns dependency models of owned services out of unemittable directories', () => {
    const surface = emptyLiveSurface();
    surface.files.add('src/workos.ts'); // existing SDK
    setActiveLiveSurface(surface);
    try {
      const testCtx = makeCtx();
      const { modelToService, resolveDir } = createServiceDirResolver([retentionModel], services, testCtx);
      expect(resolveDir(modelToService.get('AuditLogsRetention'))).toBe('audit-logs');
    } finally {
      setActiveLiveSurface(emptyLiveSurface());
    }
  });

  it('leaves the assignment alone when the interface already exists on disk', () => {
    const surface = emptyLiveSurface();
    surface.files.add('src/workos.ts');
    surface.files.add('src/organizations/interfaces/audit-logs-retention.interface.ts');
    setActiveLiveSurface(surface);
    try {
      const testCtx = makeCtx();
      const { modelToService, resolveDir } = createServiceDirResolver([retentionModel], services, testCtx);
      expect(resolveDir(modelToService.get('AuditLogsRetention'))).toBe('organizations');
    } finally {
      setActiveLiveSurface(emptyLiveSurface());
    }
  });

  it('does not reassign when no services are owned', () => {
    const surface = emptyLiveSurface();
    surface.files.add('src/workos.ts');
    setActiveLiveSurface(surface);
    try {
      const testCtx = { ...makeCtx(), emitterOptions: {} } as EmitterContext;
      const { modelToService, resolveDir } = createServiceDirResolver([retentionModel], services, testCtx);
      expect(resolveDir(modelToService.get('AuditLogsRetention'))).toBe('organizations');
    } finally {
      setActiveLiveSurface(emptyLiveSurface());
    }
  });

  it('does not reassign in greenfield mode where every directory is emittable', () => {
    const testCtx = makeCtx();
    const { modelToService, resolveDir } = createServiceDirResolver([retentionModel], services, testCtx);
    expect(resolveDir(modelToService.get('AuditLogsRetention'))).toBe('organizations');
  });

  it('reassigns the full transitive closure when ops are re-mounted onto an owned service', () => {
    // Real instance: GET/PUT /organizations/{organizationId}/audit_logs_retention
    // live on the IR Organizations service but are MOUNTED on AuditLogs via
    // resolvedOperations. Walking only IR services misses them entirely, so
    // `AuditLogsRetention` (and everything it references) stays assigned to
    // the unemittable organizations dir and is never emitted anywhere.
    const nestedModel: Model = {
      name: 'RetentionPolicy',
      fields: [{ name: 'kind', type: { kind: 'primitive', type: 'string' }, required: true }],
    };
    const retentionWithNested: Model = {
      ...retentionModel,
      fields: [
        ...retentionModel.fields,
        { name: 'policy', type: { kind: 'model', name: 'RetentionPolicy' }, required: true },
      ],
    };
    const listOrgsOp = {
      name: 'listOrganizations',
      httpMethod: 'get' as const,
      path: '/organizations',
      pathParams: [],
      queryParams: [],
      headerParams: [],
      response: { kind: 'primitive' as const, type: 'unknown' as const },
      errors: [],
      injectIdempotencyKey: false,
    };
    const mountedRetentionOp = retentionOp(
      'getAuditLogsRetention',
      '/organizations/{organizationId}/audit_logs_retention',
    );
    const orgService: Service = { name: 'Organizations', operations: [listOrgsOp, mountedRetentionOp] };
    const mountedServices: Service[] = [orgService];

    const surface = emptyLiveSurface();
    surface.files.add('src/workos.ts'); // existing SDK
    setActiveLiveSurface(surface);
    try {
      const testCtx = {
        ...ctx,
        spec: { ...emptySpec, models: [retentionWithNested, nestedModel], services: mountedServices },
        emitterOptions: { ownedServices: ['AuditLogs'] },
        resolvedOperations: [
          {
            operation: listOrgsOp,
            service: orgService,
            methodName: 'list_organizations',
            mountOn: 'Organizations',
          },
          {
            operation: mountedRetentionOp,
            service: orgService,
            methodName: 'get_audit_logs_retention',
            mountOn: 'AuditLogs',
          },
        ],
      } as unknown as EmitterContext;
      const { modelToService, resolveDir } = createServiceDirResolver(
        [retentionWithNested, nestedModel],
        mountedServices,
        testCtx,
      );
      expect(resolveDir(modelToService.get('AuditLogsRetention'))).toBe('audit-logs');
      // Nested dependency N follows M into the owned dir — the closure must
      // not stop at the directly-referenced model.
      expect(resolveDir(modelToService.get('RetentionPolicy'))).toBe('audit-logs');
    } finally {
      setActiveLiveSurface(emptyLiveSurface());
    }
  });
});
