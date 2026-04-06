import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Model } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateModels } from '../../src/go/models.js';

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

describe('go/models', () => {
  it('returns empty for no models', () => {
    expect(generateModels([], ctx)).toEqual([]);
  });

  it('generates a struct with required and optional fields', () => {
    const models: Model[] = [
      {
        name: 'Organization',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
          {
            name: 'metadata',
            type: { kind: 'map', valueType: { kind: 'primitive', type: 'string' } },
            required: false,
          },
        ],
      },
    ];
    const files = generateModels(models, ctx);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('models.go');
    const content = files[0].content;
    expect(content).toContain('package workos');
    expect(content).toContain('type Organization struct {');
    expect(content).toContain('ID string `json:"id"`');
    expect(content).toContain('Name string `json:"name"`');
    expect(content).toContain('Metadata map[string]string `json:"metadata,omitempty"`');
  });

  it('handles model refs as pointer types', () => {
    const models: Model[] = [
      {
        name: 'User',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'profile', type: { kind: 'model', name: 'Profile' }, required: true },
        ],
      },
      {
        name: 'Profile',
        fields: [{ name: 'bio', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ];
    const files = generateModels(models, ctx);
    const content = files[0].content;
    expect(content).toContain('Profile *Profile `json:"profile"`');
  });

  it('handles nullable fields as pointers', () => {
    const models: Model[] = [
      {
        name: 'Item',
        fields: [
          {
            name: 'description',
            type: { kind: 'nullable', inner: { kind: 'primitive', type: 'string' } },
            required: false,
          },
        ],
      },
    ];
    const files = generateModels(models, ctx);
    const content = files[0].content;
    expect(content).toContain('Description *string');
  });

  it('skips list wrapper models', () => {
    const models: Model[] = [
      {
        name: 'OrganizationList',
        fields: [
          {
            name: 'data',
            type: {
              kind: 'array',
              items: { kind: 'model', name: 'Organization' },
            },
            required: true,
          },
          {
            name: 'list_metadata',
            type: { kind: 'model', name: 'ListMetadata' },
            required: true,
          },
        ],
      },
    ];
    const files = generateModels(models, ctx);
    const content = files[0].content;
    expect(content).not.toContain('OrganizationList');
  });

  it('deduplicates structurally identical models', () => {
    const models: Model[] = [
      {
        name: 'Alpha',
        fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
      {
        name: 'Beta',
        fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ];
    const files = generateModels(models, ctx);
    const content = files[0].content;
    expect(content).toContain('type Alpha struct {');
    expect(content).toContain('type Beta = Alpha');
  });

  it('uses Go acronym conventions for field names', () => {
    const models: Model[] = [
      {
        name: 'Connection',
        fields: [
          { name: 'connection_id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'sso_url', type: { kind: 'primitive', type: 'string' }, required: false },
        ],
      },
    ];
    const files = generateModels(models, ctx);
    const content = files[0].content;
    expect(content).toContain('ConnectionID string');
    expect(content).toContain('SSOURL *string');
  });

  it('generates array fields', () => {
    const models: Model[] = [
      {
        name: 'Org',
        fields: [
          {
            name: 'domains',
            type: { kind: 'array', items: { kind: 'primitive', type: 'string' } },
            required: true,
          },
        ],
      },
    ];
    const files = generateModels(models, ctx);
    const content = files[0].content;
    expect(content).toContain('Domains []string `json:"domains"`');
  });

  it('generates enum field references', () => {
    const models: Model[] = [
      {
        name: 'Connection',
        fields: [{ name: 'status', type: { kind: 'enum', name: 'ConnectionStatus' }, required: true }],
      },
    ];
    const files = generateModels(models, ctx);
    const content = files[0].content;
    expect(content).toContain('Status ConnectionStatus `json:"status"`');
  });

  it('snapshot: Organization struct', () => {
    const models: Model[] = [
      {
        name: 'Organization',
        description: 'Represents an organization.',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'created_at', type: { kind: 'primitive', type: 'string', format: 'date-time' }, required: true },
        ],
      },
    ];
    const files = generateModels(models, ctx);
    expect(files[0].content).toMatchInlineSnapshot(`
      "package workos

      // Organization represents an organization.
      type Organization struct {
      	ID string \`json:"id"\`
      	Name string \`json:"name"\`
      	CreatedAt string \`json:"created_at"\`
      }
      "
    `);
  });
});
