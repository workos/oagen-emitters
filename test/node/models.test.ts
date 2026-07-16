import { describe, it, expect, vi } from 'vitest';
import type { EmitterContext, ApiSpec, Model, GeneratedFile } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateModels, generateSerializers } from '../../src/node/models.js';
import { nodeEmitter, enforceEmittedImportInvariant } from '../../src/node/index.js';
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

  it('does not preserve an owned-service enum inline next to its canonical import', () => {
    // Companion to the owned-service enum emission fix (see enums.test.ts):
    // once `generateEnums` emits the canonical module and this file imports
    // the name, the targetDir preservation pass must not also copy the
    // legacy inline declaration forward — `import type { X }` plus a local
    // `export type X` is a TS2440 collision.
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'node-owned-enum-preserve-'));
    try {
      const ifaceDir = path.join(tmpRoot, 'src', 'organization-domains', 'interfaces');
      fs.mkdirSync(ifaceDir, { recursive: true });
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

      const models: Model[] = [
        {
          name: 'OrganizationDomain',
          fields: [
            { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
            {
              name: 'state',
              type: { kind: 'enum', name: 'OrganizationDomainState', values: ['verified', 'pending'] },
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
              { name: 'VERIFIED', value: 'verified' },
              { name: 'PENDING', value: 'pending' },
            ],
          },
        ],
      };
      const runCtx = {
        ...ctx,
        spec,
        targetDir: tmpRoot,
        emitterOptions: { ownedServices: ['OrganizationDomains'] },
        apiSurface: {
          language: 'node',
          extractedFrom: tmpRoot,
          extractedAt: '2026-06-10T00:00:00Z',
          classes: {},
          interfaces: {
            OrganizationDomain: {
              name: 'OrganizationDomain',
              fields: {
                id: { type: 'string', optional: false },
                state: { type: 'OrganizationDomainState', optional: false },
              },
              extends: [],
              sourceFile: 'src/organization-domains/interfaces/organization-domain.interface.ts',
            },
          },
          typeAliases: {
            OrganizationDomainState: {
              name: 'OrganizationDomainState',
              value: "'verified' | 'pending'",
              sourceFile: 'src/organization-domains/interfaces/organization-domain.interface.ts',
            },
          },
          enums: {},
          exports: {},
        },
      } as unknown as EmitterContext;

      const surface = emptyLiveSurface();
      surface.files.add('src/workos.ts');
      surface.files.add('src/organization-domains/interfaces/organization-domain.interface.ts');
      surface.interfaces.set('OrganizationDomainState', {
        filePath: 'src/organization-domains/interfaces/organization-domain.interface.ts',
        fields: new Set(),
      });
      setActiveLiveSurface(surface);
      try {
        const files = generateModels(models, runCtx);
        const modelFile = files.find((f) => f.path.endsWith('organization-domain.interface.ts'));
        expect(modelFile).toBeDefined();
        expect(modelFile!.content).toContain(
          "import type { OrganizationDomainState } from './organization-domain-state.interface';",
        );
        expect(modelFile!.content).not.toContain("export type OrganizationDomainState = 'verified' | 'pending';");
      } finally {
        setActiveLiveSurface(emptyLiveSurface());
      }
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
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

  // Regression: optional+nullable request-body fields must serialize as a
  // passthrough, never `?? null`. Coercing an omitted field to explicit null
  // turns a partial update like `updateDataIntegration({ enabled: true })` into
  // an unintended clear of `description`/`scopes` (null = reset, per the API's
  // PUT semantics; undefined = no-op). Covers both a brand-new model (no
  // baseline) and a stale baseline that recorded the wire field as required.
  const optionalNullableBodyModels: Model[] = [
    {
      name: 'UpdateDataIntegration',
      fields: [
        {
          name: 'description',
          type: { kind: 'nullable', inner: { kind: 'primitive', type: 'string' } },
          required: false,
        },
        { name: 'enabled', type: { kind: 'primitive', type: 'boolean' }, required: false },
        {
          name: 'scopes',
          type: { kind: 'nullable', inner: { kind: 'array', items: { kind: 'primitive', type: 'string' } } },
          required: false,
        },
      ],
    },
    {
      name: 'DataIntegration',
      fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
    },
  ];

  const optionalNullableBodySpec: ApiSpec = {
    ...emptySpec,
    models: optionalNullableBodyModels,
    services: [
      {
        name: 'Pipes',
        operations: [
          {
            name: 'updateDataIntegration',
            httpMethod: 'put',
            path: '/data-integrations/{slug}',
            pathParams: [{ name: 'slug', type: { kind: 'primitive', type: 'string' }, required: true }],
            queryParams: [],
            headerParams: [],
            requestBody: { kind: 'model', name: 'UpdateDataIntegration' },
            response: { kind: 'model', name: 'DataIntegration' },
            errors: [],
            injectIdempotencyKey: false,
          } as any,
        ],
      },
    ],
  };

  function expectPassthrough(content: string): void {
    expect(content).toContain('description: model.description,');
    expect(content).toContain('scopes: model.scopes,');
    expect(content).not.toContain('description: model.description ?? null');
    expect(content).not.toContain('scopes: model.scopes ?? null');
  }

  it('does not coalesce optional nullable body fields to null (new model, no baseline)', () => {
    const ctxWithModels: EmitterContext = { ...ctx, spec: optionalNullableBodySpec };
    const result = generateSerializers(optionalNullableBodyModels, ctxWithModels);
    const ser = result.find((f) => f.path.includes('update-data-integration.serializer'));
    expect(ser).toBeTruthy();
    expectPassthrough(ser!.content);
  });

  it('does not coalesce optional nullable body fields against a stale required-wire baseline', () => {
    const ctxWithBaseline: EmitterContext = {
      ...ctx,
      spec: optionalNullableBodySpec,
      apiSurface: {
        language: 'node',
        extractedFrom: '',
        extractedAt: '2026-05-12T00:00:00Z',
        classes: {},
        interfaces: {
          // Stale snapshot: wire fields captured as REQUIRED (optional: false),
          // the footprint of an older generation.
          UpdateDataIntegrationResponse: {
            name: 'UpdateDataIntegrationResponse',
            fields: {
              description: { type: 'string | null', optional: false },
              scopes: { type: 'string[] | null', optional: false },
            },
            extends: [],
            sourceFile: 'src/pipes/interfaces/update-data-integration.interface.ts',
          },
        },
        typeAliases: {},
        enums: {},
        exports: {},
      } as any,
    };
    const result = generateSerializers(optionalNullableBodyModels, ctxWithBaseline);
    const ser = result.find((f) => f.path.includes('update-data-integration.serializer'));
    expect(ser).toBeTruthy();
    expectPassthrough(ser!.content);
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

describe('owned-service dependency model emission', () => {
  it('emits dependency models into the owned service directory instead of an unemittable one', () => {
    // Real instance: the AuditLogs ownership pass generated audit-logs.ts
    // importing `../organizations/interfaces/audit-logs-retention.interface`,
    // but the retention models were assigned to the (non-owned) Organizations
    // dir and therefore never emitted — an unresolvable import (TS2307).
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'node-owned-dep-'));
    try {
      fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmpRoot, 'src', 'workos.ts'), 'export class WorkOS {}\n');
      execFileSync('git', ['init'], { cwd: tmpRoot, stdio: 'ignore' });
      execFileSync('git', ['add', 'src'], { cwd: tmpRoot, stdio: 'ignore' });

      const models: Model[] = [
        {
          name: 'AuditLogsRetention',
          fields: [{ name: 'retention_period_in_days', type: { kind: 'primitive', type: 'integer' }, required: true }],
        },
      ];
      const retentionOp = (name: string, opPath: string) => ({
        name,
        httpMethod: 'get' as const,
        path: opPath,
        pathParams: [],
        queryParams: [],
        headerParams: [],
        response: { kind: 'model' as const, name: 'AuditLogsRetention' },
        errors: [],
        injectIdempotencyKey: false,
      });
      const spec = makeSpec(models, [
        { name: 'Organizations', operations: [retentionOp('getRetention', '/organizations/{id}/retention')] },
        { name: 'AuditLogs', operations: [retentionOp('getAuditLogsRetention', '/audit_logs/retention')] },
      ]);

      const files = nodeEmitter.generateModels(models, {
        ...ctx,
        spec,
        outputDir: tmpRoot,
        emitterOptions: { ownedServices: ['AuditLogs'] },
      } as EmitterContext);

      // The dependency model lands in the importing (owned) service's dir…
      expect(files.some((f) => f.path === 'src/audit-logs/interfaces/audit-logs-retention.interface.ts')).toBe(true);
      // …and nothing is planned for the unemittable organizations dir.
      expect(files.some((f) => f.path.startsWith('src/organizations/'))).toBe(false);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('emits interfaces AND serializers for the full closure of ops re-mounted onto an owned service', () => {
    // Real instance (AuditLogs rebuild): GET/PUT
    // /organizations/{organizationId}/audit_logs_retention live on the IR
    // Organizations service but are MOUNTED on AuditLogs via
    // resolvedOperations. Walking only IR services missed them, so
    // `AuditLogsRetention` / `UpdateAuditLogsRetention` stayed assigned to
    // the (non-owned) Organizations dir: their interfaces and serializers
    // were never emitted ANYWHERE, while the generated retention methods
    // referenced `deserializeAuditLogsRetention` /
    // `serializeUpdateAuditLogsRetention` — imports the invariant pass then
    // had to drop, leaving non-compiling method bodies.
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'node-owned-mount-dep-'));
    try {
      fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmpRoot, 'src', 'workos.ts'), 'export class WorkOS {}\n');
      execFileSync('git', ['init'], { cwd: tmpRoot, stdio: 'ignore' });
      execFileSync('git', ['add', 'src'], { cwd: tmpRoot, stdio: 'ignore' });

      const models: Model[] = [
        {
          name: 'AuditLogsRetention',
          fields: [
            { name: 'retention_period_in_days', type: { kind: 'primitive', type: 'integer' }, required: true },
            // Nested dependency: the closure must not stop at the
            // directly-referenced model.
            { name: 'policy', type: { kind: 'model', name: 'RetentionPolicy' }, required: true },
          ],
        },
        {
          name: 'RetentionPolicy',
          fields: [{ name: 'kind', type: { kind: 'primitive', type: 'string' }, required: true }],
        },
        {
          name: 'UpdateAuditLogsRetention',
          fields: [{ name: 'retention_period_in_days', type: { kind: 'primitive', type: 'integer' }, required: true }],
        },
      ];
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
      const orgIdParam = {
        name: 'organizationId',
        type: { kind: 'primitive' as const, type: 'string' as const },
        required: true,
      };
      const getRetentionOp = {
        name: 'getAuditLogsRetention',
        httpMethod: 'get' as const,
        path: '/organizations/{organizationId}/audit_logs_retention',
        pathParams: [orgIdParam],
        queryParams: [],
        headerParams: [],
        response: { kind: 'model' as const, name: 'AuditLogsRetention' },
        errors: [],
        injectIdempotencyKey: false,
      };
      const updateRetentionOp = {
        name: 'updateAuditLogsRetention',
        httpMethod: 'put' as const,
        path: '/organizations/{organizationId}/audit_logs_retention',
        pathParams: [orgIdParam],
        queryParams: [],
        headerParams: [],
        requestBody: { kind: 'model' as const, name: 'UpdateAuditLogsRetention' },
        response: { kind: 'model' as const, name: 'AuditLogsRetention' },
        errors: [],
        injectIdempotencyKey: false,
      };
      const orgService = { name: 'Organizations', operations: [listOrgsOp, getRetentionOp, updateRetentionOp] };
      const spec = { ...emptySpec, models, services: [orgService] };
      const resolved = (operation: unknown, methodName: string, mountOn: string) => ({
        operation,
        service: orgService,
        methodName,
        mountOn,
        defaults: {},
        inferFromClient: [],
        urlBuilder: false,
      });
      const runCtx = {
        ...ctx,
        spec,
        outputDir: tmpRoot,
        emitterOptions: { ownedServices: ['AuditLogs'] },
        resolvedOperations: [
          resolved(listOrgsOp, 'list_organizations', 'Organizations'),
          resolved(getRetentionOp, 'get_audit_logs_retention', 'AuditLogs'),
          resolved(updateRetentionOp, 'update_audit_logs_retention', 'AuditLogs'),
        ],
      } as unknown as EmitterContext;

      const modelFiles = nodeEmitter.generateModels(models, runCtx);
      const paths = modelFiles.map((f) => f.path);

      // Interfaces for M, its nested dependency N, and the request body —
      // all in the owned service's dir.
      expect(paths).toContain('src/audit-logs/interfaces/audit-logs-retention.interface.ts');
      expect(paths).toContain('src/audit-logs/interfaces/retention-policy.interface.ts');
      expect(paths).toContain('src/audit-logs/interfaces/update-audit-logs-retention.interface.ts');
      // …and serializer emission follows the re-homed assignment.
      expect(paths).toContain('src/audit-logs/serializers/audit-logs-retention.serializer.ts');
      expect(paths).toContain('src/audit-logs/serializers/retention-policy.serializer.ts');
      expect(paths).toContain('src/audit-logs/serializers/update-audit-logs-retention.serializer.ts');
      expect(paths.some((p) => p.startsWith('src/organizations/'))).toBe(false);

      // The resource's serializer/interface imports must resolve: run the
      // remaining hooks so the final whole-run import-invariant pass sees
      // everything, and assert it drops nothing.
      const resourceFiles = nodeEmitter.generateResources(spec.services, runCtx);
      const resourceFile = resourceFiles.find((f) => f.path === 'src/audit-logs/audit-logs.ts');
      expect(resourceFile).toBeDefined();
      expect(resourceFile!.content).toContain('deserializeAuditLogsRetention');
      expect(resourceFile!.content).toContain('serializeUpdateAuditLogsRetention');

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        nodeEmitter.generateTests(spec, runCtx);
        const dropped = warnSpy.mock.calls.filter((call) => String(call[0]).includes('dropped unresolvable'));
        expect(dropped).toEqual([]);
      } finally {
        warnSpy.mockRestore();
      }
      const emittedPaths = new Set([...modelFiles, ...resourceFiles].map((f) => f.path));
      const resolvable = (relPath: string) => emittedPaths.has(relPath) || fs.existsSync(path.join(tmpRoot, relPath));
      for (const importMatch of resourceFile!.content.matchAll(/from '(\.[^']+)'/g)) {
        const resolvedPath = path.posix.normalize(path.posix.join('src/audit-logs', importMatch[1]));
        const candidates = [`${resolvedPath}.ts`, `${resolvedPath}/index.ts`];
        expect(
          candidates.some(resolvable),
          `resource import '${importMatch[1]}' resolves to an emitted or on-disk file`,
        ).toBe(true);
      }
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('enforceEmittedImportInvariant', () => {
  it('rewrites serializer imports to the legacy on-disk file exporting the function', () => {
    // Real instance: audit-logs.ts imported the canonical (never-emitted)
    // `./serializers/audit-log-schema-input.serializer` while the function
    // lives in a legacy hand serializer under a different filename.
    const surface = emptyLiveSurface();
    surface.files.add('src/audit-logs/serializers/audit-log-schema.serializer.ts');
    surface.functions.set('serializeAuditLogSchemaInput', 'src/audit-logs/serializers/audit-log-schema.serializer.ts');

    const file: GeneratedFile = {
      path: 'src/audit-logs/audit-logs.ts',
      content: [
        "import { serializeAuditLogSchemaInput } from './serializers/audit-log-schema-input.serializer';",
        '',
        'export class AuditLogs {',
        '  use = serializeAuditLogSchemaInput;',
        '}',
      ].join('\n'),
    };

    const warnings = enforceEmittedImportInvariant([file], new Set([file.path]), surface);
    expect(warnings).toEqual([]);
    expect(file.content).toContain(
      "import { serializeAuditLogSchemaInput } from './serializers/audit-log-schema.serializer';",
    );
    expect(file.content).not.toContain('audit-log-schema-input.serializer');
  });

  it('rewrites barrel re-exports to the on-disk declaration of the symbol', () => {
    // Real instance: admin-portal's interfaces/index.ts exported the
    // module-local `./generate-link-intent.interface`, but the enum lives in
    // src/common/interfaces and the module-local file is never emitted.
    const surface = emptyLiveSurface();
    surface.files.add('src/common/interfaces/generate-link-intent.interface.ts');
    surface.interfaces.set('GenerateLinkIntent', {
      filePath: 'src/common/interfaces/generate-link-intent.interface.ts',
      fields: new Set(),
    });

    const barrel: GeneratedFile = {
      path: 'src/admin-portal/interfaces/index.ts',
      content: "export * from './generate-link-intent.interface';\n",
    };

    const warnings = enforceEmittedImportInvariant([barrel], new Set([barrel.path]), surface);
    expect(warnings).toEqual([]);
    expect(barrel.content).toContain("export * from '../../common/interfaces/generate-link-intent.interface';");
  });

  it('drops barrel exports whose target exists nowhere, with a warning', () => {
    // Real instance: the MultiFactorAuth barrel exported
    // `./authentication-challenge.interface` — never emitted, not on disk.
    const surface = emptyLiveSurface();

    const barrel: GeneratedFile = {
      path: 'src/mfa/interfaces/index.ts',
      content: [
        "export * from './factor.interface';",
        "export * from './authentication-challenge.interface';",
        '',
      ].join('\n'),
    };

    const warnings = enforceEmittedImportInvariant(
      [barrel],
      new Set([barrel.path, 'src/mfa/interfaces/factor.interface.ts']),
      surface,
    );
    expect(barrel.content).toContain("export * from './factor.interface';");
    expect(barrel.content).not.toContain('authentication-challenge');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('authentication-challenge.interface');
  });

  it('leaves imports that resolve to same-run emissions or on-disk files untouched', () => {
    const surface = emptyLiveSurface();
    surface.files.add('src/workos.ts');
    surface.files.add('src/common/interfaces/pagination-options.interface.ts');

    const content = [
      "import type { WorkOS } from '../workos';",
      "import type { PaginationOptions } from '../common/interfaces/pagination-options.interface';",
      "import type { Widget } from './interfaces/widget.interface';",
      '',
      'export class Widgets {}',
    ].join('\n');
    const file: GeneratedFile = { path: 'src/widgets/widgets.ts', content };

    const warnings = enforceEmittedImportInvariant(
      [file],
      new Set([file.path, 'src/widgets/interfaces/widget.interface.ts']),
      surface,
    );
    expect(warnings).toEqual([]);
    expect(file.content).toBe(content);
  });

  it('splits an unresolvable import whose symbols live in different existing files', () => {
    const surface = emptyLiveSurface();
    surface.files.add('src/audit-logs/serializers/audit-log-event.serializer.ts');
    surface.files.add('src/audit-logs/serializers/audit-log-export.serializer.ts');
    surface.functions.set('serializeEvent', 'src/audit-logs/serializers/audit-log-event.serializer.ts');
    surface.functions.set('deserializeExport', 'src/audit-logs/serializers/audit-log-export.serializer.ts');

    const file: GeneratedFile = {
      path: 'src/audit-logs/audit-logs.ts',
      content: [
        "import { serializeEvent, deserializeExport } from './serializers/combined.serializer';",
        '',
        'export const x = [serializeEvent, deserializeExport];',
      ].join('\n'),
    };

    const warnings = enforceEmittedImportInvariant([file], new Set([file.path]), surface);
    expect(warnings).toEqual([]);
    expect(file.content).toContain("import { serializeEvent } from './serializers/audit-log-event.serializer';");
    expect(file.content).toContain("import { deserializeExport } from './serializers/audit-log-export.serializer';");
  });

  it('preserves the relocatable symbols of a clause when only some are missing', () => {
    // A clause mixing a relocatable symbol with a genuinely-missing one must
    // still emit the import for the relocatable symbol; dropping the whole
    // clause would fail the resolvable symbol with TS2305 at its usage site.
    const surface = emptyLiveSurface();
    surface.files.add('src/audit-logs/serializers/audit-log-event.serializer.ts');
    surface.functions.set('serializeEvent', 'src/audit-logs/serializers/audit-log-event.serializer.ts');

    const file: GeneratedFile = {
      path: 'src/audit-logs/audit-logs.ts',
      content: [
        "import { serializeEvent, serializeGhost } from './serializers/combined.serializer';",
        '',
        'export const x = [serializeEvent, serializeGhost];',
      ].join('\n'),
    };

    const warnings = enforceEmittedImportInvariant([file], new Set([file.path]), surface);
    expect(file.content).toContain("import { serializeEvent } from './serializers/audit-log-event.serializer';");
    expect(file.content).not.toContain('combined.serializer');
    // The missing symbol is dropped from the import but left in the body so it
    // fails at its usage site, not as a phantom-module error.
    expect(file.content).not.toMatch(/import[^\n]*serializeGhost/);
    expect(file.content).toContain('export const x = [serializeEvent, serializeGhost];');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('serializeGhost');
  });

  it('runs as a final pass over all files emitted during the run (wired via generateTests)', () => {
    // Stale api-surface scenario: the baseline claims a dependency interface
    // lives at a sourceFile that is not on disk (and is never emitted). The
    // planned import would be unresolvable; the end-of-run pass must repair
    // or drop it — across emitter hooks, since imports are planned in one
    // hook and the dependency may be (not) emitted in another.
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'node-import-invariant-'));
    try {
      fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmpRoot, 'src', 'workos.ts'), 'export class WorkOS {}\n');
      execFileSync('git', ['init'], { cwd: tmpRoot, stdio: 'ignore' });
      execFileSync('git', ['add', 'src'], { cwd: tmpRoot, stdio: 'ignore' });

      const models: Model[] = [
        {
          name: 'Widget',
          fields: [
            { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
            { name: 'part', type: { kind: 'model', name: 'WidgetPart' }, required: false },
          ],
        },
        {
          name: 'WidgetPart',
          fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
        },
      ];
      const spec = makeSpec(models, [
        {
          name: 'Widgets',
          operations: [
            {
              name: 'getWidget',
              httpMethod: 'get',
              path: '/widgets/{id}',
              pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
              queryParams: [],
              headerParams: [],
              response: { kind: 'model', name: 'Widget' },
              errors: [],
              injectIdempotencyKey: false,
            },
          ],
        },
      ]);
      const runCtx = {
        ...ctx,
        spec,
        outputDir: tmpRoot,
        emitterOptions: { ownedServices: ['Widgets'] },
        apiSurface: {
          language: 'node',
          extractedFrom: tmpRoot,
          extractedAt: '2026-06-09T00:00:00Z',
          classes: {},
          interfaces: {
            // Stale: this sourceFile does not exist on disk.
            WidgetPart: {
              name: 'WidgetPart',
              fields: { id: { type: 'string', optional: false } },
              extends: [],
              sourceFile: 'src/parts/interfaces/widget-part.interface.ts',
            },
          },
          typeAliases: {},
          enums: {},
          exports: {},
        } as any,
      } as EmitterContext;

      const modelFiles = nodeEmitter.generateModels(models, runCtx);
      const widgetFile = modelFiles.find((f) => f.path === 'src/widgets/interfaces/widget.interface.ts');
      expect(widgetFile).toBeDefined();
      // Import planned against the stale baseline path…
      expect(widgetFile!.content).toContain('../../parts/interfaces/widget-part.interface');

      nodeEmitter.generateTests(spec, runCtx);

      // …must not survive the end-of-run invariant pass.
      expect(widgetFile!.content).not.toContain('../../parts/interfaces/widget-part.interface');
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
