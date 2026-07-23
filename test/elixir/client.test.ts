import { describe, it, expect } from 'vitest';
import { generateClient, normalizeVersion } from '../../src/elixir/client.js';
import { makeSpec, makeCtx } from './helpers.js';

function generate(specOverrides = {}) {
  const spec = makeSpec(specOverrides);
  return generateClient(spec, makeCtx(spec));
}

describe('elixir/client', () => {
  it('emits the full SDK scaffolding', () => {
    const files = generate();
    expect(files.map((f) => f.path)).toEqual([
      'mix.exs',
      '.formatter.exs',
      '.gitignore',
      'README.md',
      'lib/acme.ex',
      'lib/acme/client.ex',
      'lib/acme/cast.ex',
      'lib/acme/page.ex',
    ]);
  });

  it('skips the file header for non-Elixir files', () => {
    const files = generate();
    const readme = files.find((f) => f.path === 'README.md')!;
    const gitignore = files.find((f) => f.path === '.gitignore')!;
    expect(readme.headerPlacement).toBe('skip');
    expect(gitignore.headerPlacement).toBe('skip');
  });

  it('generates a mix project pinned to Elixir 1.18 with Req and no Jason', () => {
    const files = generate();
    const mix = files.find((f) => f.path === 'mix.exs')!.content;
    expect(mix).toContain('app: :acme');
    expect(mix).toContain('elixir: "~> 1.18"');
    expect(mix).toContain('{:req, "~> 0.5"}');
    expect(mix).not.toContain('jason');
    expect(mix).not.toContain('tesla');
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
    expect(client).toContain('@max_retry_delay_ms 30000');
    expect(client).toContain('retry: &retryable?/2');
  });

  it('maps status codes to error kinds from the error policy', () => {
    const files = generate();
    const client = files.find((f) => f.path === 'lib/acme/client.ex')!.content;
    expect(client).toContain('400 -> :bad_request');
    expect(client).toContain('401 -> :authentication');
    expect(client).toContain('429 -> :rate_limit_exceeded');
    expect(client).toContain('status when status >= 500 -> :server');
  });

  it('decodes JSON with the native JSON module, never Jason', () => {
    const files = generate();
    const client = files.find((f) => f.path === 'lib/acme/client.ex')!.content;
    expect(client).toContain('JSON.decode(body)');
    expect(client).toContain('JSON.encode_to_iodata!(body)');
    expect(client).toContain('decode_body: false');
    expect(client).not.toContain('Jason.');
  });

  it('uses the spec base URL and interpolated user agent', () => {
    const files = generate();
    const client = files.find((f) => f.path === 'lib/acme/client.ex')!.content;
    expect(client).toContain('@default_base_url "https://api.example.com"');
    expect(client).toContain('@user_agent_base "Test elixir/1.0.0"');
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

  it('normalizes versions to x.y.z', () => {
    expect(normalizeVersion('1.0.0')).toBe('1.0.0');
    expect(normalizeVersion('1.0')).toBe('1.0.0');
    expect(normalizeVersion('2')).toBe('2.0.0');
    expect(normalizeVersion('2026-07-01')).toBe('2026.0.0');
    expect(normalizeVersion('garbage')).toBe('0.1.0');
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

        @version "1.0.0"

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
