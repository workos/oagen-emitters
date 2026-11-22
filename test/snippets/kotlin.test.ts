import { describe, expect, it } from 'vitest';
import type { EmitterContext, Enum, Model, Service } from '@workos/oagen';
import { runSnippetEmitters } from '@workos/oagen';
import { kotlinSnippetEmitter } from '../../src/snippets/kotlin.js';
import { makeCtx, makeOp, makeSpec, makeStringField } from './_helpers.js';

function makeKotlinCtx(services: Service[], models: Model[] = [], enums: Enum[] = []): EmitterContext {
  const spec = makeSpec(services, models);
  spec.enums = enums;
  return makeCtx(spec);
}

function render(ctx: EmitterContext): string {
  return runSnippetEmitters([kotlinSnippetEmitter], ctx)[0]!.content;
}

const createOrganization: Service = {
  name: 'Organizations',
  operations: [
    makeOp({
      name: 'create_organization',
      httpMethod: 'post',
      path: '/organizations',
      requestBody: { kind: 'model', name: 'CreateOrgReq' },
    }),
  ],
};

const createOrgReq: Model = {
  name: 'CreateOrgReq',
  fields: [makeStringField('name', 'Foo Corp'), makeStringField('external_id', 'ext_123', false)],
};

/** A Kotlin API surface whose `Organizations.create` takes `params` in order. */
function surface(
  language: string,
  params: { name: string; optional: boolean }[],
): NonNullable<EmitterContext['apiSurface']> {
  return {
    language,
    extractedFrom: 'test',
    extractedAt: '',
    classes: {
      Organizations: {
        name: 'Organizations',
        methods: {
          create: [{ name: 'create', params: params.map((p) => ({ ...p, type: '' })), returnType: '', async: false }],
        },
        properties: {},
        constructorParams: [],
      },
    },
    interfaces: {},
    typeAliases: {},
    enums: {},
    exports: {},
  };
}

describe('snippets/kotlin (Java-syntax output)', () => {
  it('emits a .java snippet that reads the service through its Java getter', () => {
    const results = runSnippetEmitters(
      [kotlinSnippetEmitter],
      makeKotlinCtx([{ name: 'Organizations', operations: [makeOp({ name: 'list_organizations' })] }]),
    );
    expect(results[0]!.fileExtension).toBe('java');
    expect(results[0]!.language).toBe('java');
    const content = results[0]!.content;
    expect(content).toContain('import com.workos.WorkOS;');
    expect(content).toContain('WorkOS workos = new WorkOS("sk_example_123456789");');
    // The SDK trims the mount's resource name: `listOrganizations` → `list`.
    expect(content).toContain('workos.getOrganizations().list();');
  });

  it('passes body fields positionally and drops trailing optional slots', () => {
    const content = render(makeKotlinCtx([createOrganization], [createOrgReq]));
    expect(content).toContain('workos.getOrganizations().create("Foo Corp");');
    expect(content).not.toContain('Options');
  });

  it("follows the shipped SDK's parameter order from a Kotlin API surface", () => {
    const ctx = makeKotlinCtx([createOrganization], [createOrgReq]);
    ctx.apiSurface = surface('kotlin', [
      { name: 'externalId', optional: true },
      { name: 'name', optional: false },
      { name: 'requestOptions', optional: true },
    ]);
    expect(render(ctx)).toContain('workos.getOrganizations().create(null, "Foo Corp");');
  });

  it('passes every slot when a required parameter follows requestOptions', () => {
    // `name` is required now but missing from the surface, so the SDK appends
    // it after `requestOptions` and ships the method without @JvmOverloads.
    const ctx = makeKotlinCtx([createOrganization], [createOrgReq]);
    ctx.apiSurface = surface('kotlin', [
      { name: 'externalId', optional: true },
      { name: 'requestOptions', optional: true },
    ]);
    expect(render(ctx)).toContain('workos.getOrganizations().create(null, null, "Foo Corp");');
  });

  it("ignores another language's API surface", () => {
    const ctx = makeKotlinCtx([createOrganization], [createOrgReq]);
    ctx.apiSurface = surface('go', [
      { name: 'externalId', optional: true },
      { name: 'name', optional: false },
    ]);
    expect(render(ctx)).toContain('workos.getOrganizations().create("Foo Corp");');
  });

  it('builds nested models with their constructors and enum values with their members', () => {
    const content = render(
      makeKotlinCtx(
        [
          {
            name: 'Organizations',
            operations: [
              makeOp({
                name: 'create_organization',
                httpMethod: 'post',
                path: '/organizations',
                requestBody: { kind: 'model', name: 'CreateOrgReq' },
              }),
            ],
          },
        ],
        [
          {
            name: 'CreateOrgReq',
            fields: [
              makeStringField('name', 'Foo Corp'),
              { name: 'state', type: { kind: 'enum', name: 'OrgState' }, required: true, example: 'active' },
              { name: 'domain_data', type: { kind: 'model', name: 'DomainData' }, required: true },
            ],
          },
          { name: 'DomainData', fields: [makeStringField('domain', 'foo-corp.com')] },
        ],
        [{ name: 'OrgState', values: [{ name: 'active', value: 'active' }] }],
      ),
    );
    expect(content).toContain('import com.workos.models.DomainData;');
    expect(content).toContain('import com.workos.types.OrgState;');
    expect(content).toContain('OrgState.Active');
    expect(content).toContain('new DomainData("foo-corp.com")');
  });

  it('constructs a fieldless model with its no-argument constructor', () => {
    const content = render(
      makeKotlinCtx(
        [createOrganization],
        [
          {
            name: 'CreateOrgReq',
            fields: [
              makeStringField('name', 'Foo Corp'),
              { name: 'settings', type: { kind: 'model', name: 'OrgSettings' }, required: true },
            ],
          },
          { name: 'OrgSettings', fields: [] },
        ],
      ),
    );
    expect(content).toContain('import com.workos.models.OrgSettings;');
    expect(content).toContain('new OrgSettings()');
    expect(content).not.toContain('Map.of');
  });

  it('passes path parameters before body fields', () => {
    const content = render(
      makeKotlinCtx(
        [
          {
            name: 'Organizations',
            operations: [
              makeOp({
                name: 'update_organization',
                httpMethod: 'put',
                path: '/organizations/{id}',
                pathParams: [
                  { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true, example: 'org_123' },
                ],
                requestBody: { kind: 'model', name: 'UpdateOrgReq' },
              }),
            ],
          },
        ],
        [{ name: 'UpdateOrgReq', fields: [makeStringField('name', 'Foo Corp')] }],
      ),
    );
    expect(content).toContain('workos.getOrganizations().update("org_123", "Foo Corp");');
  });
});
