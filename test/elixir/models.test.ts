import { describe, it, expect } from 'vitest';
import type { Model } from '@workos/oagen';
import { generateModels } from '../../src/elixir/models.js';
import { makeSpec, makeCtx } from './helpers.js';

const organization: Model = {
  name: 'Organization',
  description: 'An organization.',
  fields: [
    { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
    {
      name: 'name',
      type: { kind: 'primitive', type: 'string' },
      required: true,
    },
    {
      name: 'domains',
      type: {
        kind: 'array',
        items: { kind: 'model', name: 'OrganizationDomain' },
      },
      required: true,
    },
    {
      name: 'state',
      type: { kind: 'enum', name: 'OrganizationState' },
      required: false,
    },
    {
      name: 'external_id',
      type: { kind: 'nullable', inner: { kind: 'primitive', type: 'string' } },
      required: false,
    },
    {
      name: 'metadata',
      type: { kind: 'map', valueType: { kind: 'primitive', type: 'string' } },
      required: false,
    },
    {
      name: 'employee_count',
      type: { kind: 'primitive', type: 'integer' },
      required: false,
    },
  ],
};

const organizationDomain: Model = {
  name: 'OrganizationDomain',
  fields: [
    {
      name: 'domain',
      type: { kind: 'primitive', type: 'string' },
      required: true,
    },
  ],
};

function generate(models: Model[]) {
  const spec = makeSpec({
    models,
    enums: [
      {
        name: 'OrganizationState',
        values: [
          { name: 'ACTIVE', value: 'active' },
          { name: 'INACTIVE', value: 'inactive' },
        ],
      },
    ],
  });
  return generateModels(models, makeCtx(spec));
}

describe('elixir/models', () => {
  it('returns empty for no models', () => {
    expect(generateModels([], makeCtx(makeSpec()))).toEqual([]);
  });

  it('writes one snake_case file per model under lib/{namespace}/', () => {
    const files = generate([organization, organizationDomain]);
    expect(files.map((f) => f.path)).toEqual(['lib/acme/organization.ex', 'lib/acme/organization_domain.ex']);
  });

  it('threads the namespace into the module name', () => {
    const [file] = generate([organization, organizationDomain]);
    expect(file.content).toContain('defmodule Acme.Organization do');
    expect(file.content).not.toContain('WorkOS');
  });

  it('orders required fields before optional ones in defstruct and @type t', () => {
    const [file] = generate([organization, organizationDomain]);
    const structIdx = file.content.indexOf(':domains');
    const optionalIdx = file.content.indexOf(':state');
    expect(structIdx).toBeGreaterThan(-1);
    expect(optionalIdx).toBeGreaterThan(structIdx);
  });

  it('maps types to Elixir typespecs, adding | nil for optional fields', () => {
    const [file] = generate([organization, organizationDomain]);
    expect(file.content).toContain('id: String.t()');
    expect(file.content).toContain('domains: [Acme.OrganizationDomain.t()]');
    expect(file.content).toContain('state: Acme.OrganizationState.t() | nil');
    expect(file.content).toContain('external_id: String.t() | nil');
    expect(file.content).toContain('metadata: %{optional(String.t()) => String.t()} | nil');
    expect(file.content).toContain('employee_count: integer() | nil');
  });

  it('casts nested models, enums, and arrays in from_map/1', () => {
    const [file] = generate([organization, organizationDomain]);
    expect(file.content).toContain('domains: Acme.Cast.list(map["domains"], &Acme.OrganizationDomain.from_map/1)');
    expect(file.content).toContain('state: Acme.Cast.enum(map["state"], &Acme.OrganizationState.cast/1)');
    expect(file.content).toContain('id: map["id"]');
  });

  it('dumps nested models and enums in to_map/1 and drops nils', () => {
    const [file] = generate([organization, organizationDomain]);
    expect(file.content).toContain('Acme.Cast.drop_nils(%{');
    expect(file.content).toContain('"state" => Acme.Cast.enum(struct.state, &Acme.OrganizationState.dump/1)');
    expect(file.content).toContain('"id" => struct.id');
  });

  it('dispatches discriminated unions through Cast.discriminated', () => {
    const eventModel: Model = {
      name: 'Event',
      fields: [
        {
          name: 'data',
          type: {
            kind: 'union',
            variants: [
              { kind: 'model', name: 'Organization' },
              { kind: 'model', name: 'OrganizationDomain' },
            ],
            discriminator: {
              property: 'object',
              mapping: {
                organization: 'Organization',
                organization_domain: 'OrganizationDomain',
              },
            },
          },
          required: true,
        },
      ],
    };
    const files = generate([eventModel, organization, organizationDomain]);
    const event = files.find((f) => f.path.endsWith('event.ex'))!;
    expect(event.content).toContain(
      'Acme.Cast.discriminated(map["data"], "object", %{"organization" => &Acme.Organization.from_map/1, "organization_domain" => &Acme.OrganizationDomain.from_map/1})',
    );
  });

  it('handles models with no fields', () => {
    const files = generate([{ name: 'EmptyThing', fields: [] }]);
    expect(files[0].content).toContain('defstruct []');
    expect(files[0].content).toContain('def from_map(map) when is_map(map), do: %__MODULE__{}');
  });

  it('escapes doc terminators in descriptions', () => {
    const files = generate([
      {
        name: 'Weird',
        description: 'Contains """ and #{interpolation} markers.',
        fields: [
          {
            name: 'id',
            type: { kind: 'primitive', type: 'string' },
            required: true,
          },
        ],
      },
    ]);
    expect(files[0].content).toContain('\\"\\"\\"');
    expect(files[0].content).toContain('\\#{interpolation}');
  });

  it('renders a complete model module', () => {
    const files = generate([organizationDomain]);
    expect(files[0].content).toMatchInlineSnapshot(`
      "defmodule Acme.OrganizationDomain do
        @moduledoc """
        OrganizationDomain model.
        """

        defstruct [
          :domain
        ]

        @type t :: %__MODULE__{
                domain: String.t()
              }

        @doc false
        @spec from_map(map()) :: t()
        def from_map(map) when is_map(map) do
          %__MODULE__{
            domain: map["domain"]
          }
        end

        @doc false
        @spec to_map(t()) :: map()
        def to_map(%__MODULE__{} = struct) do
          Acme.Cast.drop_nils(%{
            "domain" => struct.domain
          })
        end
      end"
    `);
  });
});
