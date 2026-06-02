import { describe, expect, it } from 'vitest';
import type { Model, Service } from '@workos/oagen';
import { runSnippetEmitters } from '../../src/snippets/runner.js';
import { rustSnippetEmitter } from '../../src/snippets/rust.js';
import { makeCtx, makeOp, makeSpec, makeStringField } from './_helpers.js';

function runRust(services: Service[], models: Model[] = []): string {
  const results = runSnippetEmitters([rustSnippetEmitter], makeCtx(makeSpec(services, models)));
  return results[0]!.content;
}

describe('snippets/rust', () => {
  it('renders a #[tokio::main] async main returning workos::Error', () => {
    const content = runRust([{ name: 'Organizations', operations: [makeOp({ name: 'list_organizations' })] }]);
    expect(content).toContain('use workos::Client;');
    expect(content).toContain('#[tokio::main]');
    expect(content).toContain('async fn main() -> Result<(), workos::Error> {');
    expect(content).toContain('.api_key("sk_example_123456789")');
    expect(content).toContain('.client_id("client_123456789")');
    expect(content).toContain('.organizations()');
    expect(content).toContain('.list_organizations()');
    expect(content).toContain('.await?;');
  });

  it('uses a typed Params struct with .into() for String body fields', () => {
    const content = runRust(
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
          fields: [makeStringField('name', 'Foo Corp')],
        },
      ],
    );
    expect(content).toContain('use workos::organizations::CreateOrganizationParams;');
    expect(content).toContain('CreateOrganizationParams {');
    expect(content).toContain('name: "Foo Corp".into(),');
    expect(content).toContain('..Default::default()');
  });

  it('renders required path params as positional &str arguments', () => {
    const content = runRust([
      {
        name: 'Organizations',
        operations: [
          makeOp({
            name: 'get_organization',
            httpMethod: 'get',
            path: '/organizations/{id}',
            pathParams: [
              {
                name: 'id',
                type: { kind: 'primitive', type: 'string' },
                required: true,
                example: 'org_123',
              },
            ],
          }),
        ],
      },
    ]);
    expect(content).toContain('.get_organization("org_123")');
  });
});
