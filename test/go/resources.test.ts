import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Service, Operation, Model } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateResources } from '../../src/go/resources.js';

function makeSpec(services: Service[], models: Model[] = []): ApiSpec {
  return {
    name: 'Test',
    version: '1.0.0',
    baseUrl: '',
    services,
    models,
    enums: [],
    sdk: defaultSdkBehavior(),
  };
}

function makeCtx(spec: ApiSpec): EmitterContext {
  return {
    namespace: 'workos',
    namespacePascal: 'WorkOS',
    spec,
  };
}

function makeOp(overrides: Partial<Operation>): Operation {
  return {
    name: 'listOrganizations',
    httpMethod: 'get',
    path: '/organizations',
    pathParams: [],
    queryParams: [],
    headerParams: [],
    requestBody: undefined,
    response: { kind: 'model', name: 'Organization' },
    errors: [],
    injectIdempotencyKey: false,
    ...overrides,
  };
}

describe('go/resources', () => {
  it('returns empty for no services', () => {
    const spec = makeSpec([]);
    expect(generateResources([], makeCtx(spec))).toEqual([]);
  });

  it('generates a service file with methods', () => {
    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [
          makeOp({
            name: 'listOrganizations',
            httpMethod: 'get',
            path: '/organizations',
            queryParams: [
              {
                name: 'limit',
                type: { kind: 'primitive', type: 'integer' },
                required: false,
              },
            ],
            pagination: {
              strategy: 'cursor',
              param: 'after',
              dataPath: 'data',
              itemType: { kind: 'model', name: 'Organization' },
            },
          }),
          makeOp({
            name: 'getOrganization',
            httpMethod: 'get',
            path: '/organizations/{id}',
            pathParams: [
              {
                name: 'id',
                type: { kind: 'primitive', type: 'string' },
                required: true,
              },
            ],
          }),
          makeOp({
            name: 'createOrganization',
            httpMethod: 'post',
            path: '/organizations',
            requestBody: { kind: 'model', name: 'CreateOrganizationRequest' },
          }),
          makeOp({
            name: 'deleteOrganization',
            httpMethod: 'delete',
            path: '/organizations/{id}',
            pathParams: [
              {
                name: 'id',
                type: { kind: 'primitive', type: 'string' },
                required: true,
              },
            ],
            response: { kind: 'primitive', type: 'unknown' },
          }),
        ],
      },
    ];
    const spec = makeSpec(services, [
      {
        name: 'CreateOrganizationRequest',
        fields: [{ name: 'name', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ]);
    const ctx = makeCtx(spec);
    const files = generateResources(services, ctx);

    expect(files.length).toBeGreaterThanOrEqual(1);
    const content = files[0].content;
    expect(content).toContain('package workos');
    expect(content).toContain('type OrganizationService struct {');
    expect(content).toContain('Limit *int `url:"limit,omitempty" json:"-"`');
    expect(content).toContain('func (s *OrganizationService) List(');
    expect(content).toContain('func (s *OrganizationService) Get(');
    expect(content).toContain('func (s *OrganizationService) Create(');
    expect(content).toContain('func (s *OrganizationService) Delete(');
  });

  it('generates path interpolation with fmt.Sprintf', () => {
    const services: Service[] = [
      {
        name: 'Users',
        operations: [
          makeOp({
            name: 'getUser',
            httpMethod: 'get',
            path: '/users/{id}',
            pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
          }),
        ],
      },
    ];
    const spec = makeSpec(services);
    const files = generateResources(services, makeCtx(spec));
    const content = files[0].content;
    expect(content).toContain('fmt.Sprintf("/users/%s", url.PathEscape(id))');
  });

  it('generates paginated methods returning Iterator', () => {
    const services: Service[] = [
      {
        name: 'Users',
        operations: [
          makeOp({
            name: 'listUsers',
            httpMethod: 'get',
            path: '/users',
            pagination: {
              strategy: 'cursor',
              param: 'after',
              dataPath: 'data',
              itemType: { kind: 'model', name: 'User' },
            },
          }),
        ],
      },
    ];
    const spec = makeSpec(services);
    const files = generateResources(services, makeCtx(spec));
    const content = files[0].content;
    expect(content).toContain('*Iterator[User]');
    expect(content).toContain('newIterator[User](ctx, s.client, "GET", "/users", nil, "after", "data", opts,');
  });

  it('propagates spec defaults into the newIterator defaults map', () => {
    const services: Service[] = [
      {
        name: 'Users',
        operations: [
          makeOp({
            name: 'listUsers',
            httpMethod: 'get',
            path: '/users',
            queryParams: [
              { name: 'after', type: { kind: 'primitive', type: 'string' }, required: false },
              {
                name: 'limit',
                type: { kind: 'primitive', type: 'integer' },
                required: false,
                default: 10,
              },
              {
                name: 'order',
                type: { kind: 'primitive', type: 'string' },
                required: false,
                default: 'desc',
              },
            ],
            pagination: {
              strategy: 'cursor',
              param: 'after',
              dataPath: 'data',
              itemType: { kind: 'model', name: 'User' },
            },
          }),
        ],
      },
    ];
    const spec = makeSpec(services);
    const content = generateResources(services, makeCtx(spec))[0].content;
    expect(content).toMatch(/newIterator\[User\][^\n]*map\[string\]string\{"limit": "10", "order": "desc"\}/);
  });

  it('omits defaults from newIterator when the spec carries no defaults (no client-side hardcode)', () => {
    const services: Service[] = [
      {
        name: 'Users',
        operations: [
          makeOp({
            name: 'listUsers',
            httpMethod: 'get',
            path: '/users',
            queryParams: [
              { name: 'after', type: { kind: 'primitive', type: 'string' }, required: false },
              { name: 'limit', type: { kind: 'primitive', type: 'integer' }, required: false },
              { name: 'order', type: { kind: 'primitive', type: 'string' }, required: false },
            ],
            pagination: {
              strategy: 'cursor',
              param: 'after',
              dataPath: 'data',
              itemType: { kind: 'model', name: 'User' },
            },
          }),
        ],
      },
    ];
    const spec = makeSpec(services);
    const content = generateResources(services, makeCtx(spec))[0].content;
    // Last argument to newIterator must be `nil`, not a map literal.
    expect(content).toMatch(/newIterator\[User\][^\n]*opts, nil\)/);
    expect(content).not.toContain('"order": "desc"');
  });

  it('generates delete methods returning error', () => {
    const services: Service[] = [
      {
        name: 'Items',
        operations: [
          makeOp({
            name: 'deleteItem',
            httpMethod: 'delete',
            path: '/items/{id}',
            pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
            response: { kind: 'primitive', type: 'unknown' },
          }),
        ],
      },
    ];
    const spec = makeSpec(services);
    const files = generateResources(services, makeCtx(spec));
    const content = files[0].content;
    expect(content).toContain(') error {');
    expect(content).toContain('return err');
  });

  it('generates params struct for body + query params', () => {
    const services: Service[] = [
      {
        name: 'Users',
        operations: [
          makeOp({
            name: 'createUser',
            httpMethod: 'post',
            path: '/users',
            requestBody: { kind: 'model', name: 'CreateUserRequest' },
            queryParams: [
              {
                name: 'notify',
                type: { kind: 'primitive', type: 'boolean' },
                required: false,
              },
            ],
          }),
        ],
      },
    ];
    const spec = makeSpec(services, [
      {
        name: 'CreateUserRequest',
        fields: [{ name: 'email', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ]);
    const files = generateResources(services, makeCtx(spec));
    const content = files[0].content;
    expect(content).toContain('type UsersCreateParams struct {');
    expect(content).toContain('Email string `json:"email" url:"-"`');
    expect(content).toContain('Notify *bool `url:"notify,omitempty" json:"-"`');
    expect(content).toContain('request(ctx, "POST", "/users", params, params, &result, opts)');
  });

  it('does not emit url tag for body fields shadowed by a same-named query param', () => {
    // Spec quirk: an operation lists the same field name in both `parameters`
    // (in: query) and `requestBody`. The body field must not also leak into
    // the URL query string (e.g. /sso/token's `code` carries an auth code).
    const services: Service[] = [
      {
        name: 'Sso',
        operations: [
          makeOp({
            name: 'getProfileAndToken',
            httpMethod: 'post',
            path: '/sso/token',
            requestBody: { kind: 'model', name: 'TokenQueryDto' },
            queryParams: [
              {
                name: 'code',
                type: { kind: 'primitive', type: 'string' },
                required: true,
              },
            ],
          }),
        ],
      },
    ];
    const spec = makeSpec(services, [
      {
        name: 'TokenQueryDto',
        fields: [{ name: 'code', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ]);
    const files = generateResources(services, makeCtx(spec));
    const content = files[0].content;
    expect(content).toContain('Code string `json:"code" url:"-"`');
    expect(content).not.toContain('json:"code" url:"code"');
  });

  it('emits Deprecated comment for deprecated body field in params struct', () => {
    const services: Service[] = [
      {
        name: 'Users',
        operations: [
          makeOp({
            name: 'createUser',
            httpMethod: 'post',
            path: '/users',
            requestBody: { kind: 'model', name: 'CreateUserRequest' },
          }),
        ],
      },
    ];
    const spec = makeSpec(services, [
      {
        name: 'CreateUserRequest',
        fields: [
          {
            name: 'email',
            type: { kind: 'primitive', type: 'string' },
            required: true,
            description: 'The user email.',
            deprecated: true,
          },
          {
            name: 'name',
            type: { kind: 'primitive', type: 'string' },
            required: true,
          },
        ],
      },
    ]);
    const files = generateResources(services, makeCtx(spec));
    const content = files[0].content;
    expect(content).toContain('\t// Email is the user email.\n\t//\n\t// Deprecated: this field is deprecated.');
    expect(content).not.toMatch(/Deprecated.*\n\tName/);
  });

  it('emits Deprecated comment for deprecated query param in params struct', () => {
    const services: Service[] = [
      {
        name: 'Users',
        operations: [
          makeOp({
            name: 'listUsers',
            httpMethod: 'get',
            path: '/users',
            queryParams: [
              {
                name: 'old_filter',
                type: { kind: 'primitive', type: 'string' },
                required: false,
                description: 'A legacy filter.',
                deprecated: true,
              },
              {
                name: 'limit',
                type: { kind: 'primitive', type: 'integer' },
                required: false,
              },
            ],
          }),
        ],
      },
    ];
    const spec = makeSpec(services);
    const files = generateResources(services, makeCtx(spec));
    const content = files[0].content;
    expect(content).toContain(
      '\t// OldFilter is a legacy filter.\n\t//\n\t// Deprecated: this parameter is deprecated.',
    );
    expect(content).not.toMatch(/Deprecated.*\n\tLimit/);
  });

  it('emits Deprecated note in godoc for deprecated path param', () => {
    const services: Service[] = [
      {
        name: 'Items',
        operations: [
          makeOp({
            name: 'getItem',
            httpMethod: 'get',
            path: '/items/{old_id}',
            pathParams: [
              {
                name: 'old_id',
                type: { kind: 'primitive', type: 'string' },
                required: true,
                deprecated: true,
                description: 'use new_id instead',
              },
            ],
          }),
        ],
      },
    ];
    const spec = makeSpec(services);
    const files = generateResources(services, makeCtx(spec));
    const content = files[0].content;
    expect(content).toContain('// Deprecated parameter OldID: use new_id instead');
  });

  it('emits Deprecated note in godoc for deprecated path param without description', () => {
    const services: Service[] = [
      {
        name: 'Items',
        operations: [
          makeOp({
            name: 'getItem',
            httpMethod: 'get',
            path: '/items/{old_id}',
            pathParams: [
              {
                name: 'old_id',
                type: { kind: 'primitive', type: 'string' },
                required: true,
                deprecated: true,
              },
            ],
          }),
        ],
      },
    ];
    const spec = makeSpec(services);
    const files = generateResources(services, makeCtx(spec));
    const content = files[0].content;
    expect(content).toContain('// Deprecated parameter OldID.');
  });

  it('emits Deprecated in godoc for deprecated operation', () => {
    const services: Service[] = [
      {
        name: 'Items',
        operations: [
          makeOp({
            name: 'getItem',
            httpMethod: 'get',
            path: '/items/{id}',
            pathParams: [
              {
                name: 'id',
                type: { kind: 'primitive', type: 'string' },
                required: true,
              },
            ],
            deprecated: true,
            description: 'Get an item.',
          }),
        ],
      },
    ];
    const spec = makeSpec(services);
    const files = generateResources(services, makeCtx(spec));
    const content = files[0].content;
    expect(content).toContain('// Deprecated: this operation is deprecated.');
  });

  it('uses params.Body for non-model request bodies', () => {
    const services: Service[] = [
      {
        name: 'Connect',
        operations: [
          makeOp({
            name: 'createApplications',
            httpMethod: 'post',
            path: '/connect/applications',
            requestBody: { kind: 'primitive', type: 'unknown' },
            response: { kind: 'model', name: 'ConnectApplication' },
          }),
        ],
      },
    ];
    const spec = makeSpec(services);
    const files = generateResources(services, makeCtx(spec));
    const content = files[0].content;
    expect(content).toContain('type ConnectCreateApplicationsParams struct {');
    expect(content).toContain('Body interface{} `json:"-"`');
    expect(content).toContain('request(ctx, "POST", "/connect/applications", nil, params.Body, &result, opts)');
  });

  describe('mutually-exclusive parameter groups', () => {
    const groupedOp = makeOp({
      name: 'listResources',
      httpMethod: 'get',
      path: '/authorization/organization_memberships/{organization_membership_id}/resources',
      pathParams: [{ name: 'organization_membership_id', type: { kind: 'primitive', type: 'string' }, required: true }],
      queryParams: [
        { name: 'before', type: { kind: 'primitive', type: 'string' }, required: false },
        { name: 'after', type: { kind: 'primitive', type: 'string' }, required: false },
        { name: 'limit', type: { kind: 'primitive', type: 'integer' }, required: false },
        { name: 'order', type: { kind: 'primitive', type: 'string' }, required: false },
        { name: 'permission_slug', type: { kind: 'primitive', type: 'string' }, required: true },
        { name: 'parent_resource_id', type: { kind: 'primitive', type: 'string' }, required: false },
        { name: 'parent_resource_type_slug', type: { kind: 'primitive', type: 'string' }, required: false },
        { name: 'parent_resource_external_id', type: { kind: 'primitive', type: 'string' }, required: false },
      ],
      parameterGroups: [
        {
          name: 'parent_resource',
          optional: false,
          variants: [
            {
              name: 'by_id',
              parameters: [
                { name: 'parent_resource_id', type: { kind: 'primitive', type: 'string' }, required: false },
              ],
            },
            {
              name: 'by_external_id',
              parameters: [
                { name: 'parent_resource_type_slug', type: { kind: 'primitive', type: 'string' }, required: false },
                { name: 'parent_resource_external_id', type: { kind: 'primitive', type: 'string' }, required: false },
              ],
            },
          ],
        },
      ],
      pagination: {
        strategy: 'cursor' as const,
        param: 'after',
        dataPath: 'data',
        itemType: { kind: 'model' as const, name: 'AuthorizationResource' },
      },
    });

    function makeGroupedServices(): Service[] {
      return [{ name: 'Authorization', operations: [groupedOp] }];
    }

    it('generates a sealed interface for the parameter group', () => {
      const services = makeGroupedServices();
      const spec = makeSpec(services);
      const files = generateResources(services, makeCtx(spec));
      const content = files[0].content;

      // Interface declaration with unexported marker + applyToQuery
      expect(content).toContain('type AuthorizationParentResource interface {');
      expect(content).toContain('isAuthorizationParentResource()');
      expect(content).toContain('applyToQuery(url.Values)');
    });

    it('generates variant structs with shortened field names', () => {
      const services = makeGroupedServices();
      const spec = makeSpec(services);
      const files = generateResources(services, makeCtx(spec));
      const content = files[0].content;

      // ByID variant
      expect(content).toContain('type AuthorizationParentResourceByID struct {');
      expect(content).toContain('\tID string');

      // ByExternalID variant
      expect(content).toContain('type AuthorizationParentResourceByExternalID struct {');
      expect(content).toContain('\tTypeSlug string');
      expect(content).toContain('\tExternalID string');
    });

    it('generates marker methods on each variant', () => {
      const services = makeGroupedServices();
      const spec = makeSpec(services);
      const files = generateResources(services, makeCtx(spec));
      const content = files[0].content;

      expect(content).toContain('func (p AuthorizationParentResourceByID) isAuthorizationParentResource()');
      expect(content).toContain('func (p AuthorizationParentResourceByExternalID) isAuthorizationParentResource()');
    });

    it('generates applyToQuery methods using original wire names', () => {
      const services = makeGroupedServices();
      const spec = makeSpec(services);
      const files = generateResources(services, makeCtx(spec));
      const content = files[0].content;

      // ByID variant sets parent_resource_id
      expect(content).toContain('func (p AuthorizationParentResourceByID) applyToQuery(v url.Values)');
      expect(content).toContain('v.Set("parent_resource_id", p.ID)');

      // ByExternalID variant sets both wire-name params
      expect(content).toContain('func (p AuthorizationParentResourceByExternalID) applyToQuery(v url.Values)');
      expect(content).toContain('v.Set("parent_resource_type_slug", p.TypeSlug)');
      expect(content).toContain('v.Set("parent_resource_external_id", p.ExternalID)');
    });

    it('params struct uses group interface instead of flat pointers', () => {
      const services = makeGroupedServices();
      const spec = makeSpec(services);
      const files = generateResources(services, makeCtx(spec));
      const content = files[0].content;

      // Should have the group field
      expect(content).toContain('ParentResource AuthorizationParentResource `url:"-" json:"-"`');

      // Should NOT have the flat pointer fields
      expect(content).not.toMatch(/ParentResourceID\s+\*string/);
      expect(content).not.toMatch(/ParentResourceTypeSlug\s+\*string/);
      expect(content).not.toMatch(/ParentResourceExternalID\s+\*string/);

      // Should still have non-grouped params
      expect(content).toContain('PermissionSlug string');
      expect(content).toContain('PaginationParams');
    });

    it('method body builds url.Values and calls applyToQuery', () => {
      const services = makeGroupedServices();
      const spec = makeSpec(services);
      const files = generateResources(services, makeCtx(spec));
      const content = files[0].content;

      // Should build url.Values manually
      expect(content).toContain('query := url.Values{}');
      // Should encode the non-grouped required param
      expect(content).toContain('query.Set("permission_slug", params.PermissionSlug)');
      // Should call applyToQuery on the group
      expect(content).toContain('params.ParentResource.applyToQuery(query)');
      // Should pass query to the iterator (not params)
      expect(content).toContain('newIterator[AuthorizationResource](ctx, s.client, "GET"');
      expect(content).toContain(', query, "after", "data", opts, nil)');
    });

    it('imports net/url when parameter groups are present', () => {
      const services = makeGroupedServices();
      const spec = makeSpec(services);
      const files = generateResources(services, makeCtx(spec));
      const content = files[0].content;

      expect(content).toContain('"net/url"');
    });

    it('emits optional variant members as trailing pointer fields omitted from the body when nil', () => {
      const services: Service[] = [
        {
          name: 'UserManagement',
          operations: [
            makeOp({
              name: 'createUser',
              httpMethod: 'post',
              path: '/user_management/users',
              requestBody: { kind: 'model', name: 'CreateUserRequest' },
              response: { kind: 'model', name: 'User' },
              parameterGroups: [
                {
                  name: 'password',
                  optional: true,
                  variants: [
                    {
                      name: 'plaintext',
                      parameters: [{ name: 'password', type: { kind: 'primitive', type: 'string' }, required: false }],
                    },
                    {
                      name: 'hashed',
                      parameters: [
                        // The optional member is listed first on purpose: the
                        // emitter must move it after the required members.
                        {
                          name: 'password_salt_position',
                          type: { kind: 'enum', name: 'CreateUserPasswordSaltPosition' },
                          required: false,
                        },
                        { name: 'password_hash', type: { kind: 'primitive', type: 'string' }, required: false },
                        {
                          name: 'password_hash_type',
                          type: { kind: 'enum', name: 'CreateUserPasswordHashType' },
                          required: false,
                        },
                      ],
                      optionalParameters: ['password_salt_position'],
                    },
                  ],
                },
              ],
            }),
          ],
        },
      ];
      const spec = makeSpec(services, [
        {
          name: 'CreateUserRequest',
          fields: [
            { name: 'email', type: { kind: 'primitive', type: 'string' }, required: true },
            { name: 'password', type: { kind: 'primitive', type: 'string' }, required: false },
            { name: 'password_hash', type: { kind: 'primitive', type: 'string' }, required: false },
            {
              name: 'password_hash_type',
              type: { kind: 'enum', name: 'CreateUserPasswordHashType' },
              required: false,
            },
            {
              name: 'password_salt_position',
              type: { kind: 'enum', name: 'CreateUserPasswordSaltPosition' },
              required: false,
            },
          ],
        },
      ]);
      const content = generateResources(services, makeCtx(spec))[0].content;

      // Optional member is pointer-typed and trails the required members.
      expect(content).toContain(
        [
          'type UserManagementPasswordHashed struct {',
          '\tHash string',
          '\tHashType CreateUserPasswordHashType',
          '\tSaltPosition *CreateUserPasswordSaltPosition',
          '}',
        ].join('\n'),
      );

      // Required members are written unconditionally; the optional member only
      // when set, dereferenced so the body carries a value rather than a pointer.
      expect(content).toContain('\tm["password_hash"] = p.Hash');
      expect(content).toContain('\tm["password_hash_type"] = p.HashType');
      expect(content).toContain(
        ['\tif p.SaltPosition != nil {', '\t\tm["password_salt_position"] = *p.SaltPosition', '\t}'].join('\n'),
      );
    });

    it('guards optional variant members in applyToQuery', () => {
      const services: Service[] = [
        {
          name: 'Authorization',
          operations: [
            makeOp({
              name: 'listResources',
              httpMethod: 'get',
              path: '/authorization/resources',
              queryParams: [
                { name: 'parent_resource_type_slug', type: { kind: 'primitive', type: 'string' }, required: false },
                { name: 'parent_resource_external_id', type: { kind: 'primitive', type: 'string' }, required: false },
              ],
              parameterGroups: [
                {
                  name: 'parent_resource',
                  optional: true,
                  variants: [
                    {
                      name: 'by_external_id',
                      parameters: [
                        {
                          name: 'parent_resource_external_id',
                          type: { kind: 'primitive', type: 'string' },
                          required: false,
                        },
                        {
                          name: 'parent_resource_type_slug',
                          type: { kind: 'primitive', type: 'string' },
                          required: false,
                        },
                      ],
                      optionalParameters: ['parent_resource_external_id'],
                    },
                  ],
                },
              ],
            }),
          ],
        },
      ];
      const content = generateResources(services, makeCtx(makeSpec(services)))[0].content;

      expect(content).toContain(
        [
          'type AuthorizationParentResourceByExternalID struct {',
          '\tTypeSlug string',
          '\tExternalID *string',
          '}',
        ].join('\n'),
      );
      expect(content).toContain('\tv.Set("parent_resource_type_slug", p.TypeSlug)');
      expect(content).toContain(
        ['\tif p.ExternalID != nil {', '\t\tv.Set("parent_resource_external_id", *p.ExternalID)', '\t}'].join('\n'),
      );
    });

    it('leaves output unchanged when optionalParameters is absent', () => {
      const services = makeGroupedServices();
      const content = generateResources(services, makeCtx(makeSpec(services)))[0].content;

      // Declaration order follows variant.parameters and every member stays a
      // plain value written unconditionally.
      expect(content).toContain(
        ['type AuthorizationParentResourceByExternalID struct {', '\tTypeSlug string', '\tExternalID string', '}'].join(
          '\n',
        ),
      );
      expect(content).not.toContain('if p.ExternalID != nil {');
    });

    it('renames group types that would collide with a generated model', () => {
      // Mount `AuditLogs` + group `retention` derives `AuditLogsRetention`,
      // which is also the struct generated for the AuditLogsRetention model.
      // Go puts both in one package, so the group types must step aside.
      const services: Service[] = [
        {
          name: 'AuditLogs',
          operations: [
            makeOp({
              name: 'setRetention',
              httpMethod: 'put',
              path: '/organizations/{id}/audit_logs_retention',
              pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
              requestBody: { kind: 'model', name: 'UpdateAuditLogsRetention' },
              response: { kind: 'model', name: 'AuditLogsRetention' },
              parameterGroups: [
                {
                  name: 'retention',
                  optional: false,
                  variants: [
                    {
                      name: 'period',
                      parameters: [
                        { name: 'retention_period', type: { kind: 'primitive', type: 'string' }, required: true },
                      ],
                    },
                    {
                      name: 'period_in_days',
                      parameters: [
                        {
                          name: 'retention_period_in_days',
                          type: { kind: 'primitive', type: 'integer' },
                          required: true,
                        },
                      ],
                    },
                  ],
                },
              ],
            }),
          ],
        },
      ];
      const spec = makeSpec(services, [
        {
          name: 'AuditLogsRetention',
          fields: [{ name: 'retention_period_in_days', type: { kind: 'primitive', type: 'integer' }, required: true }],
        },
        {
          name: 'UpdateAuditLogsRetention',
          fields: [
            { name: 'retention_period', type: { kind: 'primitive', type: 'string' }, required: false },
            { name: 'retention_period_in_days', type: { kind: 'primitive', type: 'integer' }, required: false },
          ],
        },
      ]);
      const content = generateResources(services, makeCtx(spec))[0].content;

      // The interface, its marker method, the variant structs, and the params
      // field all move to the disambiguated name together.
      expect(content).toContain('type AuditLogsRetentionGroup interface {');
      expect(content).toContain('isAuditLogsRetentionGroup()');
      expect(content).toContain('type AuditLogsRetentionGroupPeriod struct {');
      expect(content).toContain('type AuditLogsRetentionGroupPeriodInDays struct {');
      expect(content).toContain('Retention AuditLogsRetentionGroup `url:"-" json:"-"`');

      // Nothing may redeclare the model's name.
      expect(content).not.toContain('type AuditLogsRetention interface {');
      expect(content).not.toContain('type AuditLogsRetention struct {');
    });
  });

  it('adds NullFields and MarshalJSON for nullable optional body fields', () => {
    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [
          makeOp({
            name: 'updateOrganization',
            httpMethod: 'put',
            path: '/organizations/{id}',
            pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
            requestBody: { kind: 'model', name: 'UpdateOrganizationRequest' },
            response: { kind: 'model', name: 'Organization' },
          }),
        ],
      },
    ];
    const spec = makeSpec(services, [
      {
        name: 'UpdateOrganizationRequest',
        fields: [
          // Non-nullable optional: plain pointer + omitempty, no NullFields needed.
          { name: 'name', type: { kind: 'primitive', type: 'string' }, required: false },
          // Nullable optional: clearable via NullFields.
          {
            name: 'external_id',
            type: { kind: 'nullable', inner: { kind: 'primitive', type: 'string' } },
            required: false,
          },
        ],
      },
    ]);
    const content = generateResources(services, makeCtx(spec))[0].content;

    // Existing pointer field stays (set-a-value / omit paths unchanged).
    expect(content).toContain('ExternalID *string `json:"external_id,omitempty" url:"-"`');
    // Additive NullFields list drives explicit clearing.
    expect(content).toContain('NullFields []string `json:"-" url:"-"`');
    // MarshalJSON rewrites listed fields to JSON null.
    expect(content).toContain('MarshalJSON() ([]byte, error)');
    expect(content).toContain('for _, f := range p.NullFields {');
    expect(content).toContain('m[f] = nil');
    // Unknown/typo field names are rejected instead of silently injected.
    expect(content).toContain('nullable := map[string]bool{');
    expect(content).toContain('"external_id": true,');
    expect(content).toContain('is not a nullable field');
    // json + fmt are imported since MarshalJSON/validation need them.
    expect(content).toContain('"encoding/json"');
    expect(content).toContain('"fmt"');
  });

  it('supports NullFields on the hidden-params body struct path', () => {
    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [
          makeOp({
            name: 'updateOrganization',
            httpMethod: 'put',
            path: '/organizations/{id}',
            pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
            requestBody: { kind: 'model', name: 'UpdateOrganizationRequest' },
            response: { kind: 'model', name: 'Organization' },
          }),
        ],
      },
    ];
    const spec = makeSpec(services, [
      {
        name: 'UpdateOrganizationRequest',
        fields: [
          { name: 'name', type: { kind: 'primitive', type: 'string' }, required: false },
          {
            name: 'external_id',
            type: { kind: 'nullable', inner: { kind: 'primitive', type: 'string' } },
            required: false,
          },
        ],
      },
    ]);
    // A default hides a param, forcing the internal hidden-params body struct path.
    const ctx: EmitterContext = {
      ...makeCtx(spec),
      resolvedOperations: [
        {
          operation: services[0].operations[0],
          service: services[0],
          methodName: 'update_organization',
          mountOn: 'Organizations',
          defaults: { source: 'api' },
        } as never,
      ],
    };
    const content = generateResources(services, ctx)[0].content;

    // Internal body struct carries its own NullFields + MarshalJSON.
    expect(content).toContain('NullFields []string `json:"-"`');
    expect(content).toContain('for _, f := range b.NullFields {');
    expect(content).toContain('is not a nullable field');
    // And the params list is forwarded into the body struct.
    expect(content).toContain('body.NullFields = params.NullFields');
  });
});
