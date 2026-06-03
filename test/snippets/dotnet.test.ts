import { describe, expect, it } from 'vitest';
import type { Model, Service } from '@workos/oagen';
import { runSnippetEmitters } from '@workos/oagen';
import { dotnetSnippetEmitter } from '../../src/snippets/dotnet.js';
import { makeCtx, makeOp, makeSpec, makeStringField } from './_helpers.js';

function runDotnet(services: Service[], models: Model[] = []): string {
  const results = runSnippetEmitters([dotnetSnippetEmitter], makeCtx(makeSpec(services, models)));
  return results[0]!.content;
}

describe('snippets/dotnet', () => {
  it('renders WorkOSClient with WorkOSOptions and an Async-suffixed call', () => {
    const content = runDotnet([{ name: 'Organizations', operations: [makeOp({ name: 'list_organizations' })] }]);
    expect(content).toContain('using WorkOS;');
    expect(content).toContain('var client = new WorkOSClient(new WorkOSOptions');
    expect(content).toContain('ApiKey = "sk_example_123456789"');
    expect(content).toContain('ClientId = "client_123456789"');
    // Mount target `Organizations`; method `list_organizations` → ListAsync.
    expect(content).toContain('await client.Organizations.ListAsync();');
  });

  it('builds the typed Options class for body args', () => {
    const content = runDotnet(
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
    expect(content).toContain('await client.Organizations.CreateAsync(');
    expect(content).toContain('new OrganizationsCreateOptions');
    expect(content).toContain('Name = "Foo Corp",');
  });
});
