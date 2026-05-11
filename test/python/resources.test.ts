import { describe, it, expect } from 'vitest';
import { generateResources } from '../../src/python/resources.js';
import type { EmitterContext, ApiSpec, Service, Model } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';

const emptySpec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: '',
  services: [],
  models: [],
  enums: [],
  sdk: defaultSdkBehavior(),
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
    expect(content).toContain('def __init__(self, client: "WorkOSClient") -> None:');

    // GET method with path param
    expect(content).toContain('def get_organization(');
    expect(content).toContain('id: str,');
    expect(content).toContain(`("organizations", str(id))`);
    expect(content).not.toContain('from urllib.parse import quote');
    expect(content).toContain('model=Organization');
    // Public request methods (no underscore prefix)
    expect(content).toContain('self._client.request(');

    // DELETE method returns None
    expect(content).toContain('def delete_organization(');
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
              {
                name: 'limit',
                type: { kind: 'primitive', type: 'integer' },
                required: false,
                description: 'Upper limit on the number of objects to return, between `1` and `100`.',
              },
              {
                name: 'after',
                type: { kind: 'primitive', type: 'string' },
                required: false,
                description:
                  'An object ID that defines your place in the list. When the ID is not present, you are at the end of the list.',
              },
              {
                name: 'order',
                type: { kind: 'primitive', type: 'string' },
                required: false,
                description: 'Order the results by the creation time.',
              },
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
    expect(content).toContain('limit: Upper limit on the number of objects to return, between `1` and `100`.');
    expect(content).toContain(
      'after: An object ID that defines your place in the list. When the ID is not present, you are at the end of the list.',
    );
    expect(content).toContain('order: Order the results by the creation time.');
    // The spec has no `default` for `order` here, so the SDK must NOT
    // hardcode 'desc' on the client. Server's default applies instead.
    expect(content).toContain('order: Optional[str] = None,');
    expect(content).not.toContain('order: Optional[str] = "desc"');
  });

  it('reads pagination order default from the spec rather than hardcoding "desc"', () => {
    const models: Model[] = [
      { name: 'Organization', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
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
              {
                name: 'order',
                type: { kind: 'primitive', type: 'string' },
                required: false,
                default: 'desc',
              },
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
    const content = generateResources(services, { ...ctx, spec: { ...emptySpec, services, models } })[0].content;
    expect(content).toContain('order: Optional[str] = "desc",');
  });

  it('indents multiline argument descriptions in docstrings', () => {
    const models: Model[] = [
      {
        name: 'GenerateLinkRequest',
        fields: [
          {
            name: 'intent',
            type: { kind: 'primitive', type: 'string' },
            required: false,
            description: [
              'The intent of the Admin Portal.',
              '- `sso` - Launch Admin Portal for creating SSO connections',
              '- `dsync` - Launch Admin Portal for creating Directory Sync connections',
            ].join('\n'),
          },
          {
            name: 'organization',
            type: { kind: 'primitive', type: 'string' },
            required: true,
            description: 'An organization identifier.',
          },
        ],
      },
      {
        name: 'PortalLinkResponse',
        fields: [{ name: 'link', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ];

    const services: Service[] = [
      {
        name: 'AdminPortal',
        operations: [
          {
            name: 'generateLink',
            httpMethod: 'post',
            path: '/portal/generate_link',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            requestBody: { kind: 'model', name: 'GenerateLinkRequest' },
            response: { kind: 'model', name: 'PortalLinkResponse' },
            description: 'Generate a Portal Link scoped to an Organization.',
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

    expect(content).toContain('intent: The intent of the Admin Portal.');
    expect(content).toContain('                - `sso` - Launch Admin Portal for creating SSO connections');
    expect(content).toContain(
      '                - `dsync` - Launch Admin Portal for creating Directory Sync connections',
    );
    expect(content).toContain('organization: An organization identifier.');
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

    // Model field should call .to_dict() directly
    expect(content).toContain('"event": event.to_dict()');
    // Array of models should use list comprehension calling .to_dict()
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

  it('adds deprecated annotation to operations', () => {
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
            deprecated: true,
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

    // Docstring should contain .. deprecated::
    expect(content).toContain('.. deprecated::');
    expect(content).toContain('This operation is deprecated.');

    // Body should contain warnings.warn
    expect(content).toContain('warnings.warn("get_organization is deprecated", DeprecationWarning, stacklevel=2)');

    // Import warnings should be present
    expect(content).toContain('import warnings');
  });

  it('does not import warnings when no operations are deprecated', () => {
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
        ],
      },
    ];

    const ctxWithServices: EmitterContext = {
      ...ctx,
      spec: { ...emptySpec, services, models },
    };

    const files = generateResources(services, ctxWithServices);
    const content = files[0].content;
    expect(content).not.toContain('import warnings');
  });

  it('marks deprecated parameters with (deprecated) prefix in Args docstring', () => {
    const models: Model[] = [
      {
        name: 'Organization',
        fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
      {
        name: 'UpdateOrgRequest',
        fields: [
          { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
          {
            name: 'old_field',
            type: { kind: 'primitive', type: 'string' },
            required: false,
            deprecated: true,
            description: 'Legacy field',
          },
        ],
      },
    ];

    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [
          {
            name: 'updateOrganization',
            httpMethod: 'put',
            path: '/organizations/{id}',
            pathParams: [
              {
                name: 'id',
                type: { kind: 'primitive', type: 'string' },
                required: true,
                deprecated: true,
                description: 'The org ID',
              },
            ],
            queryParams: [
              {
                name: 'legacy_param',
                type: { kind: 'primitive', type: 'string' },
                required: false,
                deprecated: true,
              },
            ],
            headerParams: [],
            requestBody: { kind: 'model', name: 'UpdateOrgRequest' },
            response: { kind: 'model', name: 'Organization' },
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

    // Deprecated path param with description
    expect(content).toContain('id: (deprecated) The org ID');

    // Deprecated body field with description
    expect(content).toContain('old_field: (deprecated) Legacy field');

    // Deprecated query param without description
    expect(content).toContain('legacy_param: (deprecated)');
  });

  it('generates parameter group dataclasses, union kwargs, and isinstance dispatch', () => {
    const models: Model[] = [
      {
        name: 'Widget',
        fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ];

    const services: Service[] = [
      {
        name: 'Widgets',
        operations: [
          {
            name: 'listWidgets',
            httpMethod: 'get',
            path: '/widgets',
            pathParams: [],
            queryParams: [
              {
                name: 'limit',
                type: { kind: 'primitive', type: 'integer' },
                required: false,
              },
              {
                name: 'after',
                type: { kind: 'primitive', type: 'string' },
                required: false,
              },
              {
                name: 'order',
                type: { kind: 'primitive', type: 'string' },
                required: false,
              },
              {
                name: 'parent_resource_id',
                type: { kind: 'primitive', type: 'string' },
                required: false,
              },
              {
                name: 'parent_resource_type_slug',
                type: { kind: 'primitive', type: 'string' },
                required: false,
              },
              {
                name: 'parent_resource_external_id',
                type: { kind: 'primitive', type: 'string' },
                required: false,
              },
            ],
            headerParams: [],
            response: { kind: 'model', name: 'WidgetList' },
            errors: [],
            injectIdempotencyKey: false,
            pagination: {
              strategy: 'cursor',
              param: 'after',
              dataPath: 'data',
              itemType: { kind: 'model', name: 'Widget' },
            },
            parameterGroups: [
              {
                name: 'parent_resource',
                optional: false,
                variants: [
                  {
                    name: 'by_id',
                    parameters: [
                      {
                        name: 'parent_resource_id',
                        type: { kind: 'primitive', type: 'string' },
                        required: true,
                      },
                    ],
                  },
                  {
                    name: 'by_external_id',
                    parameters: [
                      {
                        name: 'parent_resource_type_slug',
                        type: { kind: 'primitive', type: 'string' },
                        required: true,
                      },
                      {
                        name: 'parent_resource_external_id',
                        type: { kind: 'primitive', type: 'string' },
                        required: true,
                      },
                    ],
                  },
                ],
              },
            ],
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

    // dataclass import should be present
    expect(content).toContain('from dataclasses import dataclass');

    // Variant dataclass definitions
    expect(content).toContain('@dataclass');
    expect(content).toContain('class ParentResourceById:');
    expect(content).toContain('    parent_resource_id: str');
    expect(content).toContain('class ParentResourceByExternalId:');
    expect(content).toContain('    parent_resource_type_slug: str');
    expect(content).toContain('    parent_resource_external_id: str');

    // Method signature should have the union kwarg, not individual grouped params
    expect(content).toContain('parent_resource: Union[ParentResourceById, ParentResourceByExternalId],');
    // Grouped params should NOT appear as individual kwargs
    expect(content).not.toMatch(/^\s+parent_resource_id: str,$/m);
    expect(content).not.toMatch(/^\s+parent_resource_type_slug: str,$/m);
    expect(content).not.toMatch(/^\s+parent_resource_external_id: str,$/m);

    // isinstance dispatch in method body
    expect(content).toContain('if isinstance(parent_resource, ParentResourceById):');
    expect(content).toContain('params["parent_resource_id"] = parent_resource.parent_resource_id');
    expect(content).toContain('elif isinstance(parent_resource, ParentResourceByExternalId):');
    expect(content).toContain('params["parent_resource_type_slug"] = parent_resource.parent_resource_type_slug');
    expect(content).toContain('params["parent_resource_external_id"] = parent_resource.parent_resource_external_id');

    // Docstring should document the group parameter
    expect(content).toContain(
      'parent_resource: Identifies the parent resource. One of: ParentResourceById, ParentResourceByExternalId.',
    );
  });

  it('generates optional parameter group with Optional[Union[...]] = None', () => {
    const models: Model[] = [
      {
        name: 'Thing',
        fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ];

    const services: Service[] = [
      {
        name: 'Things',
        operations: [
          {
            name: 'getThing',
            httpMethod: 'get',
            path: '/things/{id}',
            pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
            queryParams: [
              {
                name: 'scope_id',
                type: { kind: 'primitive', type: 'string' },
                required: false,
              },
              {
                name: 'scope_name',
                type: { kind: 'primitive', type: 'string' },
                required: false,
              },
            ],
            headerParams: [],
            response: { kind: 'model', name: 'Thing' },
            errors: [],
            injectIdempotencyKey: false,
            parameterGroups: [
              {
                name: 'scope',
                optional: true,
                variants: [
                  {
                    name: 'by_id',
                    parameters: [
                      {
                        name: 'scope_id',
                        type: { kind: 'primitive', type: 'string' },
                        required: true,
                      },
                    ],
                  },
                  {
                    name: 'by_name',
                    parameters: [
                      {
                        name: 'scope_name',
                        type: { kind: 'primitive', type: 'string' },
                        required: true,
                      },
                    ],
                  },
                ],
              },
            ],
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

    // Optional group should use Optional[Union[...]] = None
    expect(content).toContain('scope: Optional[Union[ScopeById, ScopeByName]] = None,');

    // Dataclass definitions
    expect(content).toContain('class ScopeById:');
    expect(content).toContain('    scope_id: str');
    expect(content).toContain('class ScopeByName:');
    expect(content).toContain('    scope_name: str');

    // isinstance dispatch in the non-paginated GET body
    expect(content).toContain('if isinstance(scope, ScopeById):');
    expect(content).toContain('params["scope_id"] = scope.scope_id');
    expect(content).toContain('elif isinstance(scope, ScopeByName):');
    expect(content).toContain('params["scope_name"] = scope.scope_name');
  });

  it('uses body model field types for parameter group dataclasses', () => {
    const models: Model[] = [
      {
        name: 'OrganizationMembership',
        fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
      {
        name: 'CreateOrganizationMembershipRequest',
        fields: [
          { name: 'user_id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'organization_id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'role_slug', type: { kind: 'primitive', type: 'string' }, required: false },
          {
            name: 'role_slugs',
            type: { kind: 'array', items: { kind: 'primitive', type: 'string' } },
            required: false,
          },
        ],
      },
    ];

    const services: Service[] = [
      {
        name: 'UserManagement',
        operations: [
          {
            name: 'createOrganizationMembership',
            httpMethod: 'post',
            path: '/user_management/organization_memberships',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            requestBody: { kind: 'model', name: 'CreateOrganizationMembershipRequest' },
            response: { kind: 'model', name: 'OrganizationMembership' },
            errors: [],
            injectIdempotencyKey: false,
            parameterGroups: [
              {
                name: 'role',
                optional: true,
                variants: [
                  {
                    name: 'single',
                    parameters: [{ name: 'role_slug', type: { kind: 'primitive', type: 'string' }, required: false }],
                  },
                  {
                    name: 'multiple',
                    parameters: [{ name: 'role_slugs', type: { kind: 'primitive', type: 'string' }, required: false }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];

    const ctxWithServices: EmitterContext = {
      ...ctx,
      spec: { ...emptySpec, services, models },
    };

    const files = generateResources(services, ctxWithServices);
    expect(files[0].content).toContain('class RoleMultiple:');
    expect(files[0].content).toContain('    role_slugs: List[str]');
  });
});
