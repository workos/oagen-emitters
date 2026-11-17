import { describe, expect, it } from 'vitest';
import type { Model, Service } from '@workos/oagen';
import { runSnippetEmitters } from '@workos/oagen';
import { pythonSnippetEmitter } from '../../src/snippets/python.js';
import { generateResources } from '../../src/python/resources.js';
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

  it('names builtin path params exactly as the generated SDK method does', () => {
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
    // The generated SDK method is `get_organization(self, id: str, ...)`, so the
    // snippet must pass `id=`; `id_=` raises TypeError against the real SDK.
    expect(content).toContain('client.organizations.get_organization(id="org_123")');
    expect(content).not.toContain('id_=');
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

  it('uses the same path and query keywords as the generated SDK method', () => {
    const str = { kind: 'primitive', type: 'string' } as const;
    const services: Service[] = [
      {
        name: 'Radar',
        operations: [
          makeOp({
            name: 'list_entries',
            path: '/radar/lists/{id}',
            pathParams: [{ name: 'id', type: str, required: true, example: 'list_123' }],
            queryParams: [{ name: 'type', type: str, required: true, example: 'ip_address' }],
          }),
        ],
      },
    ];
    const ctx = makeCtx(makeSpec(services));
    const snippet = runSnippetEmitters([pythonSnippetEmitter], ctx)[0]!.content;
    const sdk = generateResources(services, ctx)
      .map((f) => f.content)
      .join('\n');
    for (const name of ['id', 'type']) {
      // The SDK method declares the param as `        id: str,` (no underscore).
      expect(sdk).toMatch(new RegExp(`^\\s+${name}: `, 'm'));
      expect(sdk).not.toMatch(new RegExp(`^\\s+${name}_: `, 'm'));
      expect(snippet).toContain(`${name}=`);
      expect(snippet).not.toContain(`${name}_=`);
    }
  });
});
