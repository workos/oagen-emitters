import { describe, expect, it } from 'vitest';
import type { Model, Service } from '@workos/oagen';
import { kotlinSnippetEmitter } from '../../src/snippets/kotlin.js';
import { runSnippetEmitters } from '../../src/snippets/runner.js';
import { makeCtx, makeOp, makeSpec, makeStringField } from './_helpers.js';

function runKotlin(services: Service[], models: Model[] = []): string {
  const results = runSnippetEmitters([kotlinSnippetEmitter], makeCtx(makeSpec(services, models)));
  return results[0]!.content;
}

describe('snippets/kotlin (Java-syntax output)', () => {
  it('emits the .java file extension and Java client init', () => {
    const results = runSnippetEmitters(
      [kotlinSnippetEmitter],
      makeCtx(makeSpec([{ name: 'Organizations', operations: [makeOp({ name: 'list_organizations' })] }])),
    );
    expect(results[0]!.fileExtension).toBe('java');
    expect(results[0]!.language).toBe('java');
    expect(results[0]!.content).toContain('import com.workos.WorkOS;');
    expect(results[0]!.content).toContain('WorkOS workos = new WorkOS("sk_example_123456789");');
    expect(results[0]!.content).toContain('workos.organizations.listOrganizations();');
  });

  it('builds the typed Options class via builder() for body args', () => {
    const content = runKotlin(
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
    expect(content).toContain('import com.workos.organizations.OrganizationsApi.CreateOrganizationOptions;');
    expect(content).toContain('CreateOrganizationOptions options = CreateOrganizationOptions.builder()');
    expect(content).toContain('.name("Foo Corp")');
    expect(content).toContain('.build();');
    expect(content).toContain('workos.organizations.createOrganization(options);');
  });
});
