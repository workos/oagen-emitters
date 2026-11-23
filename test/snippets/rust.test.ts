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

/** An API surface whose `typeName::new` takes `params` (by default `ListThingsParams::new(b, a)`). */
function surface(
  language: string,
  typeName = 'ListThingsParams',
  params = ['b', 'a'],
): NonNullable<EmitterContext['apiSurface']> {
  return {
    language,
    extractedFrom: 'test',
    extractedAt: '',
    classes: {
      [typeName]: {
        name: typeName,
        methods: {
          new: [
            {
              name: 'new',
              params: params.map((name) => ({ name, type: 'String', optional: false })),
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

  it('passes a retained new() argument as its inner type, not Some(...)', () => {
    // `body` is optional now, but the shipped `new(a, body)` still takes it.
    const ctx = makeRustCtx(
      [
        {
          name: 'Organizations',
          operations: [
            makeOp({
              name: 'create_organization',
              httpMethod: 'post',
              path: '/organizations',
              queryParams: [stringParam('a', 'first')],
              requestBody: { kind: 'nullable', inner: { kind: 'model', name: 'CreateOrgReq' } },
            }),
          ],
        },
      ],
      [{ name: 'CreateOrgReq', fields: [makeStringField('name', 'Foo Corp')] }],
    );
    ctx.apiSurface = surface('rust', 'CreateOrganizationParams', ['a', 'body']);
    const content = render(ctx);
    expect(content).toContain('CreateOrganizationParams::new(\n');
    expect(content).toContain('CreateOrgReq {');
    expect(content).not.toContain('Some(');
  });

  it('renders a non-model request body as its own example value', () => {
    const content = render(
      makeRustCtx([
        {
          name: 'Things',
          operations: [
            makeOp({
              name: 'set_tags',
              httpMethod: 'put',
              path: '/things/tags',
              requestBody: { kind: 'array', items: { kind: 'primitive', type: 'string' } },
            }),
          ],
        },
      ]),
    );
    expect(content).toContain('vec!["');
    expect(content).not.toContain('"{}"');
  });

  it('picks the union variant its discriminator names', () => {
    const content = render(
      makeRustCtx(
        [
          {
            name: 'Shapes',
            operations: [
              makeOp({
                name: 'create_shape',
                httpMethod: 'post',
                path: '/shapes',
                requestBody: { kind: 'model', name: 'CreateShape' },
              }),
            ],
          },
        ],
        [
          {
            name: 'CreateShape',
            fields: [
              {
                name: 'shape',
                required: true,
                type: {
                  kind: 'union',
                  variants: [
                    { kind: 'model', name: 'Circle' },
                    { kind: 'model', name: 'Square' },
                  ],
                  discriminator: { property: 'kind', mapping: { circle: 'Circle', square: 'Square' } },
                },
                example: { kind: 'square', side: 2 },
              },
            ],
          },
          { name: 'Circle', fields: [makeStringField('kind', 'circle'), makeStringField('radius', '1')] },
          { name: 'Square', fields: [makeStringField('kind', 'square'), makeStringField('side', '2')] },
        ],
      ),
    );
    expect(content).toContain('Square {');
    expect(content).not.toContain('Circle {');
  });

  it("ignores another language's API surface", () => {
    const ctx = makeRustCtx([listThings]);
    ctx.apiSurface = surface('kotlin');
    expect(render(ctx)).toContain('.list_things(ListThingsParams::new("first", "second"))');
  });
});
