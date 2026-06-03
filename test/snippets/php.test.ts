import { describe, expect, it } from 'vitest';
import type { Model, Service } from '@workos/oagen';
import { runSnippetEmitters } from '@workos/oagen';
import { phpSnippetEmitter } from '../../src/snippets/php.js';
import { makeCtx, makeOp, makeSpec, makeStringField } from './_helpers.js';

function runPhp(services: Service[], models: Model[] = []): string {
  const results = runSnippetEmitters([phpSnippetEmitter], makeCtx(makeSpec(services, models)));
  return results[0]!.content;
}

describe('snippets/php', () => {
  it('renders the modern WorkOS client constructor with named args', () => {
    const content = runPhp([{ name: 'Organizations', operations: [makeOp({ name: 'list_organizations' })] }]);
    expect(content).toContain('<?php');
    expect(content).toContain('use WorkOS\\WorkOS;');
    expect(content).toContain("apiKey: 'sk_example_123456789'");
    expect(content).toContain("clientId: 'client_123456789'");
    expect(content).toContain('$workos->organizations()->listOrganizations();');
  });

  it('camelCases body field kwargs and uses PHP named args', () => {
    const content = runPhp(
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
          fields: [makeStringField('name', 'Foo Corp'), makeStringField('external_id', 'ext_123')],
        },
      ],
    );
    expect(content).toContain('$workos->organizations()->createOrganization(');
    expect(content).toContain("name: 'Foo Corp'");
    expect(content).toContain("externalId: 'ext_123'");
  });
});
