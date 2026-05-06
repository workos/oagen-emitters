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

  it('preserves DTO model names when emitting distinct types', () => {
    const models: Model[] = [
      {
        name: 'RedirectUriDto',
        fields: [{ name: 'uri', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ];
    const files = generateModels(models, ctx);
    const content = files[0].content;
    expect(content).toContain('type RedirectURIDto struct {');
    expect(content).toContain('URI string `json:"uri"`');
  });

  it('emits Deprecated comments for deprecated fields', () => {
    const models: Model[] = [
      {
        name: 'Widget',
        fields: [
          {
            name: 'old_name',
            type: { kind: 'primitive', type: 'string' },
            required: false,
            description: 'The original name.',
            deprecated: true,
          },
          {
            name: 'legacy_id',
            type: { kind: 'primitive', type: 'string' },
            required: false,
            deprecated: true,
          },
          {
            name: 'current_name',
            type: { kind: 'primitive', type: 'string' },
            required: true,
          },
        ],
      },
    ];
    const files = generateModels(models, ctx);
    const content = files[0].content;
    // deprecated field WITH description gets separator + Deprecated
    expect(content).toContain('\t// OldName is the original name.\n\t//\n\t// Deprecated: this field is deprecated.');
    // deprecated field WITHOUT description gets Deprecated only (no separator)
    expect(content).toContain('\t// Deprecated: this field is deprecated.\n\tLegacyID');
    // non-deprecated field does NOT get Deprecated
    expect(content).not.toMatch(/Deprecated.*\n\tCurrentName/);
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

      // PaginationParams contains common pagination parameters for list operations.
      type PaginationParams struct {
      	// Before is a cursor for reverse pagination.
      	Before *string \`url:"before,omitempty" json:"-"\`
      	// After is a cursor for forward pagination.
      	After *string \`url:"after,omitempty" json:"-"\`
      	// Limit is the maximum number of items to return per page.
      	Limit *int \`url:"limit,omitempty" json:"-"\`
      	// Order is the sort order for results.
      	Order *string \`url:"order,omitempty" json:"-"\`
      }
      "
    `);
  });

  it('types PaginationParams.Order with the spec enum when every list op shares the same enum', () => {
    const specWithSharedEnum: ApiSpec = {
      ...emptySpec,
      enums: [
        {
          name: 'PaginationOrder',
          values: [
            { name: 'normal', value: 'normal' },
            { name: 'desc', value: 'desc' },
            { name: 'asc', value: 'asc' },
          ],
        },
      ],
      services: [
        {
          name: 'Connections',
          operations: [
            {
              name: 'listConnections',
              httpMethod: 'get',
              path: '/connections',
              pathParams: [],
              queryParams: [
                { name: 'after', type: { kind: 'primitive', type: 'string' }, required: false },
                { name: 'limit', type: { kind: 'primitive', type: 'integer' }, required: false },
                { name: 'order', type: { kind: 'enum', name: 'PaginationOrder' }, required: false },
              ],
              headerParams: [],
              response: { kind: 'array', items: { kind: 'model', name: 'Organization' } },
              errors: [],
              pagination: {
                strategy: 'cursor',
                param: 'after',
                dataPath: 'data',
                itemType: { kind: 'model', name: 'Organization' },
              },
              injectIdempotencyKey: false,
            },
          ],
        },
      ],
    };
    const ctxTyped: EmitterContext = { namespace: 'workos', namespacePascal: 'WorkOS', spec: specWithSharedEnum };
    const models: Model[] = [
      {
        name: 'Organization',
        fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ];
    const content = generateModels(models, ctxTyped)[0].content;
    expect(content).toContain('Order *PaginationOrder `url:"order,omitempty" json:"-"`');
    expect(content).not.toContain('Order *string `url:"order,omitempty"');
  });

  it('falls back to *string when not every list op uses the same Order enum', () => {
    const specMixed: ApiSpec = {
      ...emptySpec,
      services: [
        {
          name: 'Connections',
          operations: [
            {
              name: 'listConnections',
              httpMethod: 'get',
              path: '/connections',
              pathParams: [],
              queryParams: [
                { name: 'after', type: { kind: 'primitive', type: 'string' }, required: false },
                { name: 'limit', type: { kind: 'primitive', type: 'integer' }, required: false },
                { name: 'order', type: { kind: 'enum', name: 'PaginationOrder' }, required: false },
              ],
              headerParams: [],
              response: { kind: 'array', items: { kind: 'model', name: 'Organization' } },
              errors: [],
              pagination: {
                strategy: 'cursor',
                param: 'after',
                dataPath: 'data',
                itemType: { kind: 'model', name: 'Organization' },
              },
              injectIdempotencyKey: false,
            },
            {
              name: 'listOrganizations',
              httpMethod: 'get',
              path: '/organizations',
              pathParams: [],
              queryParams: [
                { name: 'after', type: { kind: 'primitive', type: 'string' }, required: false },
                { name: 'limit', type: { kind: 'primitive', type: 'integer' }, required: false },
                { name: 'order', type: { kind: 'primitive', type: 'string' }, required: false },
              ],
              headerParams: [],
              response: { kind: 'array', items: { kind: 'model', name: 'Organization' } },
              errors: [],
              pagination: {
                strategy: 'cursor',
                param: 'after',
                dataPath: 'data',
                itemType: { kind: 'model', name: 'Organization' },
              },
              injectIdempotencyKey: false,
            },
          ],
        },
      ],
    };
    const ctxMixed: EmitterContext = { namespace: 'workos', namespacePascal: 'WorkOS', spec: specMixed };
    const models: Model[] = [
      { name: 'Organization', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
    ];
    const content = generateModels(models, ctxMixed)[0].content;
    expect(content).toContain('Order *string `url:"order,omitempty" json:"-"`');
  });
});
