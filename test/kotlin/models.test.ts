import { describe, it, expect } from 'vitest';
import { generateModels } from '../../src/kotlin/models.js';
import { generateEnums } from '../../src/kotlin/enums.js';
import type { EmitterContext, ApiSpec, Model } from '@workos/oagen';
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

describe('kotlin/models', () => {
  it('returns empty for no models', () => {
    generateEnums([], ctx);
    expect(generateModels([], ctx)).toEqual([]);
  });

  it('generates a Kotlin data class with Jackson annotations', () => {
    const models: Model[] = [
      {
        name: 'Organization',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
          {
            name: 'created_at',
            type: { kind: 'primitive', type: 'string', format: 'date-time' },
            required: true,
          },
          {
            name: 'external_id',
            type: { kind: 'nullable', inner: { kind: 'primitive', type: 'string' } },
            required: false,
          },
        ],
      },
    ];

    generateEnums([], ctx);
    const files = generateModels(models, { ...ctx, spec: { ...emptySpec, models } });

    expect(files.length).toBeGreaterThanOrEqual(1);
    const modelFile = files.find((f) => f.path.includes('Organization.kt'))!;
    expect(modelFile).toBeDefined();

    const content = modelFile.content;
    expect(content).toContain('data class Organization');
    expect(content).toContain('@JsonProperty("id")');
    expect(content).not.toContain('@JvmField');
    expect(content).toContain('OffsetDateTime');
    expect(content).toContain('externalId: String?');
  });

  it('skips list wrapper and list metadata models', () => {
    const models: Model[] = [
      {
        name: 'Organization',
        fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
      {
        name: 'OrganizationList',
        fields: [
          {
            name: 'data',
            type: { kind: 'array', items: { kind: 'model', name: 'Organization' } },
            required: true,
          },
          {
            name: 'list_metadata',
            type: { kind: 'model', name: 'ListMetadata' },
            required: true,
          },
        ],
      },
      {
        name: 'ListMetadata',
        fields: [
          { name: 'before', type: { kind: 'primitive', type: 'string' }, required: false },
          { name: 'after', type: { kind: 'primitive', type: 'string' }, required: false },
        ],
      },
    ];

    generateEnums([], ctx);
    const files = generateModels(models, { ...ctx, spec: { ...emptySpec, models } });
    const filePaths = files.map((f) => f.path);

    expect(filePaths.some((p) => p.includes('Organization.kt') && !p.includes('List'))).toBe(true);
    expect(filePaths.some((p) => p.includes('OrganizationList.kt'))).toBe(false);
    expect(filePaths.some((p) => p.includes('ListMetadata.kt'))).toBe(false);
  });

  it('scoped run: WorkOSEvent registry omits brand-new out-of-scope events but retains on-disk ones', () => {
    // An event envelope model: id + event(literal) + created_at + data.
    const eventModel = (name: string, wire: string): Model => ({
      name,
      fields: [
        { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
        { name: 'event', type: { kind: 'literal', value: wire }, required: true },
        { name: 'created_at', type: { kind: 'primitive', type: 'string', format: 'date-time' }, required: true },
        { name: 'data', type: { kind: 'map', valueType: { kind: 'primitive', type: 'unknown' } }, required: true },
      ],
    });

    const models: Model[] = [
      eventModel('OrganizationMembershipCreated', 'organization_membership.created'), // in scope
      eventModel('SessionReauthenticated', 'session.reauthenticated'), // brand-new, out of scope, NOT on disk
      eventModel('PipesConnectedAccountConnectionFailed', 'connected_account.connection_failed'), // out of scope, ON disk
    ];
    const spec: ApiSpec = { ...emptySpec, models };

    // Scoped run: only OrganizationMembershipCreated is in scope this run.
    // PipesConnectedAccountConnectionFailed is out of scope but its .kt file is
    // still on disk (recorded in the prior manifest), so it must be retained.
    // SessionReauthenticated is brand new + out of scope ⇒ its file is never
    // emitted ⇒ it must be omitted from the registry.
    const scopedCtx: EmitterContext = {
      ...ctx,
      spec,
      scopedServices: new Set(['OrganizationMembership']),
      scopedModelNames: new Set(['OrganizationMembershipCreated']),
      priorTargetManifestPaths: new Set(['src/main/kotlin/com/workos/models/PipesConnectedAccountConnectionFailed.kt']),
    };

    generateEnums([], scopedCtx);
    const files = generateModels(models, scopedCtx);

    const registry = files.find((f) => f.path.endsWith('WorkOSEvent.kt'));
    expect(registry).toBeDefined();
    const content = registry!.content;

    // In scope ⇒ listed.
    expect(content).toContain('OrganizationMembershipCreated::class');
    // Out of scope but on disk ⇒ retained.
    expect(content).toContain('PipesConnectedAccountConnectionFailed::class');
    // Brand-new + out of scope ⇒ omitted (this was the build break).
    expect(content).not.toContain('SessionReauthenticated::class');

    // The per-model FILE for the out-of-scope events must NOT be emitted.
    expect(files.some((f) => f.path.endsWith('SessionReauthenticated.kt'))).toBe(false);
    expect(files.some((f) => f.path.endsWith('PipesConnectedAccountConnectionFailed.kt'))).toBe(false);
  });

  it('full run: WorkOSEvent registry lists every event model', () => {
    const eventModel = (name: string, wire: string): Model => ({
      name,
      fields: [
        { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
        { name: 'event', type: { kind: 'literal', value: wire }, required: true },
        { name: 'created_at', type: { kind: 'primitive', type: 'string', format: 'date-time' }, required: true },
        { name: 'data', type: { kind: 'map', valueType: { kind: 'primitive', type: 'unknown' } }, required: true },
      ],
    });
    const models: Model[] = [
      eventModel('OrganizationMembershipCreated', 'organization_membership.created'),
      eventModel('SessionReauthenticated', 'session.reauthenticated'),
    ];
    const spec: ApiSpec = { ...emptySpec, models };

    generateEnums([], { ...ctx, spec });
    const files = generateModels(models, { ...ctx, spec });
    const registry = files.find((f) => f.path.endsWith('WorkOSEvent.kt'))!;
    expect(registry.content).toContain('OrganizationMembershipCreated::class');
    expect(registry.content).toContain('SessionReauthenticated::class');
  });

  it('deduplicates structurally identical models preferring shorter names', () => {
    const models: Model[] = [
      {
        name: 'EmailChangeConfirmationUser',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'email', type: { kind: 'primitive', type: 'string' }, required: true },
        ],
      },
      {
        name: 'User',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'email', type: { kind: 'primitive', type: 'string' }, required: true },
        ],
      },
    ];

    generateEnums([], ctx);
    const files = generateModels(models, { ...ctx, spec: { ...emptySpec, models } });

    // User should be the canonical (shorter name) — a data class
    const userFile = files.find((f) => f.path.includes('/User.kt'))!;
    expect(userFile).toBeDefined();
    expect(userFile.content).toContain('data class User');

    // EmailChangeConfirmationUser should be the typealias
    const aliasFile = files.find((f) => f.path.includes('/EmailChangeConfirmationUser.kt'))!;
    expect(aliasFile).toBeDefined();
    expect(aliasFile.content).toContain('typealias EmailChangeConfirmationUser = User');
  });
});
