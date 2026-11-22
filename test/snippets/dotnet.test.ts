import { describe, expect, it } from 'vitest';
import type { Enum, Model, Service } from '@workos/oagen';
import { runSnippetEmitters } from '@workos/oagen';
import { dotnetSnippetEmitter } from '../../src/snippets/dotnet.js';
import { generateResources } from '../../src/dotnet/resources.js';
import { makeCtx, makeOp, makeSpec, makeStringField } from './_helpers.js';

function runDotnet(services: Service[], models: Model[] = [], enums: Enum[] = []): string {
  const spec = makeSpec(services, models);
  spec.enums = enums;
  const results = runSnippetEmitters([dotnetSnippetEmitter], makeCtx(spec));
  return results[0]!.content;
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

  it('passes a required options object even when no field has a value', () => {
    const content = runDotnet(
      [createOrganization],
      [{ name: 'CreateOrgReq', fields: [makeStringField('external_id', undefined, false)] }],
    );
    expect(content).toContain('await client.Organizations.CreateAsync(new OrganizationsCreateOptions());');
  });

  it('types values like the properties they fill', () => {
    const content = runDotnet(
      [createOrganization],
      [
        {
          name: 'CreateOrgReq',
          fields: [
            { name: 'state', type: { kind: 'enum', name: 'OrgState' }, required: true, example: 'active' },
            {
              name: 'domains',
              type: { kind: 'array', items: { kind: 'primitive', type: 'string' } },
              required: true,
              example: ['foo-corp.com'],
            },
            {
              name: 'metadata',
              type: { kind: 'map', valueType: { kind: 'primitive', type: 'string' } },
              required: true,
              example: { tier: 'gold' },
            },
            {
              name: 'created_at',
              type: { kind: 'primitive', type: 'string', format: 'date-time' },
              required: true,
              example: '2026-01-01T00:00:00Z',
            },
            {
              name: 'domain_data',
              type: { kind: 'array', items: { kind: 'model', name: 'DomainData' } },
              required: true,
            },
          ],
        },
        { name: 'DomainData', fields: [makeStringField('domain', 'foo-corp.com')] },
      ],
      [
        {
          name: 'OrgState',
          values: [
            { name: 'active', value: 'active' },
            { name: 'inactive', value: 'inactive' },
          ],
        },
      ],
    );
    expect(content).toContain('State = OrgState.Active,');
    expect(content).toContain('Domains = new List<string> { "foo-corp.com" },');
    expect(content).toContain('Metadata = new Dictionary<string, string> { { "tier", "gold" } },');
    expect(content).toContain('CreatedAt = DateTimeOffset.Parse("2026-01-01T00:00:00Z"),');
    expect(content).toContain('new DomainData');
    expect(content).toContain('Domain = "foo-corp.com",');
    expect(content).not.toContain('Dictionary<string, object>');
  });

  it('passes path parameters before the options object', () => {
    const content = runDotnet([
      {
        name: 'Organizations',
        operations: [
          makeOp({
            name: 'list_organization_roles',
            path: '/organizations/{id}/roles',
            pathParams: [
              { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true, example: 'org_123' },
            ],
            queryParams: [
              { name: 'search', type: { kind: 'primitive', type: 'string' }, required: true, example: 'admin' },
            ],
          }),
        ],
      },
    ]);
    expect(content).toContain(
      [
        'await client.Organizations.ListRolesAsync("org_123", new OrganizationsListRolesOptions',
        '{',
        '    Search = "admin",',
        '});',
      ].join('\n'),
    );
  });

  it('renders the Unknown sentinel for the wire value unknown', () => {
    const content = runDotnet(
      [createOrganization],
      [
        {
          name: 'CreateOrgReq',
          fields: [{ name: 'state', type: { kind: 'enum', name: 'OrgState' }, required: true, example: 'unknown' }],
        },
      ],
      [
        {
          name: 'OrgState',
          values: [
            { name: 'unknown', value: 'unknown' },
            { name: 'active', value: 'active' },
          ],
        },
      ],
    );
    expect(content).toContain('State = OrgState.Unknown,');
  });

  it('picks the union model whose fields match the example', () => {
    const content = runDotnet(
      [createOrganization],
      [
        {
          name: 'CreateOrgReq',
          fields: [
            {
              name: 'contact',
              type: {
                kind: 'union',
                variants: [
                  { kind: 'model', name: 'EmailContact' },
                  { kind: 'model', name: 'PhoneContact' },
                ],
              },
              required: true,
              example: { phone: '+15555550100' },
            },
          ],
        },
        { name: 'EmailContact', fields: [makeStringField('email', 'a@b.co')] },
        { name: 'PhoneContact', fields: [makeStringField('phone', '+15555550100')] },
      ],
    );
    expect(content).toContain('Contact = new PhoneContact');
    expect(content).toContain('Phone = "+15555550100",');
  });

  it('keeps an object no union model matches as the union map', () => {
    const content = runDotnet(
      [createOrganization],
      [
        {
          name: 'CreateOrgReq',
          fields: [
            {
              name: 'contact',
              type: {
                kind: 'union',
                variants: [
                  { kind: 'model', name: 'EmailContact' },
                  { kind: 'map', valueType: { kind: 'primitive', type: 'string' } },
                ],
              },
              required: true,
              example: { pager: '555' },
            },
          ],
        },
        { name: 'EmailContact', fields: [makeStringField('email', 'a@b.co')] },
      ],
    );
    expect(content).toContain('Contact = new Dictionary<string, string> { { "pager", "555" } },');
  });

  it('keeps the SDK spec aliases when another spec was rendered in between', () => {
    const enums: Enum[] = ['OrgState', 'OrgStatus'].map((name) => ({
      name,
      values: [
        { name: 'active', value: 'active' },
        { name: 'inactive', value: 'inactive' },
      ],
    }));
    const models: Model[] = [
      {
        name: 'CreateOrgReq',
        fields: [{ name: 'status', type: { kind: 'enum', name: 'OrgStatus' }, required: true, example: 'active' }],
      },
    ];
    const specA = makeSpec([createOrganization], models);
    specA.enums = enums;
    const ctxA = makeCtx(specA);
    const first = runSnippetEmitters([dotnetSnippetEmitter], ctxA)[0]!.content;
    runSnippetEmitters([dotnetSnippetEmitter], makeCtx(makeSpec([createOrganization], [])));
    expect(runSnippetEmitters([dotnetSnippetEmitter], ctxA)[0]!.content).toBe(first);
  });

  describe('parameter groups', () => {
    const idParam = (name: string) => ({
      name,
      type: { kind: 'primitive' as const, type: 'string' as const },
      required: true,
    });
    const auditLogs: Service = {
      name: 'AuditLogs',
      operations: [
        makeOp({
          name: 'setRetention',
          httpMethod: 'put',
          path: '/audit_logs_retention',
          parameterGroups: [
            {
              name: 'retention',
              optional: false,
              variants: [{ name: 'period', parameters: [idParam('retention_period')] }],
            },
          ],
        }),
        makeOp({
          name: 'setRetentionGroup',
          httpMethod: 'put',
          path: '/audit_logs_retention_group',
          parameterGroups: [
            {
              name: 'retention_group',
              optional: false,
              variants: [{ name: 'slug', parameters: [idParam('retention_group_slug')] }],
            },
            {
              name: 'owner',
              optional: false,
              variants: [{ name: 'slug', parameters: [idParam('owner_slug')] }],
            },
          ],
        }),
      ],
    };
    const models: Model[] = [
      { name: 'AuditLogsRetention', fields: [makeStringField('retention_period_in_days', '30')] },
    ];

    it('names each group variant class the way the SDK declares it', () => {
      const ctx = makeCtx(makeSpec([auditLogs], models));
      const results = runSnippetEmitters([dotnetSnippetEmitter], ctx);
      const options = generateResources([auditLogs], ctx).find((f) => f.path.endsWith('Options.cs'))!.content;
      const groupSnippet = results.find((r) => r.content.includes('SetRetentionGroupAsync'))!.content;
      const classes = [...groupSnippet.matchAll(/new (\w+)\n/g)]
        .map((m) => m[1]!)
        .filter((c) => !c.endsWith('Options'));
      expect(classes).toHaveLength(2);
      expect(new Set(classes).size).toBe(2);
      for (const cls of classes) expect(options).toContain(`public class ${cls} : `);
      expect(groupSnippet).toMatch(/RetentionGroup = new \w+\n\s*\{\n\s*RetentionGroupSlug = /);
      expect(groupSnippet).toMatch(/Owner = new \w+\n\s*\{\n\s*OwnerSlug = /);
    });
  });
});
