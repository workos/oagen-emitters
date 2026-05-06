import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Model } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateModels, generateSerializers } from '../../src/node/models.js';
import { nodeEmitter } from '../../src/node/index.js';
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

function makeSpec(models: Model[], services?: any[]): ApiSpec {
  return {
    ...emptySpec,
    models,
    services: services ?? [
      {
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
      },
    ],
  };
}

describe('generateModels', () => {
  it('returns empty for no models', () => {
    expect(generateModels([], ctx)).toEqual([]);
  });

  it('generates domain and response interfaces for a model', () => {
    const models: Model[] = [
      {
        name: 'Organization',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'created_at', type: { kind: 'primitive', type: 'string', format: 'date-time' }, required: true },
          {
            name: 'external_id',
            type: { kind: 'nullable', inner: { kind: 'primitive', type: 'string' } },
            required: true,
          },
        ],
      },
    ];

    const spec = makeSpec(models);
    const ctxWithModels: EmitterContext = { ...ctx, spec };
    const result = generateModels(models, ctxWithModels);

    expect(result.length).toBeGreaterThan(0);
    const file = result[0];
    expect(file.path).toBe('src/organizations/interfaces/organization.interface.ts');

    // Domain interface has camelCase fields
    expect(file.content).toContain('export interface Organization {');
    expect(file.content).toContain('id: string;');
    expect(file.content).toContain('name: string;');
    expect(file.content).toContain('createdAt: Date;');
    expect(file.content).toContain('externalId: string | null;');

    // Wire interface has snake_case fields
    expect(file.content).toContain('export interface OrganizationResponse {');
    expect(file.content).toContain('created_at: string;');
    expect(file.content).toContain('external_id: string | null;');
  });

  it('generates imports for referenced models', () => {
    const models: Model[] = [
      {
        name: 'Organization',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'domain', type: { kind: 'model', name: 'OrganizationDomain' }, required: true },
        ],
      },
      {
        name: 'OrganizationDomain',
        fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ];

    const spec = makeSpec(models);
    const ctxWithModels: EmitterContext = { ...ctx, spec };
    const result = generateModels(models, ctxWithModels);

    const orgFile = result.find((f) => f.path.includes('organization.interface.ts'));
    expect(orgFile?.content).toContain(
      "import type { OrganizationDomain, OrganizationDomainResponse } from './organization-domain.interface';",
    );
  });

  it('uses Wire suffix for models already ending in Response', () => {
    const models: Model[] = [
      {
        name: 'PortalSessionsCreateResponse',
        fields: [{ name: 'link', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ];

    const spec = makeSpec(models, [
      {
        name: 'Portal',
        operations: [
          {
            name: 'createSession',
            httpMethod: 'post',
            path: '/portal/sessions',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model', name: 'PortalSessionsCreateResponse' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ]);
    const ctxWithModels: EmitterContext = { ...ctx, spec };
    const result = generateModels(models, ctxWithModels);

    const file = result[0];
    expect(file.content).toContain('export interface PortalSessionsCreateResponseWire {');
  });

  it('renders @deprecated on fields', () => {
    const models: Model[] = [
      {
        name: 'Organization',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'old_field', type: { kind: 'primitive', type: 'string' }, required: false, deprecated: true },
          {
            name: 'legacy',
            type: { kind: 'primitive', type: 'string' },
            required: false,
            deprecated: true,
            description: 'Use external_id instead.',
          },
        ],
      },
    ];

    const spec = makeSpec(models);
    const ctxWithModels: EmitterContext = { ...ctx, spec };
    const result = generateModels(models, ctxWithModels);

    expect(result[0].content).toContain('@deprecated');
    expect(result[0].content).toContain('Use external_id instead.');
  });

  it('skips per-domain ListMetadata models', () => {
    const models: Model[] = [
      {
        name: 'Organization',
        fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
      {
        name: 'OrganizationListMetadata',
        fields: [
          { name: 'before', type: { kind: 'nullable', inner: { kind: 'primitive', type: 'string' } }, required: false },
          { name: 'after', type: { kind: 'nullable', inner: { kind: 'primitive', type: 'string' } }, required: false },
        ],
      },
    ];

    const spec = makeSpec(models);
    const ctxWithModels: EmitterContext = { ...ctx, spec };
    const result = generateModels(models, ctxWithModels);

    expect(result.every((f) => !f.path.includes('list-metadata'))).toBe(true);
  });

  it('handles generic type params', () => {
    const models: Model[] = [
      {
        name: 'DirectoryUser',
        typeParams: [{ name: 'TCustom', default: { kind: 'map', valueType: { kind: 'primitive', type: 'unknown' } } }],
        fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ];

    const spec = makeSpec(models, [
      {
        name: 'DirectorySync',
        operations: [
          {
            name: 'getUser',
            httpMethod: 'get',
            path: '/directory_users/{id}',
            pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model', name: 'DirectoryUser' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ]);
    const ctxWithModels: EmitterContext = { ...ctx, spec };
    const result = generateModels(models, ctxWithModels);

    expect(result[0].content).toContain('export interface DirectoryUser<TCustom = Record<string, any>>');
  });

  it('does not emit brand-new files into an existing git-tracked SDK', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'node-emitter-live-'));
    try {
      const ifaceDir = path.join(tmpRoot, 'src', 'organizations', 'interfaces');
      fs.mkdirSync(ifaceDir, { recursive: true });
      fs.writeFileSync(
        path.join(ifaceDir, 'organization.interface.ts'),
        ['export interface Organization {', '  id: string;', '}'].join('\n'),
      );
      execFileSync('git', ['init'], { cwd: tmpRoot, stdio: 'ignore' });
      execFileSync('git', ['add', 'src'], { cwd: tmpRoot, stdio: 'ignore' });

      const models: Model[] = [
        {
          name: 'Organization',
          fields: [
            { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
            { name: 'domain', type: { kind: 'model', name: 'OrganizationDomain' }, required: false },
          ],
        },
        {
          name: 'OrganizationDomain',
          fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
        },
      ];

      const spec = makeSpec(models);
      const files = nodeEmitter.generateModels(models, { ...ctx, spec, outputDir: tmpRoot });

      expect(files).toHaveLength(0);
      expect(files.some((f) => f.path.includes('organization-domain.interface.ts'))).toBe(false);
      expect(files.some((f) => f.path.includes('/serializers/'))).toBe(false);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('generateSerializers', () => {
  it('generates deserializer with camelCase mapping', () => {
    const models: Model[] = [
      {
        name: 'Organization',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'created_at', type: { kind: 'primitive', type: 'string', format: 'date-time' }, required: true },
        ],
      },
    ];

    const spec = makeSpec(models);
    const ctxWithModels: EmitterContext = { ...ctx, spec };
    const result = generateSerializers(models, ctxWithModels);

    expect(result.length).toBeGreaterThan(0);
    const file = result[0];
    expect(file.path).toContain('.serializer.ts');
    expect(file.content).toContain('deserializeOrganization');
    expect(file.content).toContain('createdAt: new Date(response.created_at)');
  });

  it('generates nested model deserialization', () => {
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
        fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ];

    const spec = makeSpec(models);
    const ctxWithModels: EmitterContext = { ...ctx, spec };
    const result = generateSerializers(models, ctxWithModels);

    const orgSerializer = result.find(
      (f) => f.path.includes('organization.serializer.ts') && !f.path.includes('domain'),
    );
    expect(orgSerializer?.content).toContain('domains: response.domains.map(deserializeOrganizationDomain)');
  });

  it('preserves null fallback for optional nullable model fields', () => {
    const models: Model[] = [
      {
        name: 'Organization',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'parent', type: { kind: 'nullable', inner: { kind: 'model', name: 'ParentOrg' } }, required: false },
        ],
      },
      {
        name: 'ParentOrg',
        fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ];

    const spec = makeSpec(models, [
      {
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
      },
    ]);
    const ctxWithModels: EmitterContext = { ...ctx, spec };
    const result = generateSerializers(models, ctxWithModels);

    const orgSerializer = result.find(
      (f) => f.path.includes('organization.serializer.ts') && !f.path.includes('parent'),
    );
    expect(orgSerializer?.content).toContain(
      'parent: response.parent != null ? deserializeParentOrg(response.parent) : null',
    );
  });
});
