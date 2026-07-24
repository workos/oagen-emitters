import { describe, it, expect } from 'vitest';
import type { Service, Model } from '@workos/oagen';
import { generateTests } from '../../src/elixir/tests.js';
import { makeSpec, makeCtx, makeOp } from './helpers.js';

const organizationModel: Model = {
  name: 'Organization',
  fields: [
    { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
    {
      name: 'created_at',
      type: { kind: 'primitive', type: 'string', format: 'date-time' },
      required: true,
    },
  ],
};

const services: Service[] = [
  {
    name: 'Organizations',
    operations: [
      makeOp({
        name: 'listOrganizations',
        pagination: {
          strategy: 'cursor',
          param: 'after',
          dataPath: 'data',
          itemType: { kind: 'model', name: 'Organization' },
        },
      }),
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

function generate() {
  const spec = makeSpec({ services, models: [organizationModel] });
  return generateTests(spec, makeCtx(spec));
}

describe('elixir/tests', () => {
  it('emits fixtures and per-service tests only — static test scaffolding is hand-maintained', () => {
    const paths = generate().map((f) => f.path);
    expect(paths).toContain('test/support/fixtures/organizations/list_organizations.json');
    expect(paths).toContain('test/support/fixtures/organizations/get_organization.json');
    expect(paths).toContain('test/acme/organizations_test.exs');
    expect(paths).not.toContain('test/test_helper.exs');
    expect(paths).not.toContain('test/support/test_fixtures.ex');
    expect(paths).not.toContain('test/acme/client_runtime_test.exs');
  });

  it('builds paginated fixtures with a data envelope and list_metadata', () => {
    const files = generate();
    const fixture = files.find((f) => f.path === 'test/support/fixtures/organizations/list_organizations.json')!;
    const data = JSON.parse(fixture.content);
    expect(data.data).toHaveLength(1);
    expect(data.data[0].id).toBe('id');
    expect(data.data[0].created_at).toBe('2024-01-01T00:00:00.000Z');
    expect(data.list_metadata).toEqual({ before: null, after: null });
    expect(fixture.headerPlacement).toBe('skip');
  });

  it('stubs HTTP via Req.Test against the client module', () => {
    const files = generate();
    const test = files.find((f) => f.path === 'test/acme/organizations_test.exs')!.content;
    expect(test).toContain('use ExUnit.Case, async: true');
    expect(test).toContain('req_options: [plug: {Req.Test, Acme.Client}]');
    expect(test).toContain('Req.Test.stub(Acme.Client, fn conn ->');
    expect(test).toContain('Req.Test.json(conn, Acme.TestFixtures.fixture("organizations/list_organizations"))');
  });

  it('asserts struct patterns for model and page responses', () => {
    const files = generate();
    const test = files.find((f) => f.path === 'test/acme/organizations_test.exs')!.content;
    expect(test).toContain('assert {:ok, %Acme.Page{data: [%Acme.Organization{} | _]}} =');
    expect(test).toContain('assert {:ok, %Acme.Organization{}} =');
    expect(test).toContain('Acme.Organizations.get_organization(client, "test_id")');
  });

  it('stubs 204 responses for operations without fixtures', () => {
    const files = generate();
    const test = files.find((f) => f.path === 'test/acme/organizations_test.exs')!.content;
    expect(test).toContain('Plug.Conn.send_resp(conn, 204, "")');
    expect(test).toContain('assert {:ok, _} = Acme.Organizations.delete_organization(client, "test_id")');
  });

  it('includes one API error test per service', () => {
    const files = generate();
    const test = files.find((f) => f.path === 'test/acme/organizations_test.exs')!.content;
    expect(test).toContain('|> Plug.Conn.put_status(401)');
    expect(test).toContain('assert {:error, %Acme.ApiError{status: 401}} =');
  });
});
