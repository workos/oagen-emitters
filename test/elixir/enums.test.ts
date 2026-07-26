import { describe, it, expect } from 'vitest';
import type { Enum } from '@workos/oagen';
import { generateEnums } from '../../src/elixir/enums.js';
import { makeSpec, makeCtx } from './helpers.js';

const strategy: Enum = {
  name: 'VerificationStrategy',
  values: [
    { name: 'DNS', value: 'dns' },
    { name: 'MANUAL', value: 'manual', description: 'Manual verification.' },
  ],
};

function generate(enums: Enum[]) {
  return generateEnums(enums, makeCtx(makeSpec({ enums })));
}

describe('elixir/enums', () => {
  it('returns empty for no enums', () => {
    expect(generate([])).toEqual([]);
  });

  it('writes one snake_case file per enum under lib/{namespace}/', () => {
    const files = generate([strategy]);
    expect(files.map((f) => f.path)).toEqual(['lib/acme/verification_strategy.ex']);
  });

  it('generates an atom union type with values/0, cast/1, and dump/1', () => {
    const [file] = generate([strategy]);
    expect(file.content).toContain('@type t :: :dns | :manual');
    expect(file.content).toContain('def values, do: [:dns, :manual]');
    expect(file.content).toContain('def cast("dns"), do: :dns');
    expect(file.content).toContain('def dump(:manual), do: "manual"');
  });

  it('tags deprecated values in the moduledoc value list', () => {
    const [file] = generate([
      {
        name: 'Status',
        values: [
          { name: 'ACTIVE', value: 'active' },
          { name: 'LINKED', value: 'linked', deprecated: true },
          { name: 'LEGACY', value: 'legacy', deprecated: true, description: 'Use `active` instead.' },
        ],
      },
    ]);
    expect(file.content).toContain('- `linked` — (deprecated)');
    expect(file.content).toContain('- `legacy` — (deprecated) Use `active` instead.');
    expect(file.content).not.toContain('- `active` —');
  });

  it('passes unknown wire values through for forward compatibility', () => {
    const [file] = generate([strategy]);
    expect(file.content).toContain('def cast(other), do: other');
    expect(file.content).toContain('def dump(other) when is_binary(other), do: other');
  });

  it('quotes atoms for values that are not plain identifiers', () => {
    const files = generate([
      {
        name: 'GrantType',
        values: [
          {
            name: 'URN_GRANT',
            value: 'urn:ietf:params:oauth:grant-type:token-exchange',
          },
        ],
      },
    ]);
    expect(files[0].content).toContain(':urn_grant');
    expect(files[0].content).toContain('def cast("urn:ietf:params:oauth:grant-type:token-exchange"), do: :urn_grant');
  });

  it('deduplicates repeated wire values', () => {
    const files = generate([
      {
        name: 'Dupes',
        values: [
          { name: 'A', value: 'same' },
          { name: 'B', value: 'same' },
        ],
      },
    ]);
    const casts = files[0].content.match(/def cast\("same"\)/g) ?? [];
    expect(casts).toHaveLength(1);
  });

  it('keeps numeric enums as literal unions with identity cast/dump', () => {
    const files = generate([
      {
        name: 'Priority',
        values: [
          { name: 'LOW', value: 1 },
          { name: 'HIGH', value: 2 },
        ],
      },
    ]);
    expect(files[0].content).toContain('@type t :: 1 | 2');
    expect(files[0].content).toContain('def values, do: [1, 2]');
    expect(files[0].content).toContain('def cast(value), do: value');
  });

  it('renders a complete enum module', () => {
    const files = generate([strategy]);
    expect(files[0].content).toMatchInlineSnapshot(`
      "defmodule Acme.VerificationStrategy do
        @moduledoc """
        VerificationStrategy enum.

        - \`manual\` — Manual verification.
        """

        @type t :: :dns | :manual

        @doc "All known values."
        @spec values() :: [t()]
        def values, do: [:dns, :manual]

        @doc "Casts a wire string to its atom; unknown values pass through unchanged."
        @spec cast(String.t() | nil) :: t() | String.t() | nil
        def cast("dns"), do: :dns
        def cast("manual"), do: :manual
        def cast(other), do: other

        @doc "Dumps an atom back to its wire string."
        @spec dump(t() | String.t()) :: String.t()
        def dump(:dns), do: "dns"
        def dump(:manual), do: "manual"
        def dump(other) when is_binary(other), do: other
      end"
    `);
  });
});
