import { describe, it, expect } from 'vitest';
import type { Service, Model, EmitterContext } from '@workos/oagen';
import { generateResources } from '../../src/elixir/resources.js';
import { makeSpec, makeCtx, makeOp, buildResolvedOps } from './helpers.js';

const organizationModel: Model = {
  name: 'Organization',
  fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
};

/** The standard paginated list envelope the spec names as a list op's response. */
const organizationListModel: Model = {
  name: 'OrganizationList',
  fields: [
    { name: 'object', type: { kind: 'literal', value: 'list' }, required: true },
    {
      name: 'data',
      type: { kind: 'array', items: { kind: 'model', name: 'Organization' } },
      required: true,
    },
    { name: 'list_metadata', type: { kind: 'model', name: 'ListMetadata' }, required: true },
  ],
};

function ctxFor(services: Service[], models: Model[] = [organizationModel]): EmitterContext {
  return makeCtx(makeSpec({ services, models }));
}

describe('elixir/resources', () => {
  it('returns empty for no services', () => {
    expect(generateResources([], ctxFor([]))).toEqual([]);
  });

  it('generates one module per mount group with client-first functions', () => {
    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [
          makeOp({
            name: 'getOrganization',
            path: '/organizations/{id}',
            pathParams: [
              {
                name: 'id',
                type: { kind: 'primitive', type: 'string' },
                required: true,
              },
            ],
          }),
        ],
      },
    ];
    const files = generateResources(services, ctxFor(services));
    expect(files.map((f) => f.path)).toEqual(['lib/acme/organizations.ex']);
    expect(files[0].content).toContain('defmodule Acme.Organizations do');
    expect(files[0].content).toContain('def get_organization(client, id, opts \\\\ []) do');
  });

  it('URL-encodes every path parameter segment', () => {
    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [
          makeOp({
            name: 'getOrganization',
            path: '/organizations/{id}',
            pathParams: [
              {
                name: 'id',
                type: { kind: 'primitive', type: 'string' },
                required: true,
              },
            ],
          }),
        ],
      },
    ];
    const files = generateResources(services, ctxFor(services));
    expect(files[0].content).toContain('#{URI.encode(id, &URI.char_unreserved?/1)}');
  });

  it('casts model responses through Cast.nested', () => {
    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [
          makeOp({
            name: 'getOrganization',
            path: '/organizations/{id}',
            pathParams: [
              {
                name: 'id',
                type: { kind: 'primitive', type: 'string' },
                required: true,
              },
            ],
          }),
        ],
      },
    ];
    const files = generateResources(services, ctxFor(services));
    expect(files[0].content).toContain('with {:ok, body} <- Acme.Client.request(client, :get,');
    expect(files[0].content).toContain('{:ok, Acme.Cast.nested(body, &Acme.Organization.from_map/1)}');
  });

  it('generates pagination with Page.from_map and a fetch_next closure', () => {
    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [
          makeOp({
            name: 'listOrganizations',
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
        ],
      },
    ];
    const files = generateResources(services, ctxFor(services));
    const content = files[0].content;
    expect(content).toContain('def list_organizations(client, params \\\\ %{}, opts \\\\ []) do');
    expect(content).toContain('fetch_next = fn cursor ->');
    expect(content).toContain('Acme.Page.next_params(params, "after", cursor)');
    expect(content).toContain('{:ok, Acme.Page.from_map(body, "data", &Acme.Organization.from_map/1, fetch_next)}');
    expect(content).toContain('Acme.Page.t(Acme.Organization.t())');
  });

  it('unwraps a list-envelope itemType to the element caster', () => {
    // `op.pagination.itemType` is the operation *response* type, which for most
    // list endpoints is the named envelope. Page.from_map/4 casts each element,
    // so passing the envelope through makes every item parse as an empty
    // envelope with its real fields dropped.
    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [
          makeOp({
            name: 'listOrganizations',
            response: { kind: 'model', name: 'OrganizationList' },
            pagination: {
              strategy: 'cursor',
              param: 'after',
              dataPath: 'data',
              itemType: { kind: 'model', name: 'OrganizationList' },
            },
          }),
        ],
      },
    ];
    const files = generateResources(services, ctxFor(services, [organizationModel, organizationListModel]));
    const content = files[0].content;
    expect(content).toContain('{:ok, Acme.Page.from_map(body, "data", &Acme.Organization.from_map/1, fetch_next)}');
    expect(content).toContain('Acme.Page.t(Acme.Organization.t())');
    expect(content).not.toContain('&Acme.OrganizationList.from_map/1');
    expect(content).not.toContain('Acme.Page.t(Acme.OrganizationList.t())');
  });

  it('sends body params for POST and returns the raw body for primitive responses', () => {
    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [
          makeOp({
            name: 'createOrganization',
            httpMethod: 'post',
            requestBody: { kind: 'model', name: 'CreateOrganizationRequest' },
            response: { kind: 'primitive', type: 'unknown' },
          }),
        ],
      },
    ];
    const files = generateResources(services, ctxFor(services));
    const content = files[0].content;
    expect(content).toContain('def create_organization(client, params \\\\ %{}, opts \\\\ []) do');
    expect(content).toContain('Acme.Client.request(client, :post, "/organizations", params, opts)');
    // Primitive response — no with-block cast needed.
    expect(content).not.toContain('with {:ok, body}');
  });

  it('injects idempotency opts for operations that declare an idempotency key', () => {
    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [
          makeOp({
            name: 'createOrganization',
            httpMethod: 'post',
            injectIdempotencyKey: true,
            requestBody: { kind: 'model', name: 'CreateOrganizationRequest' },
          }),
        ],
      },
    ];
    const files = generateResources(services, ctxFor(services));
    expect(files[0].content).toContain('Keyword.put_new(opts, :idempotency, true)');
  });

  it('suffixes the module when a service name collides with a model', () => {
    const collisionModel: Model = {
      name: 'OrganizationMembership',
      fields: [
        {
          name: 'id',
          type: { kind: 'primitive', type: 'string' },
          required: true,
        },
      ],
    };
    const services: Service[] = [
      {
        name: 'OrganizationMembership',
        operations: [
          makeOp({
            name: 'listMemberships',
            path: '/memberships',
            response: { kind: 'model', name: 'OrganizationMembership' },
          }),
        ],
      },
    ];
    const files = generateResources(services, ctxFor(services, [collisionModel]));
    expect(files[0].path).toBe('lib/acme/organization_membership_service.ex');
    expect(files[0].content).toContain('defmodule Acme.OrganizationMembershipService do');
  });

  it('emits url-builder operations as URL functions and deduplicates method names', () => {
    const services: Service[] = [
      {
        name: 'SSO',
        operations: [
          makeOp({ name: 'getAuthorizationUrl', path: '/sso/authorize' }),
          makeOp({
            name: 'getProfile',
            path: '/sso/profile',
            response: { kind: 'model', name: 'Organization' },
          }),
          makeOp({
            name: 'getProfile',
            path: '/sso/profile-alt',
            response: { kind: 'model', name: 'Organization' },
          }),
        ],
      },
    ];
    const ctx = ctxFor(services);
    ctx.resolvedOperations = buildResolvedOps(services).map((r) =>
      r.operation.path === '/sso/authorize'
        ? { ...r, urlBuilder: true, defaults: { response_type: 'code' }, inferFromClient: ['client_id'] }
        : r,
    );
    const files = generateResources(services, ctx);
    const content = files[0].content;
    // URL builders compose a URL — they never perform an HTTP request.
    expect(content).toContain('@spec get_authorization_url(Acme.Client.t(), map()) :: String.t()');
    expect(content).toContain('def get_authorization_url(client, params \\\\ %{}) do');
    expect(content).toContain('Acme.Client.build_url(client, "/sso/authorize", params)');
    expect(content).toContain('Acme.Client.merge_defaults(%{"response_type" => "code"})');
    expect(content).toContain('Acme.Client.put_inferred("client_id", client.client_id)');
    const urlBuilderBody = content.slice(content.indexOf('def get_authorization_url'));
    expect(urlBuilderBody.slice(0, urlBuilderBody.indexOf('end'))).not.toContain('Client.request(');
    const defs = content.match(/def get_profile\(/g) ?? [];
    expect(defs).toHaveLength(1);
  });

  it('injects defaults and client-inferred fields on non-split hinted operations', () => {
    const services: Service[] = [
      {
        name: 'SSO',
        operations: [
          makeOp({
            name: 'getProfileAndToken',
            httpMethod: 'post',
            path: '/sso/token',
            requestBody: { kind: 'model', name: 'TokenRequest' },
            response: { kind: 'model', name: 'Organization' },
          }),
        ],
      },
    ];
    const ctx = ctxFor(services);
    ctx.resolvedOperations = buildResolvedOps(services).map((r) => ({
      ...r,
      defaults: { grant_type: 'authorization_code' },
      inferFromClient: ['client_id', 'client_secret'],
    }));
    const files = generateResources(services, ctx);
    const content = files[0].content;
    expect(content).toContain('Acme.Client.merge_defaults(%{"grant_type" => "authorization_code"})');
    expect(content).toContain('Acme.Client.put_inferred("client_id", client.client_id)');
    expect(content).toContain('Acme.Client.put_inferred("client_secret", client.api_key)');
  });

  it('emits union-split wrapper methods alongside the base operation', () => {
    const services: Service[] = [
      {
        name: 'UserManagement',
        operations: [
          makeOp({
            name: 'createAuthenticate',
            httpMethod: 'post',
            path: '/user_management/authenticate',
            requestBody: { kind: 'model', name: 'AuthenticateRequest' },
            response: { kind: 'model', name: 'AuthenticateResponse' },
          }),
        ],
      },
    ];
    const authResponse: Model = {
      name: 'AuthenticateResponse',
      fields: [{ name: 'user', type: { kind: 'primitive', type: 'string' }, required: true }],
    };
    const variant: Model = {
      name: 'PasswordVariant',
      fields: [
        { name: 'email', type: { kind: 'primitive', type: 'string' }, required: true },
        { name: 'password', type: { kind: 'primitive', type: 'string' }, required: true },
        { name: 'ip_address', type: { kind: 'primitive', type: 'string' }, required: false },
      ],
    };
    const ctx = ctxFor(services, [authResponse, variant]);
    ctx.resolvedOperations = buildResolvedOps(services).map((r) => ({
      ...r,
      wrappers: [
        {
          name: 'authenticate_with_password',
          targetVariant: 'PasswordVariant',
          defaults: { grant_type: 'password' },
          inferFromClient: ['client_id', 'client_secret'],
          exposedParams: ['email', 'password', 'ip_address'],
          optionalParams: ['ip_address'],
          responseModelName: 'AuthenticateResponse',
        },
      ],
    }));
    const files = generateResources(services, ctx);
    const content = files[0].content;
    // Split operations expose only their wrappers — no raw base method.
    expect(content).not.toContain('def create_authenticate(');
    expect(content).toContain('def authenticate_with_password(client, params \\\\ %{}, opts \\\\ []) do');
    // Wrapper pins the grant type and fills client credentials.
    expect(content).toContain('Acme.Client.merge_defaults(%{"grant_type" => "password"})');
    expect(content).toContain('Acme.Client.put_inferred("client_secret", client.api_key)');
    // Wrapper posts to the same path and casts the wrapper response model.
    expect(content).toContain('Acme.Client.request(client, :post, "/user_management/authenticate", params, opts)');
    expect(content).toContain('{:ok, Acme.AuthenticateResponse.t()} | {:error, Acme.Error.error()}');
    // Docs mark required vs optional exposed params.
    expect(content).toContain('Required: `:email`, `:password`.');
    expect(content).toContain('Optional: `:ip_address`.');
  });

  it('marks deprecated operations', () => {
    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [
          makeOp({
            name: 'listLegacy',
            path: '/legacy',
            deprecated: true,
            response: { kind: 'primitive', type: 'unknown' },
          }),
        ],
      },
    ];
    const files = generateResources(services, ctxFor(services));
    expect(files[0].content).toContain('@deprecated');
  });

  it('tags deprecated query params in the @doc parameter list', () => {
    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [
          makeOp({
            name: 'listOrganizations',
            queryParams: [
              {
                name: 'domain',
                type: { kind: 'primitive', type: 'string' },
                required: false,
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
    const files = generateResources(services, ctxFor(services));
    expect(files[0].content).toContain('`:domain` (deprecated)');
    expect(files[0].content).toContain('`:limit`');
    expect(files[0].content).not.toContain('`:limit` (deprecated)');
  });

  it('tags deprecated path params in the @doc parameter list', () => {
    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [
          makeOp({
            name: 'getOrganization',
            path: '/organizations/{legacy_id}',
            pathParams: [
              {
                name: 'legacy_id',
                type: { kind: 'primitive', type: 'string' },
                required: true,
                description: 'Legacy organization ID.',
                deprecated: true,
              },
            ],
          }),
        ],
      },
    ];
    const files = generateResources(services, ctxFor(services));
    expect(files[0].content).toContain('* `legacy_id` — Legacy organization ID. (deprecated)');
  });

  it('notes deprecated request-body fields on the params doc bullet', () => {
    // NB: spec-noise suffixes (`Dto`/`DTO`/`Urn…`) are already stripped upstream
    // by `schemaNameTransform` in openapi-spec/src/policy/transforms.ts, so the
    // emitter only ever sees the cleaned IR name.
    const body: Model = {
      name: 'UpdateOrganization',
      fields: [
        { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
        { name: 'domains', type: { kind: 'primitive', type: 'string' }, required: false, deprecated: true },
      ],
    };
    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [
          makeOp({
            name: 'updateOrganization',
            httpMethod: 'put',
            path: '/organizations/{id}',
            pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
            requestBody: { kind: 'model', name: 'UpdateOrganization' },
          }),
        ],
      },
    ];
    const files = generateResources(services, ctxFor(services, [organizationModel, body]));
    expect(files[0].content).toContain('Deprecated: `:domains` (see `Acme.UpdateOrganization`).');
  });

  it('omits body fields whose deprecated alias collapses onto a non-deprecated twin', () => {
    // `createdAt` is a deprecated camelCase alias of the canonical `created_at`.
    // Both snake to `created_at`; the first (non-deprecated) field wins, so the
    // surviving struct key is NOT deprecated and must not be listed.
    const body: Model = {
      name: 'CreateThing',
      fields: [
        { name: 'created_at', type: { kind: 'primitive', type: 'string' }, required: false },
        { name: 'createdAt', type: { kind: 'primitive', type: 'string' }, required: false, deprecated: true },
      ],
    };
    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [
          makeOp({
            name: 'createThing',
            httpMethod: 'post',
            path: '/things',
            requestBody: { kind: 'model', name: 'CreateThing' },
          }),
        ],
      },
    ];
    const files = generateResources(services, ctxFor(services, [organizationModel, body]));
    expect(files[0].content).not.toContain('Deprecated:');
  });

  it('renders a complete resource module', () => {
    const services: Service[] = [
      {
        name: 'Organizations',
        operations: [
          makeOp({
            name: 'getOrganization',
            path: '/organizations/{id}',
            pathParams: [
              {
                name: 'id',
                type: { kind: 'primitive', type: 'string' },
                required: true,
                description: 'Organization ID.',
              },
            ],
          }),
        ],
      },
    ];
    const files = generateResources(services, ctxFor(services));
    expect(files[0].content).toMatchInlineSnapshot(`
      "defmodule Acme.Organizations do
        @moduledoc """
        Operations for the Organizations API.
        """

        @doc """
        Get organization.

        ## Parameters

          * \`id\` — Organization ID.
          * \`opts\` — per-request options (see \`Acme.Client.request/5\`)
        """
        @spec get_organization(Acme.Client.t(), String.t(), keyword()) ::
                {:ok, Acme.Organization.t()} | {:error, Acme.Error.error()}
        def get_organization(client, id, opts \\\\ []) do
          with {:ok, body} <- Acme.Client.request(client, :get, "/organizations/#{URI.encode(id, &URI.char_unreserved?/1)}", %{}, opts) do
            {:ok, Acme.Cast.nested(body, &Acme.Organization.from_map/1)}
          end
        end
      end"
    `);
  });
});
