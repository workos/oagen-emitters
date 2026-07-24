import { describe, it, expect } from 'vitest';
import { generateClient } from '../../src/elixir/client.js';
import { makeSpec, makeCtx } from './helpers.js';

function generate(specOverrides = {}) {
  const spec = makeSpec(specOverrides);
  return generateClient(spec, makeCtx(spec));
}

describe('elixir/client', () => {
  it('emits only spec-driven scaffolding — never static project files', () => {
    const files = generate();
    expect(files.map((f) => f.path)).toEqual([
      'lib/acme.ex',
      'lib/acme/client.ex',
      'lib/acme/cast.ex',
      'lib/acme/page.ex',
    ]);
  });

  it('derives the API key env var from the namespace', () => {
    const files = generate();
    const client = files.find((f) => f.path === 'lib/acme/client.ex')!.content;
    expect(client).toContain('@api_key_env "ACME_API_KEY"');
    expect(client).toContain('raise Acme.ConfigurationError');
  });

  it('embeds the retry policy from SdkBehavior', () => {
    const files = generate();
    const client = files.find((f) => f.path === 'lib/acme/client.ex')!.content;
    expect(client).toContain('@retryable_status_codes [429, 500, 502, 503, 504]');
    expect(client).toContain('@default_max_retries 3');
    expect(client).toContain('@initial_retry_delay_ms 1000');
    expect(client).toContain('@max_retry_delay_ms 30_000');
    expect(client).toContain('retry: &retryable?/2');
  });

  it('maps status codes to error kinds from the error policy', () => {
    const files = generate();
    const client = files.find((f) => f.path === 'lib/acme/client.ex')!.content;
    expect(client).toContain('defp error_kind(400), do: :bad_request');
    expect(client).toContain('defp error_kind(401), do: :authentication');
    expect(client).toContain('defp error_kind(429), do: :rate_limit_exceeded');
    expect(client).toContain('defp error_kind(status) when status >= 500, do: :server');
  });

  it('decodes JSON with the native JSON module, never Jason', () => {
    const files = generate();
    const client = files.find((f) => f.path === 'lib/acme/client.ex')!.content;
    expect(client).toContain('JSON.decode(body)');
    expect(client).toContain('JSON.encode_to_iodata!(body)');
    expect(client).toContain('decode_body: false');
    expect(client).not.toContain('Jason.');
  });

  it('uses the spec base URL and the legacy workos-elixir UA shape', () => {
    const files = generate();
    const client = files.find((f) => f.path === 'lib/acme/client.ex')!.content;
    expect(client).toContain('@default_base_url "https://api.example.com"');
    expect(client).toContain('defp user_agent, do: "acme-elixir/#{Application.spec(:acme, :vsn)}"');
    expect(client).not.toContain('System.version()');
  });

  it('emits nil-safe Cast helpers', () => {
    const files = generate();
    const cast = files.find((f) => f.path === 'lib/acme/cast.ex')!.content;
    expect(cast).toContain('def list(values, fun) when is_list(values)');
    expect(cast).toContain('def nested(value, fun) when is_map(value)');
    expect(cast).toContain('def discriminated(map, property, mapping) when is_map(map)');
    expect(cast).toContain('def drop_nils(map) when is_map(map)');
  });

  it('emits a Page module with lazy streaming', () => {
    const files = generate();
    const page = files.find((f) => f.path === 'lib/acme/page.ex')!.content;
    expect(page).toContain('defmodule Acme.Page do');
    expect(page).toContain('def stream(%__MODULE__{} = page) do');
    expect(page).toContain('Stream.resource(');
  });

  it('renders the entry module', () => {
    const files = generate();
    expect(files.find((f) => f.path === 'lib/acme.ex')!.content).toMatchInlineSnapshot(`
      "defmodule Acme do
        @moduledoc """
        Test SDK for Elixir.

        ## Usage

            client = Acme.client(api_key: "sk_...")

        All API functions take the client as their first argument and return
        \`{:ok, result}\` or \`{:error, error}\` tuples.
        """

        @version Mix.Project.config()[:version]

        @doc "The SDK version."
        @spec version() :: String.t()
        def version, do: @version

        @doc "Builds a new API client. See \`Acme.Client.new/1\` for options."
        @spec client(keyword()) :: Acme.Client.t()
        def client(opts \\\\ []), do: Acme.Client.new(opts)
      end"
    `);
  });
});
