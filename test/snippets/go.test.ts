import { describe, expect, it } from 'vitest';
import type { Model, Service } from '@workos/oagen';
import { runSnippetEmitters } from '@workos/oagen';
import { goSnippetEmitter } from '../../src/snippets/go.js';
import { makeCtx, makeOp, makeSpec, makeStringField } from './_helpers.js';

function runGo(services: Service[], models: Model[] = []): string {
  const results = runSnippetEmitters([goSnippetEmitter], makeCtx(makeSpec(services, models)));
  return results[0]!.content;
}

describe('snippets/go', () => {
  it('renders a package main with context import and client init', () => {
    const content = runGo([{ name: 'Organizations', operations: [makeOp({ name: 'list_organizations' })] }]);
    expect(content).toContain('package main');
    expect(content).toContain('"context"');
    expect(content).toContain('"github.com/workos/workos-go/v9"');
    expect(content).toContain('client := workos.NewClient("sk_example_123456789")');
  });

  it('trims the mount-target resource from the method name', () => {
    // Mount target is `Organizations`; the resolved method `create_organization`
    // becomes `CreateOrganization` then trims to `Create`.
    const content = runGo(
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
      [{ name: 'CreateOrgReq', fields: [makeStringField('name', 'Foo Corp')] }],
    );
    expect(content).toContain('client.Organizations().Create(');
    expect(content).not.toContain('CreateOrganization(');
  });

  it('renders required body fields inside a typed opts struct', () => {
    const content = runGo(
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
          fields: [makeStringField('name', 'Foo Corp'), makeStringField('description', undefined, false)],
        },
      ],
    );
    expect(content).toContain('&workos.OrganizationsCreateParams{');
    expect(content).toContain('Name: "Foo Corp",');
    expect(content).not.toContain('Description:');
  });

  it('passes required path params positionally before the opts struct', () => {
    const content = runGo([
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
    expect(content).toContain('client.Organizations().Get(context.Background(), "org_123")');
  });
});
