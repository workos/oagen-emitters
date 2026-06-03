import { describe, expect, it } from 'vitest';
import type { Model, Service } from '@workos/oagen';
import { runSnippetEmitters } from '@workos/oagen';
import { pythonSnippetEmitter } from '../../src/snippets/python.js';
import { makeCtx, makeOp, makeSpec, makeStringField } from './_helpers.js';

function runPython(services: Service[], models: Model[] = []): string {
  const results = runSnippetEmitters([pythonSnippetEmitter], makeCtx(makeSpec(services, models)));
  return results[0]!.content;
}

describe('snippets/python', () => {
  it('renders a no-arg call with the WorkOSClient constructor', () => {
    const content = runPython([{ name: 'Organizations', operations: [makeOp({ name: 'list_organizations' })] }]);
    expect(content).toContain('from workos import WorkOSClient');
    expect(content).toContain('client = WorkOSClient(api_key="sk_example_123456789", client_id="client_123456789")');
    expect(content).toContain('client.organizations.list_organizations()');
  });

  it('renames Python builtin path params with a trailing underscore', () => {
    const content = runPython([
      {
        name: 'Organizations',
        operations: [
          makeOp({
            name: 'get_organization',
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
    // Python builtins ('id', 'type') get an underscore via safeParamName,
    // so the snippet exposes `id_=` instead of shadowing the builtin.
    expect(content).toContain('client.organizations.get_organization(id_="org_123")');
  });

  it('expands required body fields as kwargs', () => {
    const content = runPython(
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
            makeStringField('description', undefined, false), // optional
          ],
        },
      ],
    );
    expect(content).toContain('name="Foo Corp"');
    expect(content).not.toContain('description');
  });
});
