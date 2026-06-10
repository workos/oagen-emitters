import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Model } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateModels, generateSerializers } from '../../src/node/models.js';
import { nodeEmitter } from '../../src/node/index.js';
import { buildLiveSurface, emptyLiveSurface, setActiveLiveSurface } from '../../src/node/live-surface.js';
import { setBaselineInterfaceNames, setBaselineSerializedNames } from '../../src/node/naming.js';
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

  it('re-derives enum-typed fields instead of copying a degraded baseline `any`', () => {
    // Regression: a prior generation referenced inline-enum names before the
    // enum files existed, so api-surface extraction typed the fields as `any`.
    // On the next regen the baseline `any` must not shadow the enum name the
    // emitter knows from the IR — otherwise `state: any` persists forever.
    const models: Model[] = [
      {
        name: 'OrganizationDomain',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          {
            name: 'state',
            type: { kind: 'enum', name: 'OrganizationDomainState', values: ['pending', 'verified'] },
            required: true,
          },
          {
            name: 'verification_strategy',
            type: { kind: 'enum', name: 'OrganizationDomainVerificationStrategy', values: ['dns', 'manual'] },
            required: true,
          },
        ],
      },
    ];

    const spec: ApiSpec = {
      ...makeSpec(models, [
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
      ]),
      enums: [
        {
          name: 'OrganizationDomainState',
          values: [
            { name: 'PENDING', value: 'pending' },
            { name: 'VERIFIED', value: 'verified' },
          ],
        },
        {
          name: 'OrganizationDomainVerificationStrategy',
          values: [
            { name: 'DNS', value: 'dns' },
            { name: 'MANUAL', value: 'manual' },
          ],
        },
      ],
    };

    const ctxWithModels: EmitterContext = {
      ...ctx,
      spec,
      emitterOptions: { ownedServices: ['OrganizationDomains'] },
      apiSurface: {
        language: 'node',
        extractedFrom: '/tmp/sdk',
        extractedAt: '2026-06-09T00:00:00Z',
        classes: {},
        interfaces: {
          OrganizationDomain: {
            name: 'OrganizationDomain',
            fields: {
              id: { type: 'string', optional: false },
              state: { type: 'any', optional: false },
              verificationStrategy: { type: 'any', optional: false },
            },
            extends: [],
            sourceFile: 'src/organization-domains/interfaces/organization-domain.interface.ts',
          },
          OrganizationDomainResponse: {
            name: 'OrganizationDomainResponse',
            fields: {
              id: { type: 'string', optional: false },
              state: { type: 'any', optional: false },
              verification_strategy: { type: 'any', optional: false },
            },
            extends: [],
            sourceFile: 'src/organization-domains/interfaces/organization-domain.interface.ts',
          },
        },
        typeAliases: {},
        enums: {},
        exports: {},
      } as any,
    } as EmitterContext;

    const result = generateModels(models, ctxWithModels);
    const file = result.find((f) => f.path.endsWith('organization-domain.interface.ts'));
    expect(file).toBeDefined();

    // Domain interface re-derives the enum names from the IR.
    expect(file!.content).toContain('state: OrganizationDomainState;');
    expect(file!.content).toContain('verificationStrategy: OrganizationDomainVerificationStrategy;');
    expect(file!.content).not.toContain(': any;');

    // Wire interface too.
    expect(file!.content).toContain('state: OrganizationDomainState;');
    expect(file!.content).toContain('verification_strategy: OrganizationDomainVerificationStrategy;');

    // And the imports are planned so the references resolve.
    expect(file!.content).toContain(
      "import type { OrganizationDomainState } from './organization-domain-state.interface';",
    );
    expect(file!.content).toContain(
      "import type { OrganizationDomainVerificationStrategy } from './organization-domain-verification-strategy.interface';",
    );
  });

  it('plans enum imports against the live-surface declaration path when it differs from the canonical one', () => {
    // `generateEnums` skips emitting an enum whose declaration already lives
    // elsewhere in the SDK (e.g. hand-written under src/common/interfaces).
    // The interface emitter must point its import at that same location, not
    // at the canonical per-service path that will never be emitted.
    const surface = emptyLiveSurface();
    surface.interfaces.set('OrganizationDomainState', {
      filePath: 'src/common/interfaces/organization-domain-state.interface.ts',
      fields: new Set(),
    });
    setActiveLiveSurface(surface);
    try {
      const models: Model[] = [
        {
          name: 'OrganizationDomain',
          fields: [
            { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
            {
              name: 'state',
              type: { kind: 'enum', name: 'OrganizationDomainState', values: ['pending', 'verified'] },
              required: true,
            },
          ],
        },
      ];
      const spec: ApiSpec = {
        ...makeSpec(models, [
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
        ]),
        enums: [
          {
            name: 'OrganizationDomainState',
            values: [
              { name: 'PENDING', value: 'pending' },
              { name: 'VERIFIED', value: 'verified' },
            ],
          },
        ],
      };
      const ctxWithModels: EmitterContext = { ...ctx, spec };
      const result = generateModels(models, ctxWithModels);
      const file = result.find((f) => f.path.endsWith('organization-domain.interface.ts'));
      expect(file?.content).toContain(
        "import type { OrganizationDomainState } from '../../common/interfaces/organization-domain-state.interface';",
      );
    } finally {
      setActiveLiveSurface(emptyLiveSurface());
    }
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

  it('keeps spec model names for manifest-managed adopted services on rerun', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'node-adopted-model-rerun-'));
    try {
      fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmpRoot, 'src', 'workos.ts'), '// @oagen-ignore-file\nexport class WorkOS {}\n');
      fs.writeFileSync(path.join(tmpRoot, 'src', 'index.ts'), '// @oagen-ignore-file\n');
      fs.mkdirSync(path.join(tmpRoot, 'src', 'connect'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, 'src', 'connect', 'connect.ts'),
        ['// This file is auto-generated by oagen. Do not edit.', '', 'export class Connect {}'].join('\n'),
      );
      execFileSync('git', ['init'], { cwd: tmpRoot, stdio: 'ignore' });
      execFileSync('git', ['add', 'src/workos.ts', 'src/index.ts'], { cwd: tmpRoot, stdio: 'ignore' });

      const models: Model[] = [
        {
          name: 'CreateM2MApplication',
          fields: [
            { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
            { name: 'application_type', type: { kind: 'literal', value: 'm2m' }, required: true },
          ],
        },
      ];
      const spec = makeSpec(models, [
        {
          name: 'Connect',
          operations: [
            {
              name: 'createApplication',
              httpMethod: 'post',
              path: '/connect/applications',
              pathParams: [],
              queryParams: [],
              headerParams: [],
              requestBody: { kind: 'model', name: 'CreateM2MApplication' },
              response: { kind: 'primitive', type: 'unknown' },
              errors: [],
              injectIdempotencyKey: false,
            },
          ],
        },
      ]);

      const result = nodeEmitter.generateModels(models, {
        ...ctx,
        spec,
        outputDir: tmpRoot,
        emitterOptions: { adoptMissingServices: true },
        priorTargetManifestPaths: new Set(['src/connect/connect.ts']),
        apiSurface: {
          language: 'node',
          extractedFrom: tmpRoot,
          extractedAt: '2026-05-12T00:00:00Z',
          classes: {},
          interfaces: {
            CreateGroupOptions: {
              name: 'CreateGroupOptions',
              fields: { name: { type: 'string', optional: false } },
              extends: [],
              sourceFile: 'src/groups/interfaces/create-group-options.interface.ts',
            },
          },
          typeAliases: {},
          enums: {},
          exports: {},
        } as any,
        overlayLookup: {
          methodByOperation: new Map(),
          interfaceByName: new Map(),
          modelNameByIR: new Map([['CreateM2MApplication', 'CreateGroupOptions']]),
        } as any,
      } as EmitterContext);

      const file = result.find((f) => f.path === 'src/connect/interfaces/create-m2m-application.interface.ts');
      expect(file?.content).toContain('export interface CreateM2MApplication');
      expect(file?.content).not.toContain('CreateGroupOptions');
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

  it('skips parent serialization when a structurally matched baseline dependency has no serializer', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'node-serializer-baseline-'));
    try {
      fs.mkdirSync(path.join(tmpRoot, 'src', 'api-keys', 'interfaces'), { recursive: true });
      fs.mkdirSync(path.join(tmpRoot, 'src', 'api-keys', 'serializers'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, 'src', 'api-keys', 'interfaces', 'created-api-key.interface.ts'),
        [
          'export interface CreatedApiKey {',
          '  id: string;',
          '}',
          '',
          'export interface SerializedCreatedApiKey {',
          '  id: string;',
          '}',
        ].join('\n'),
      );
      fs.writeFileSync(
        path.join(tmpRoot, 'src', 'api-keys', 'serializers', 'created-api-key.serializer.ts'),
        [
          "import type { CreatedApiKey, SerializedCreatedApiKey } from '../interfaces/created-api-key.interface';",
          'export function deserializeCreatedApiKey(apiKey: SerializedCreatedApiKey): CreatedApiKey {',
          '  return { id: apiKey.id };',
          '}',
        ].join('\n'),
      );

      setActiveLiveSurface(buildLiveSurface(tmpRoot));
      setBaselineSerializedNames(new Set(['SerializedCreatedApiKey']));
      setBaselineInterfaceNames(new Set(['CreatedApiKey', 'SerializedCreatedApiKey']));

      const models: Model[] = [
        {
          name: 'OrganizationApiKey',
          fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
        },
        {
          name: 'OrganizationApiKeyList',
          fields: [
            { name: 'object', type: { kind: 'literal', value: 'list' }, required: true },
            {
              name: 'data',
              type: { kind: 'array', items: { kind: 'model', name: 'OrganizationApiKey' } },
              required: true,
            },
          ],
        },
      ];
      const spec = makeSpec(models, [
        {
          name: 'ApiKeys',
          operations: [
            {
              name: 'listOrganizationApiKeys',
              httpMethod: 'get',
              path: '/api_keys',
              pathParams: [],
              queryParams: [],
              headerParams: [],
              response: { kind: 'model', name: 'OrganizationApiKeyList' },
              errors: [],
              injectIdempotencyKey: false,
            },
          ],
        },
      ]);
      const result = generateSerializers(models, {
        ...ctx,
        spec,
        outputDir: tmpRoot,
        apiSurface: {
          language: 'node',
          extractedFrom: tmpRoot,
          extractedAt: '2026-05-12T00:00:00Z',
          classes: {},
          interfaces: {
            CreatedApiKey: {
              name: 'CreatedApiKey',
              fields: { id: { type: 'string', optional: false } },
              extends: [],
              sourceFile: 'src/api-keys/interfaces/created-api-key.interface.ts',
            },
            SerializedCreatedApiKey: {
              name: 'SerializedCreatedApiKey',
              fields: { id: { type: 'string', optional: false } },
              extends: [],
              sourceFile: 'src/api-keys/interfaces/created-api-key.interface.ts',
            },
          },
          typeAliases: {},
          enums: {},
          exports: {},
        } as any,
        overlayLookup: {
          methodByOperation: new Map(),
          interfaceByName: new Map(),
          modelNameByIR: new Map([['OrganizationApiKey', 'SerializedCreatedApiKey']]),
        } as any,
      });

      const listSerializer = result.find((f) => f.path.endsWith('organization-api-key-list.serializer.ts'));
      expect(listSerializer?.content).toContain('deserializeOrganizationApiKeyList');
      expect(listSerializer?.content).not.toContain('export const serializeOrganizationApiKeyList');
    } finally {
      setActiveLiveSurface(emptyLiveSurface());
      setBaselineSerializedNames(new Set());
      setBaselineInterfaceNames(new Set());
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('emits a serializers/index.ts barrel listing every emitted serializer', () => {
    const models: Model[] = [
      {
        name: 'Organization',
        fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
      {
        name: 'OrganizationMember',
        fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ];

    const spec = makeSpec(models);
    const ctxWithModels: EmitterContext = { ...ctx, spec };
    const result = generateSerializers(models, ctxWithModels);

    const serializerFiles = result.filter((f) => f.path.endsWith('.serializer.ts'));
    expect(serializerFiles.length).toBeGreaterThan(0);

    // Every emitted serializer file should appear in a barrel at the same
    // directory's `serializers/index.ts`.
    for (const sf of serializerFiles) {
      const match = sf.path.match(/^src\/([^/]+)\/serializers\/(.+)\.serializer\.ts$/);
      expect(match).not.toBeNull();
      const [, dir, stem] = match!;
      const barrel = result.find((f) => f.path === `src/${dir}/serializers/index.ts`);
      expect(barrel, `expected barrel for ${dir}`).toBeDefined();
      expect(barrel!.content).toContain(`export * from './${stem}.serializer';`);
      expect(barrel!.overwriteExisting).toBe(true);
    }
  });

  it('omits deserialize half for request-body-only models', () => {
    // `CreateOrganization` is sent as a POST body but the operation responds
    // with a separate `Organization` model. The deserializer for the request
    // model would be dead code AND would silently misbehave if called (the
    // response wire shape doesn't match), so it shouldn't be emitted.
    const models: Model[] = [
      {
        name: 'Organization',
        fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
      {
        name: 'CreateOrganization',
        fields: [{ name: 'name', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ];

    const spec: ApiSpec = {
      ...emptySpec,
      models,
      services: [
        {
          name: 'Organizations',
          operations: [
            {
              name: 'createOrganization',
              httpMethod: 'post',
              path: '/organizations',
              pathParams: [],
              queryParams: [],
              headerParams: [],
              response: { kind: 'model', name: 'Organization' },
              requestBody: { kind: 'model', name: 'CreateOrganization' },
              errors: [],
              injectIdempotencyKey: false,
            },
          ],
        },
      ],
    };

    const ctxWithModels: EmitterContext = { ...ctx, spec };
    const result = generateSerializers(models, ctxWithModels);

    const createSerializer = result.find((f) => f.path.endsWith('create-organization.serializer.ts'));
    expect(createSerializer).toBeDefined();
    expect(createSerializer!.content).toContain('export const serializeCreateOrganization');
    expect(createSerializer!.content).not.toContain('export const deserializeCreateOrganization');

    // Response-side model still gets both halves.
    const orgSerializer = result.find(
      (f) => f.path.endsWith('organization.serializer.ts') && !f.path.includes('create'),
    );
    expect(orgSerializer).toBeDefined();
    expect(orgSerializer!.content).toContain('export const deserializeOrganization');
  });
});
