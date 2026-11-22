import { describe, expect, it } from 'vitest';
import type { EmitterContext, Enum, Model, Parameter, Service } from '@workos/oagen';
import { runSnippetEmitters } from '@workos/oagen';
import { rustSnippetEmitter } from '../../src/snippets/rust.js';
import { makeCtx, makeOp, makeSpec, makeStringField } from './_helpers.js';

function makeRustCtx(services: Service[], models: Model[] = [], enums: Enum[] = []): EmitterContext {
  const spec = makeSpec(services, models);
  spec.enums = enums;
  return makeCtx(spec);
}

function render(ctx: EmitterContext): string {
  return runSnippetEmitters([rustSnippetEmitter], ctx)[0]!.content;
}

function stringParam(name: string, example: string, required = true): Parameter {
  return { name, type: { kind: 'primitive', type: 'string' }, required, example };
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

/** `GET /things` with two required query params, `a` then `b`. */
const listThings: Service = {
  name: 'Things',
  operations: [
    makeOp({
      name: 'list_things',
      path: '/things',
      queryParams: [stringParam('a', 'first'), stringParam('b', 'second')],
      response: { kind: 'model', name: 'Thing' },
    }),
  ],
};

/** An API surface whose `ListThingsParams::new` takes `b` before `a`. */
function surface(language: string): NonNullable<EmitterContext['apiSurface']> {
  return {
    language,
    extractedFrom: 'test',
    extractedAt: '',
    classes: {
      ListThingsParams: {
        name: 'ListThingsParams',
        methods: {
          new: [
            {
              name: 'new',
              params: [
                { name: 'b', type: 'String', optional: false },
                { name: 'a', type: 'String', optional: false },
              ],
              returnType: 'Self',
              async: false,
            },
          ],
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

describe('snippets/rust', () => {
  it('passes a Default params struct when every field is optional', () => {
    const content = render(
      makeRustCtx([
        {
          name: 'Organizations',
          operations: [
            makeOp({
              name: 'list_organizations',
              queryParams: [stringParam('search', 'Foo', false)],
            }),
          ],
        },
      ]),
    );
    expect(content).toContain('use workos::Client;');
    expect(content).toContain('use workos::organizations::ListOrganizationsParams;');
    expect(content).toContain('#[tokio::main]');
    expect(content).toContain('async fn main() -> Result<(), workos::Error> {');
    expect(content).toContain('let client = Client::new("sk_example_123456789");');
    expect(content).toContain('.list_organizations(ListOrganizationsParams::default())');
  });

  it('takes path parameters as &str and omits an empty params struct', () => {
    const content = render(
      makeRustCtx([
        {
          name: 'Organizations',
          operations: [
            makeOp({
              name: 'get_organization',
              path: '/organizations/{id}',
              pathParams: [stringParam('id', 'org_123')],
            }),
          ],
        },
      ]),
    );
    expect(content).toContain('client.organizations().get_organization("org_123").await?;');
    expect(content).not.toContain('Params');
  });

  it('wraps the body model in the params struct and names every model field', () => {
    const content = render(
      makeRustCtx(
        [createOrganization],
        [
          {
            name: 'CreateOrgReq',
            fields: [makeStringField('name', 'Foo Corp'), makeStringField('external_id', 'ext_123', false)],
          },
        ],
      ),
    );
    expect(content).toContain('use workos::CreateOrgReq;');
    expect(content).toContain('use workos::organizations::CreateOrganizationParams;');
    expect(content).toContain(
      [
        '        .create_organization(CreateOrganizationParams::new(CreateOrgReq {',
        '            name: "Foo Corp".to_string(),',
        '            external_id: None,',
        '        }))',
      ].join('\n'),
    );
  });

  it('renders enum values as variants and nested models as struct literals', () => {
    const content = render(
      makeRustCtx(
        [createOrganization],
        [
          {
            name: 'CreateOrgReq',
            fields: [
              { name: 'state', type: { kind: 'enum', name: 'OrgState' }, required: true, example: 'active' },
              { name: 'domain_data', type: { kind: 'model', name: 'DomainData' }, required: true },
            ],
          },
          { name: 'DomainData', fields: [makeStringField('domain', 'foo-corp.com')] },
        ],
        [{ name: 'OrgState', values: [{ name: 'active', value: 'active' }] }],
      ),
    );
    expect(content).toContain('use workos::{CreateOrgReq, DomainData, OrgState};');
    expect(content).toContain('state: OrgState::Active,');
    expect(content).toContain('domain_data: DomainData {');
    expect(content).toContain('domain: "foo-corp.com".to_string(),');
  });

  it('builds a params struct with required fields through new()', () => {
    const content = render(makeRustCtx([listThings]));
    expect(content).toContain('.list_things(ListThingsParams::new("first", "second"))');
  });

  it('follows the shipped new() argument order from a Rust API surface', () => {
    const ctx = makeRustCtx([listThings]);
    ctx.apiSurface = surface('rust');
    expect(render(ctx)).toContain('.list_things(ListThingsParams::new("second", "first"))');
  });

  it("ignores another language's API surface", () => {
    const ctx = makeRustCtx([listThings]);
    ctx.apiSurface = surface('kotlin');
    expect(render(ctx)).toContain('.list_things(ListThingsParams::new("first", "second"))');
  });
});
