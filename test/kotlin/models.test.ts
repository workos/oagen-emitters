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
    expect(content).toContain('@JvmField');
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
