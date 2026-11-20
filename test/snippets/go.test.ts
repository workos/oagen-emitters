import { describe, expect, it } from 'vitest';
import type { Enum, Model, Service } from '@workos/oagen';
import { runSnippetEmitters } from '@workos/oagen';
import { goSnippetEmitter } from '../../src/snippets/go.js';
import { makeCtx, makeOp, makeSpec, makeStringField } from './_helpers.js';

function runGo(services: Service[], models: Model[] = [], enums: Enum[] = []): string {
  const spec = makeSpec(services, models);
  spec.enums = enums;
  const results = runSnippetEmitters([goSnippetEmitter], makeCtx(spec));
  return results[0]!.content;
}

describe('snippets/go', () => {
  it('renders a package main with context import and client init', () => {
    const content = runGo([{ name: 'Organizations', operations: [makeOp({ name: 'list_organizations' })] }]);
    expect(content).toContain('package main');
    expect(content).toContain('"context"');
    expect(content).toContain('"github.com/workos/workos-go/v10"');
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

  it('passes the params struct even when no field is required', () => {
    const content = runGo([
      {
        name: 'Organizations',
        operations: [
          makeOp({
            name: 'list_organizations',
            queryParams: [
              {
                name: 'domains',
                type: { kind: 'array', items: { kind: 'primitive', type: 'string' } },
                required: false,
              },
            ],
          }),
        ],
      },
    ]);
    expect(content).toContain('client.Organizations().List(context.Background(), &workos.OrganizationsListParams{})');
  });

  it('iterates paginated list results instead of expecting (result, err)', () => {
    const content = runGo(
      [
        {
          name: 'Organizations',
          operations: [
            makeOp({
              name: 'list_organizations',
              queryParams: [
                { name: 'before', type: { kind: 'primitive', type: 'string' }, required: false },
                { name: 'after', type: { kind: 'primitive', type: 'string' }, required: false },
                { name: 'limit', type: { kind: 'primitive', type: 'integer' }, required: false },
              ],
              response: { kind: 'model', name: 'OrganizationList' },
              pagination: {
                strategy: 'cursor',
                param: 'after',
                dataPath: 'data',
                itemType: { kind: 'model', name: 'Organization' },
              },
            }),
          ],
        },
      ],
      [{ name: 'Organization', fields: [makeStringField('id', 'org_123')] }],
    );
    expect(content).toContain(
      'iter := client.Organizations().List(context.Background(), &workos.OrganizationsListParams{})',
    );
    expect(content).toContain('for iter.Next() {');
    expect(content).toContain('fmt.Println(iter.Current())');
    expect(content).toContain('if err := iter.Err(); err != nil {');
    expect(content).toContain('"fmt"');
    expect(content).not.toContain('_, err :=');
  });

  it('assigns only err for delete operations', () => {
    const content = runGo([
      {
        name: 'Organizations',
        operations: [
          makeOp({
            name: 'delete_organization',
            httpMethod: 'delete',
            path: '/organizations/{id}',
            pathParams: [
              { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true, example: 'org_123' },
            ],
            response: { kind: 'primitive', type: 'unknown' },
          }),
        ],
      },
    ]);
    expect(content).toContain('err := client.Organizations().Delete(context.Background(), "org_123")');
    expect(content).not.toContain('_, err :=');
  });

  it('renders model-typed body fields as typed struct literals with pointer helpers for optional fields', () => {
    const content = runGo(
      [
        {
          name: 'AuditLogs',
          operations: [
            makeOp({
              name: 'create_event',
              httpMethod: 'post',
              path: '/audit_logs/events',
              requestBody: { kind: 'model', name: 'CreateEventReq' },
              response: { kind: 'model', name: 'CreateEventResponse' },
            }),
          ],
        },
      ],
      [
        {
          name: 'CreateEventReq',
          fields: [
            makeStringField('organization_id', 'org_123'),
            { name: 'event', type: { kind: 'model', name: 'AuditLogEvent' }, required: true },
          ],
        },
        {
          name: 'AuditLogEvent',
          fields: [
            makeStringField('action', 'user.signed_in'),
            makeStringField('occurred_at', '2026-01-01T00:00:00Z', false),
            { name: 'version', type: { kind: 'primitive', type: 'integer' }, required: false, example: 1 },
            {
              name: 'targets',
              type: { kind: 'array', items: { kind: 'model', name: 'AuditLogEventTarget' } },
              required: true,
            },
            {
              name: 'metadata',
              type: { kind: 'map', valueType: { kind: 'primitive', type: 'unknown' } },
              required: false,
              example: { owner: 'user_1' },
            },
          ],
        },
        {
          name: 'AuditLogEventTarget',
          fields: [makeStringField('id', 'user_1'), makeStringField('type', 'user')],
        },
      ],
    );
    expect(content).toContain('Event: &workos.AuditLogEvent{');
    expect(content).toContain('Action:');
    expect(content).toContain('workos.String("2026-01-01T00:00:00Z")');
    expect(content).toContain('workos.Int(1)');
    // Slice elements drop the type the slice literal already implies.
    expect(content).toContain('Targets: []*workos.AuditLogEventTarget{{ID: "user_1", Type: "user"}}');
    expect(content).toContain('map[string]interface{}{"owner": "user_1"}');
    expect(content).not.toContain('map[string]any');
    expect(content).not.toContain('[]any');
  });

  it('converts enum values to their named Go type', () => {
    const content = runGo(
      [
        {
          name: 'Radar',
          operations: [
            makeOp({
              name: 'remove_list_entry',
              httpMethod: 'delete',
              path: '/radar/lists/{type}',
              pathParams: [
                {
                  name: 'type',
                  type: { kind: 'enum', name: 'RadarListType' },
                  required: true,
                  example: 'ip_address',
                },
              ],
              queryParams: [
                {
                  name: 'action',
                  type: { kind: 'enum', name: 'RadarListAction' },
                  required: false,
                },
              ],
            }),
          ],
        },
      ],
      [],
      [
        { name: 'RadarListType', values: [{ name: 'ip_address', value: 'ip_address' }] },
        { name: 'RadarListAction', values: [{ name: 'block', value: 'block' }] },
      ],
    );
    expect(content).toContain('workos.RadarListType("ip_address")');
  });

  it('wraps optional enum values in workos.Ptr', () => {
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
          fields: [{ name: 'settings', type: { kind: 'model', name: 'OrgSettings' }, required: true }],
        },
        {
          name: 'OrgSettings',
          fields: [{ name: 'state', type: { kind: 'enum', name: 'OrgState' }, required: false, example: 'active' }],
        },
      ],
      [{ name: 'OrgState', values: [{ name: 'active', value: 'active' }] }],
    );
    expect(content).toContain('State: workos.Ptr[workos.OrgState](workos.OrgState("active"))');
  });

  it('renders wrapper methods with their full name and exposed params', () => {
    const models: Model[] = [
      {
        name: 'PasswordAuthenticateRequest',
        fields: [
          { name: 'grant_type', type: { kind: 'primitive', type: 'string' }, required: true },
          makeStringField('email', 'user@example.com'),
          makeStringField('password', 'hunter2'),
          makeStringField('ip_address', '203.0.113.1', false),
        ],
      },
    ];
    const services: Service[] = [
      {
        name: 'UserManagement',
        operations: [
          makeOp({
            name: 'authenticate',
            httpMethod: 'post',
            path: '/user_management/authenticate',
            requestBody: { kind: 'model', name: 'PasswordAuthenticateRequest' },
            response: { kind: 'model', name: 'AuthenticationResponse' },
          }),
        ],
      },
    ];
    const ctx = makeCtx(makeSpec(services, models));
    ctx.resolvedOperations![0]!.wrappers = [
      {
        name: 'authenticate_with_password',
        targetVariant: 'PasswordAuthenticateRequest',
        defaults: { grant_type: 'password' },
        inferFromClient: ['client_id', 'client_secret'],
        exposedParams: ['email', 'password', 'ip_address'],
        optionalParams: ['ip_address'],
        responseModelName: 'AuthenticationResponse',
      },
    ];
    const content = runSnippetEmitters([goSnippetEmitter], ctx)[0]!.content;
    expect(content).toContain(
      '_, err := client.UserManagement().AuthenticateWithPassword(context.Background(), &workos.UserManagementAuthenticateWithPasswordParams{',
    );
    expect(content).toContain('Email: "user@example.com",');
    expect(content).toContain('Password: "hunter2",');
    expect(content).not.toContain('IPAddress');
    expect(content).not.toContain('ClientID');
  });

  it('fills a required parameter group with its first variant', () => {
    const idParam = {
      name: 'resource_id',
      type: { kind: 'primitive' as const, type: 'string' as const },
      required: false,
      example: 'res_123',
    };
    const externalIdParam = {
      name: 'resource_external_id',
      type: { kind: 'primitive' as const, type: 'string' as const },
      required: false,
      example: 'ext_123',
    };
    const content = runGo([
      {
        name: 'Authorization',
        operations: [
          makeOp({
            name: 'check',
            httpMethod: 'get',
            path: '/authorization/check',
            queryParams: [makeQueryParam('permission_slug', 'documents:read'), idParam, externalIdParam],
            parameterGroups: [
              {
                name: 'resource_target',
                optional: false,
                variants: [
                  { name: 'by_id', parameters: [idParam] },
                  { name: 'by_external_id', parameters: [externalIdParam] },
                ],
              },
            ],
            response: { kind: 'model', name: 'CheckResponse' },
          }),
        ],
      },
    ]);
    expect(content).toContain('PermissionSlug: "documents:read",');
    expect(content).toContain(
      'ResourceTarget: workos.AuthorizationResourceTargetByID{\n\t\t\tResourceID: "res_123",\n\t\t},',
    );
    expect(content).not.toContain('ResourceExternalID');
  });
});

function makeQueryParam(name: string, example: string) {
  return { name, type: { kind: 'primitive' as const, type: 'string' as const }, required: true, example };
}
