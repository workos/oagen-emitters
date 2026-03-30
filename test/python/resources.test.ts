import { describe, it, expect } from 'vitest';
import { generateResources } from '../../src/python/resources.js';
import type { EmitterContext, ApiSpec, Service, Model } from '@workos/oagen';

const emptySpec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: '',
  services: [],
  models: [],
  enums: [],
};

const ctx: EmitterContext = {
  namespace: 'workos',
  namespacePascal: 'WorkOS',
  spec: emptySpec,
};

describe('generateResources', () => {
  it('returns empty for no services', () => {
    expect(generateResources([], ctx)).toEqual([]);
  });

  it('generates a resource class with methods', () => {
    const models: Model[] = [
      {
        name: 'Organization',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
        ],
      },
    ];

    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [
          {
            name: 'getOrganization',
            httpMethod: 'get',
            path: '/organizations/{id}',
            pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model', name: 'Organization' },
            errors: [],
            injectIdempotencyKey: false,
          },
          {
            name: 'deleteOrganization',
            httpMethod: 'delete',
            path: '/organizations/{id}',
            pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
            queryParams: [],
            headerParams: [],
            response: { kind: 'primitive', type: 'unknown' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const ctxWithServices: EmitterContext = {
      ...ctx,
      spec: { ...emptySpec, services, models },
    };

    const files = generateResources(services, ctxWithServices);
    expect(files.length).toBe(1);
    expect(files[0].path).toBe('src/workos/organizations/_resource.py');

    const content = files[0].content;

    // Class definition
    expect(content).toContain('class Organizations:');
    expect(content).toContain('def __init__(self, client: "WorkOS") -> None:');

    // GET method with path param (normalized: get_organization → get)
    expect(content).toContain('def get(');
    expect(content).toContain('id: str,');
    expect(content).toContain('f"organizations/{id}"');
    expect(content).toContain('model=Organization');
    // Public request methods (no underscore prefix)
    expect(content).toContain('self._client.request(');

    // DELETE method returns None (normalized: delete_organization → delete)
    expect(content).toContain('def delete(');
    expect(content).toContain(') -> None:');
  });

  it('generates paginated list method', () => {
    const models: Model[] = [
      {
        name: 'Organization',
        fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ];

    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [
          {
            name: 'listOrganizations',
            httpMethod: 'get',
            path: '/organizations',
            pathParams: [],
            queryParams: [
              { name: 'limit', type: { kind: 'primitive', type: 'integer' }, required: false },
              { name: 'after', type: { kind: 'primitive', type: 'string' }, required: false },
            ],
            headerParams: [],
            response: { kind: 'model', name: 'OrganizationList' },
            errors: [],
            injectIdempotencyKey: false,
            pagination: {
              strategy: 'cursor',
              param: 'after',
              dataPath: 'data',
              itemType: { kind: 'model', name: 'Organization' },
            },
          },
        ],
      },
    ];

    const ctxWithServices: EmitterContext = {
      ...ctx,
      spec: { ...emptySpec, services, models },
    };

    const files = generateResources(services, ctxWithServices);
    expect(files.length).toBe(1);

    const content = files[0].content;
    expect(content).toContain('def list_organizations(');
    expect(content).toContain('limit: Optional[int] = None,');
    expect(content).toContain('after: Optional[str] = None,');
    expect(content).toContain(') -> SyncPage[Organization]:');
    expect(content).toContain('request_page(');
    expect(content).toContain('model=Organization');
  });

  it('unwraps list wrapper models in paginated methods', () => {
    const models: Model[] = [
      {
        name: 'Organization',
        fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
      {
        name: 'OrganizationList',
        fields: [
          {
            name: 'data',
            type: { kind: 'array', items: { kind: 'model', name: 'Organization' } },
            required: true,
          },
          {
            name: 'list_metadata',
            type: { kind: 'model', name: 'ListMetadata' },
            required: true,
          },
          {
            name: 'object',
            type: { kind: 'primitive', type: 'string' },
            required: true,
          },
        ],
      },
    ];

    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [
          {
            name: 'listOrganizations',
            httpMethod: 'get',
            path: '/organizations',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model', name: 'OrganizationList' },
            errors: [],
            injectIdempotencyKey: false,
            pagination: {
              strategy: 'cursor',
              param: 'after',
              dataPath: 'data',
              itemType: { kind: 'model', name: 'OrganizationList' },
            },
          },
        ],
      },
    ];

    const ctxWithServices: EmitterContext = {
      ...ctx,
      spec: { ...emptySpec, services, models },
    };

    const files = generateResources(services, ctxWithServices);
    const content = files[0].content;

    // Should use item model, not list wrapper
    expect(content).toContain(') -> SyncPage[Organization]:');
    expect(content).toContain('model=Organization');
    expect(content).not.toContain('model=OrganizationList');
    expect(content).not.toContain('SyncPage[OrganizationList]');
  });

  it('generates DELETE with body when requestBody is present', () => {
    const models: Model[] = [
      {
        name: 'RemoveRoleRequest',
        fields: [
          { name: 'role_slug', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'resource_id', type: { kind: 'primitive', type: 'string' }, required: false },
        ],
      },
    ];

    const services: Service[] = [
      {
        name: 'Authorization',
        operations: [
          {
            name: 'removeRole',
            httpMethod: 'delete',
            path: '/authorization/roles/{user_id}',
            pathParams: [{ name: 'user_id', type: { kind: 'primitive', type: 'string' }, required: true }],
            queryParams: [],
            headerParams: [],
            requestBody: { kind: 'model', name: 'RemoveRoleRequest' },
            response: { kind: 'primitive', type: 'unknown' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const ctxWithServices: EmitterContext = {
      ...ctx,
      spec: { ...emptySpec, services, models },
    };

    const files = generateResources(services, ctxWithServices);
    const content = files[0].content;

    expect(content).toContain(') -> None:');
    expect(content).toContain('role_slug: str,');
    expect(content).toContain('"role_slug": role_slug');
    expect(content).toContain('body=body,');
  });

  it('calls .to_dict() on model-typed body fields', () => {
    const models: Model[] = [
      {
        name: 'AuditLogEvent',
        fields: [{ name: 'action', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
      {
        name: 'AuditLogSchemaTarget',
        fields: [{ name: 'type', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
      {
        name: 'CreateEventRequest',
        fields: [
          { name: 'event', type: { kind: 'model', name: 'AuditLogEvent' }, required: true },
          {
            name: 'targets',
            type: { kind: 'array', items: { kind: 'model', name: 'AuditLogSchemaTarget' } },
            required: true,
          },
        ],
      },
      {
        name: 'EventResult',
        fields: [{ name: 'success', type: { kind: 'primitive', type: 'boolean' }, required: true }],
      },
    ];

    const services: Service[] = [
      {
        name: 'AuditLogs',
        operations: [
          {
            name: 'createEvent',
            httpMethod: 'post',
            path: '/audit_logs/events',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            requestBody: { kind: 'model', name: 'CreateEventRequest' },
            response: { kind: 'model', name: 'EventResult' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const ctxWithServices: EmitterContext = {
      ...ctx,
      spec: { ...emptySpec, services, models },
    };

    const files = generateResources(services, ctxWithServices);
    const content = files[0].content;

    // Model field should call .to_dict() directly (types are known at generation time)
    expect(content).toContain('"event": event.to_dict()');
    // Array of models should use list comprehension with .to_dict()
    expect(content).toContain('"targets": [item.to_dict() for item in targets]');
  });

  it('generates idempotent POST with idempotency_key', () => {
    const models: Model[] = [
      {
        name: 'Organization',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
        ],
      },
      {
        name: 'CreateOrganizationRequest',
        fields: [{ name: 'name', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ];

    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [
          {
            name: 'createOrganization',
            httpMethod: 'post',
            path: '/organizations',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            requestBody: { kind: 'model', name: 'CreateOrganizationRequest' },
            response: { kind: 'model', name: 'Organization' },
            errors: [],
            injectIdempotencyKey: true,
          },
        ],
      },
    ];

    const ctxWithServices: EmitterContext = {
      ...ctx,
      spec: { ...emptySpec, services, models },
    };

    const files = generateResources(services, ctxWithServices);
    const content = files[0].content;
    expect(content).toContain('idempotency_key: Optional[str] = None,');
    expect(content).toContain('idempotency_key=idempotency_key,');
  });
});
