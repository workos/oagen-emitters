import { describe, it, expect } from 'vitest';
import { generateModels } from '../../src/dotnet/models.js';
import { primeEnumAliases } from '../../src/dotnet/enums.js';
import type { EmitterContext, ApiSpec, Model, Service } from '@workos/oagen';
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

describe('dotnet/models', () => {
  it('returns empty for no models', () => {
    expect(generateModels([], ctx)).toEqual([]);
  });

  it('generates a C# class with JSON attributes', () => {
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

    primeEnumAliases([]);
    const files = generateModels(models, {
      ...ctx,
      spec: { ...emptySpec, services: [service], models },
    });

    expect(files.length).toBeGreaterThanOrEqual(1);

    const modelFile = files.find((f) => f.path === 'Entities/Organization.cs')!;
    expect(modelFile).toBeDefined();

    const content = modelFile.content;
    // Namespace
    expect(content).toContain('namespace WorkOS');
    // Class definition
    expect(content).toContain('public class Organization');

    // Required fields — convention-based naming (no per-property JSON attributes)
    expect(content).toContain('public string Id');
    expect(content).toContain('public string Name');
    expect(content).not.toContain('[JsonProperty("id")]');
    expect(content).not.toContain('[STJS.JsonPropertyName(');

    // DateTime field
    expect(content).toContain('DateTimeOffset');

    // Optional/nullable field
    expect(content).toContain('public string? ExternalId');
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

    primeEnumAliases([]);
    const files = generateModels(models, {
      ...ctx,
      spec: { ...emptySpec, models },
    });
    const filePaths = files.map((f) => f.path);

    // Should generate Organization but NOT OrganizationList or ListMetadata
    expect(filePaths.some((p) => p.includes('Organization.cs') && !p.includes('List'))).toBe(true);
    expect(filePaths.some((p) => p.includes('OrganizationList.cs'))).toBe(false);
    expect(filePaths.some((p) => p.includes('ListMetadata.cs'))).toBe(false);
  });

  it('deduplicates structurally identical models', () => {
    const models: Model[] = [
      {
        name: 'OrganizationDomain',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'domain', type: { kind: 'primitive', type: 'string' }, required: true },
        ],
      },
      {
        name: 'OrganizationDomainStandAlone',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'domain', type: { kind: 'primitive', type: 'string' }, required: true },
        ],
      },
    ];

    primeEnumAliases([]);
    const files = generateModels(models, {
      ...ctx,
      spec: { ...emptySpec, models },
    });

    // Canonical model should have a full class
    const canonicalFile = files.find(
      (f) => f.path.includes('OrganizationDomain.cs') && !f.path.includes('StandAlone'),
    )!;
    expect(canonicalFile).toBeDefined();
    expect(canonicalFile.content).toContain('public class OrganizationDomain');

    // Alias model should NOT be emitted — references are rewritten to the canonical
    const aliasFile = files.find((f) => f.path.includes('OrganizationDomainStandAlone.cs'));
    expect(aliasFile).toBeUndefined();
  });

  it('emits [System.Obsolete] for deprecated fields', () => {
    const models: Model[] = [
      {
        name: 'Organization',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          {
            name: 'old_field',
            type: { kind: 'primitive', type: 'string' },
            required: true,
            deprecated: true,
            description: 'Legacy field',
          },
        ],
      },
    ];

    primeEnumAliases([]);
    const files = generateModels(models, {
      ...ctx,
      spec: { ...emptySpec, models },
    });
    const modelFile = files.find((f) => f.path.includes('Organization.cs'))!;

    expect(modelFile.content).toContain('[System.Obsolete');
  });

  it('handles map fields', () => {
    const models: Model[] = [
      {
        name: 'Organization',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          {
            name: 'metadata',
            type: { kind: 'map', valueType: { kind: 'primitive', type: 'string' } },
            required: false,
          },
        ],
      },
    ];

    primeEnumAliases([]);
    const files = generateModels(models, {
      ...ctx,
      spec: { ...emptySpec, models },
    });
    const modelFile = files.find((f) => f.path.includes('Organization.cs'))!;

    expect(modelFile.content).toContain('Dictionary<string,');
  });

  it('handles array fields with model refs', () => {
    const models: Model[] = [
      {
        name: 'Organization',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          {
            name: 'domains',
            type: { kind: 'array', items: { kind: 'model', name: 'OrganizationDomain' } },
            required: true,
          },
        ],
      },
      {
        name: 'OrganizationDomain',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'domain', type: { kind: 'primitive', type: 'string' }, required: true },
        ],
      },
    ];

    primeEnumAliases([]);
    const files = generateModels(models, {
      ...ctx,
      spec: { ...emptySpec, models },
    });
    const orgFile = files.find((f) => f.path.includes('Organization.cs') && !f.path.includes('Domain'))!;
    expect(orgFile).toBeDefined();
    expect(orgFile.content).toContain('List<OrganizationDomain>');
  });

  it('emits internal set on discriminator property of base class', () => {
    const models: Model[] = [
      {
        name: 'EventSchema',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'event', type: { kind: 'primitive', type: 'string' }, required: true },
          {
            name: 'data',
            type: { kind: 'map', valueType: { kind: 'primitive', type: 'unknown' } },
            required: true,
          },
        ],
      },
      {
        name: 'UserCreated',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'event', type: { kind: 'literal', value: 'user.created' }, required: true },
          { name: 'data', type: { kind: 'model', name: 'UserCreatedData' }, required: true },
        ],
      },
      {
        name: 'UserCreatedData',
        fields: [{ name: 'user_id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ];

    primeEnumAliases([]);
    const discCtx = {
      discriminatorBases: new Set(['EventSchema']),
      variantToBase: new Map([['UserCreated', 'EventSchema']]),
      discriminatorProperties: new Map([['EventSchema', 'event']]),
    };
    const files = generateModels(models, { ...ctx, spec: { ...emptySpec, models } }, discCtx);

    const baseFile = files.find((f) => f.path.includes('EventSchema.cs'))!;
    expect(baseFile).toBeDefined();

    // The discriminator property "event" should have internal set
    expect(baseFile.content).toContain('Event { get; internal set; }');
    // Non-discriminator required fields should NOT have internal set
    expect(baseFile.content).toContain('Id { get; set; }');
  });

  it('adds remarks to dictionary accessors on discriminator base class', () => {
    const models: Model[] = [
      {
        name: 'EventSchema',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'event', type: { kind: 'primitive', type: 'string' }, required: true },
          {
            name: 'data',
            type: { kind: 'map', valueType: { kind: 'primitive', type: 'unknown' } },
            required: true,
          },
        ],
      },
    ];

    primeEnumAliases([]);
    const discCtx = {
      discriminatorBases: new Set(['EventSchema']),
      variantToBase: new Map<string, string>(),
      discriminatorProperties: new Map([['EventSchema', 'event']]),
    };
    const files = generateModels(models, { ...ctx, spec: { ...emptySpec, models } }, discCtx);

    const baseFile = files.find((f) => f.path.includes('EventSchema.cs'))!;
    expect(baseFile).toBeDefined();

    // Dictionary accessors on discriminator bases should have a remarks note
    expect(baseFile.content).toContain('/// <remarks>');
    expect(baseFile.content).toContain('forward-compatible');
  });
});
