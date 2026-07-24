import type { ApiSpec, EmitterContext, GeneratedFile } from '@workos/oagen';
import { toUpperSnakeCase } from '@workos/oagen';
import { errorKindAtom } from './errors.js';
import { escapeString, nsPascal } from './naming.js';

/** Elixir integer literal; credo requires underscore digit groups above 9999. */
function intLiteral(n: number): string {
  const s = String(Math.round(n));
  return s.length > 4 ? s.replace(/\B(?=(\d{3})+(?!\d))/g, '_') : s;
}

/**
 * Generate the SDK scaffolding: entry module, HTTP client, casting helpers,
 * and pagination. Everything policy-driven reads from `ctx.spec.sdk`.
 *
 * Project files (mix.exs, .formatter.exs, README, .gitignore) are static,
 * hand-maintained files in the target SDK — never emitted here.
 */
export function generateClient(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  return [
    {
      path: `lib/${ctx.namespace}.ex`,
      content: renderEntryModule(spec, ctx),
      integrateTarget: true,
      overwriteExisting: true,
    },
    {
      path: `lib/${ctx.namespace}/client.ex`,
      content: renderClientModule(spec, ctx),
      integrateTarget: true,
      overwriteExisting: true,
    },
    {
      path: `lib/${ctx.namespace}/cast.ex`,
      content: renderCastModule(ctx),
      integrateTarget: true,
      overwriteExisting: true,
    },
    {
      path: `lib/${ctx.namespace}/page.ex`,
      content: renderPageModule(ctx),
      integrateTarget: true,
      overwriteExisting: true,
    },
  ];
}

function renderEntryModule(spec: ApiSpec, ctx: EmitterContext): string {
  const ns = nsPascal(ctx);
  const lines: string[] = [];
  lines.push(`defmodule ${ns} do`);
  lines.push('  @moduledoc """');
  lines.push(`  ${escapeString(spec.name)} SDK for Elixir.`);
  lines.push('');
  lines.push('  ## Usage');
  lines.push('');
  lines.push(`      client = ${ns}.client(api_key: "sk_...")`);
  lines.push('');
  lines.push('  All API functions take the client as their first argument and return');
  lines.push('  `{:ok, result}` or `{:error, error}` tuples.');
  lines.push('  """');
  lines.push('');
  lines.push('  @version Mix.Project.config()[:version]');
  lines.push('');
  lines.push('  @doc "The SDK version."');
  lines.push('  @spec version() :: String.t()');
  lines.push('  def version, do: @version');
  lines.push('');
  lines.push(`  @doc "Builds a new API client. See \`${ns}.Client.new/1\` for options."`);
  lines.push(`  @spec client(keyword()) :: ${ns}.Client.t()`);
  lines.push(`  def client(opts \\\\ []), do: ${ns}.Client.new(opts)`);
  lines.push('end');
  return lines.join('\n');
}

/** Authorization strategy derived from the spec's auth schemes. */
function authHeaderSetup(spec: ApiSpec): {
  reqOption: string | null;
  extraHeader: string | null;
} {
  const schemes = spec.auth ?? [];
  const apiKeyHeader = schemes.find(
    (s): s is Extract<typeof s, { kind: 'apiKey' }> => s.kind === 'apiKey' && s.in === 'header',
  );
  if (schemes.some((s) => s.kind === 'bearer') || schemes.length === 0 || !apiKeyHeader) {
    return { reqOption: 'auth: {:bearer, client.api_key},', extraHeader: null };
  }
  return {
    reqOption: null,
    extraHeader: `{"${escapeString(apiKeyHeader.name.toLowerCase())}", client.api_key}`,
  };
}

function renderClientModule(spec: ApiSpec, ctx: EmitterContext): string {
  const ns = nsPascal(ctx);
  const sdk = ctx.spec.sdk;
  const retry = sdk.retry;
  const envVar = `${toUpperSnakeCase(ctx.namespace)}_API_KEY`;
  const auth = authHeaderSetup(spec);
  const autoIdempotency = sdk.idempotency.autoGenerateForPost && retry.maxRetries > 0;
  const timeoutEnvVar = sdk.timeout.timeoutEnvVar;

  const lines: string[] = [];
  lines.push(`defmodule ${ns}.Client do`);
  lines.push('  @moduledoc """');
  lines.push(`  HTTP client for the ${escapeString(spec.name)} API.`);
  lines.push('');
  lines.push('  ## Usage');
  lines.push('');
  lines.push(`      client = ${ns}.Client.new(api_key: "sk_...")`);
  lines.push('');
  lines.push(`  The API key falls back to the \`${envVar}\` environment variable.`);
  lines.push('');
  lines.push('  ## Options for `new/1`');
  lines.push('');
  lines.push('    * `:api_key` — API key (required unless the env var is set)');
  lines.push('    * `:base_url` — override the API base URL');
  lines.push('    * `:timeout` — receive timeout in milliseconds');
  lines.push('    * `:max_retries` — maximum retry attempts for retryable failures');
  lines.push('    * `:req_options` — extra `Req` options merged into every request');
  lines.push('      (advanced; used by tests to inject `plug: {Req.Test, ...}`)');
  lines.push('  """');
  lines.push('');
  if (autoIdempotency) {
    lines.push('  import Bitwise');
    lines.push('');
  }
  lines.push('  defstruct [:api_key, :base_url, :timeout, :max_retries, :req_options]');
  lines.push('');
  lines.push('  @type t :: %__MODULE__{');
  lines.push('          api_key: String.t(),');
  lines.push('          base_url: String.t(),');
  lines.push('          timeout: pos_integer(),');
  lines.push('          max_retries: non_neg_integer(),');
  lines.push('          req_options: keyword()');
  lines.push('        }');
  lines.push('');
  lines.push(`  @api_key_env "${envVar}"`);
  lines.push(`  @default_base_url "${escapeString(spec.baseUrl)}"`);
  lines.push(`  @default_timeout_ms ${intLiteral(sdk.timeout.defaultTimeoutSeconds * 1000)}`);
  lines.push(`  @default_max_retries ${retry.maxRetries}`);
  lines.push(`  @retryable_status_codes [${retry.retryableStatusCodes.join(', ')}]`);
  lines.push(`  @initial_retry_delay_ms ${intLiteral(retry.backoff.initialDelay * 1000)}`);
  lines.push(`  @retry_multiplier ${retry.backoff.multiplier}`);
  lines.push(`  @max_retry_delay_ms ${intLiteral(retry.backoff.maxDelay * 1000)}`);
  lines.push(`  @retry_jitter ${retry.backoff.jitterFactor}`);
  lines.push(`  @idempotency_header "${escapeString(sdk.idempotency.headerName.toLowerCase())}"`);
  lines.push(`  @request_id_header "${escapeString(sdk.telemetry.requestIdHeader.toLowerCase())}"`);
  lines.push('');

  // new/1
  lines.push('  @doc """');
  lines.push('  Builds a new client. See the module documentation for options.');
  lines.push('  """');
  lines.push('  @spec new(keyword()) :: t()');
  lines.push('  def new(opts \\\\ []) do');
  lines.push('    api_key = opts[:api_key] || System.get_env(@api_key_env)');
  lines.push('');
  lines.push('    if !(is_binary(api_key) and api_key != "") do');
  lines.push(`      raise ${ns}.ConfigurationError,`);
  lines.push(`        message: "Missing API key. Pass \`api_key:\` to ${ns}.Client.new/1 or set ${envVar}."`);
  lines.push('    end');
  lines.push('');
  lines.push('    %__MODULE__{');
  lines.push('      api_key: api_key,');
  lines.push('      base_url: String.trim_trailing(opts[:base_url] || @default_base_url, "/"),');
  if (timeoutEnvVar) {
    lines.push(`      timeout: opts[:timeout] || env_timeout() || @default_timeout_ms,`);
  } else {
    lines.push('      timeout: opts[:timeout] || @default_timeout_ms,');
  }
  lines.push('      max_retries: opts[:max_retries] || @default_max_retries,');
  lines.push('      req_options: opts[:req_options] || []');
  lines.push('    }');
  lines.push('  end');
  lines.push('');

  // request/5
  lines.push('  @doc """');
  lines.push('  Performs an HTTP request against the API.');
  lines.push('');
  lines.push('  `params` is sent as query parameters for GET/DELETE/HEAD requests and as a');
  lines.push('  JSON body otherwise. Per-request options:');
  lines.push('');
  lines.push('    * `:headers` — extra headers, as a list of `{name, value}` tuples');
  lines.push('    * `:idempotency_key` — explicit idempotency key header value');
  lines.push('    * `:timeout` — per-request receive timeout in milliseconds');
  lines.push('    * `:query` — extra query parameters for requests whose `params` is a body');
  lines.push('  """');
  lines.push('  @spec request(t(), atom(), String.t(), map(), keyword()) ::');
  lines.push(`          {:ok, term()} | {:error, ${ns}.Error.error()}`);
  lines.push('  def request(%__MODULE__{} = client, method, path, params \\\\ %{}, opts \\\\ []) do');
  lines.push('    params = Map.new(params || %{}, fn {k, v} -> {to_string(k), v} end)');
  lines.push('    query_method? = method in [:get, :delete, :head]');
  lines.push('');
  lines.push('    query =');
  lines.push('      if query_method?,');
  lines.push('        do: params,');
  lines.push('        else: Map.new(opts[:query] || %{}, fn {k, v} -> {to_string(k), v} end)');
  lines.push('');
  lines.push('    body = if query_method?, do: nil, else: params');
  lines.push('');
  lines.push('    req_options =');
  lines.push('      [');
  lines.push('        method: method,');
  lines.push('        url: path,');
  lines.push('        base_url: client.base_url,');
  if (auth.reqOption) {
    lines.push(`        ${auth.reqOption}`);
  }
  lines.push('        headers: build_headers(client, method, opts),');
  lines.push('        receive_timeout: opts[:timeout] || client.timeout,');
  lines.push('        retry: &retryable?/2,');
  lines.push('        retry_delay: &retry_delay/1,');
  lines.push('        max_retries: client.max_retries,');
  lines.push('        decode_body: false');
  lines.push('      ]');
  lines.push('      |> put_query(query)');
  lines.push('      |> put_body(body)');
  lines.push('');
  lines.push('    req = Req.new(req_options) |> Req.merge(client.req_options)');
  lines.push('');
  lines.push('    req |> Req.request() |> handle_response()');
  lines.push('  end');
  lines.push('');
  lines.push('  defp handle_response({:ok, %Req.Response{status: status} = response})');
  lines.push('       when status in 200..299,');
  lines.push('       do: {:ok, decode_body(response)}');
  lines.push('');
  lines.push('  defp handle_response({:ok, %Req.Response{} = response}), do: {:error, api_error(response)}');
  lines.push('');
  // Req.request/1's spec pins errors to Exception.t(); a broader
  // {:error, reason} fallback clause would trip dialyzer pattern_match_cov.
  lines.push('  defp handle_response({:error, %{__exception__: true} = exception}),');
  lines.push(`    do: {:error, %${ns}.TransportError{message: Exception.message(exception), reason: exception}}`);
  lines.push('');

  // helpers
  lines.push('  defp put_query(req_options, query) when map_size(query) == 0, do: req_options');
  lines.push('  defp put_query(req_options, query), do: Keyword.put(req_options, :params, Map.to_list(query))');
  lines.push('');
  lines.push('  defp put_body(req_options, nil), do: req_options');
  lines.push('');
  lines.push('  defp put_body(req_options, body) do');
  lines.push('    req_options');
  lines.push('    |> Keyword.put(:body, JSON.encode_to_iodata!(body))');
  lines.push('    |> Keyword.update!(:headers, &[{"content-type", "application/json"} | &1])');
  lines.push('  end');
  lines.push('');
  const clientParam = auth.extraHeader ? 'client' : '_client';
  lines.push(`  defp build_headers(${clientParam}, method, opts) do`);
  const headerParts: string[] = ['[{"user-agent", user_agent()}]'];
  if (auth.extraHeader) headerParts.push(`[${auth.extraHeader}]`);
  headerParts.push('idempotency_headers(method, opts)');
  headerParts.push('(opts[:headers] || [])');
  lines.push(`    ${headerParts.join(' ++ ')}`);
  lines.push('  end');
  lines.push('');
  const methodParam = autoIdempotency ? 'method' : '_method';
  lines.push(`  defp idempotency_headers(${methodParam}, opts) do`);
  lines.push('    cond do');
  lines.push('      is_binary(opts[:idempotency_key]) ->');
  lines.push('        [{@idempotency_header, opts[:idempotency_key]}]');
  if (autoIdempotency) {
    lines.push('');
    lines.push('      opts[:idempotency] == true and method == :post ->');
    lines.push('        [{@idempotency_header, generate_idempotency_key()}]');
  }
  lines.push('');
  lines.push('      true ->');
  lines.push('        []');
  lines.push('    end');
  lines.push('  end');
  lines.push('');
  // Matches the pre-oagen SDK's UA shape exactly: "workos-elixir/2.0.0".
  lines.push(`  defp user_agent, do: "${ctx.namespace}-elixir/#{Application.spec(:${ctx.namespace}, :vsn)}"`);
  lines.push('');

  // retry
  lines.push('  defp retryable?(_request, %Req.Response{status: status}),');
  lines.push('    do: status in @retryable_status_codes');
  lines.push('');
  if (retry.retryOnConnectionError && retry.retryOnTimeout) {
    lines.push('  defp retryable?(_request, %Req.TransportError{}), do: true');
  } else if (retry.retryOnConnectionError && !retry.retryOnTimeout) {
    lines.push('  defp retryable?(_request, %Req.TransportError{reason: :timeout}), do: false');
    lines.push('  defp retryable?(_request, %Req.TransportError{}), do: true');
  } else if (!retry.retryOnConnectionError && retry.retryOnTimeout) {
    lines.push('  defp retryable?(_request, %Req.TransportError{reason: :timeout}), do: true');
  }
  lines.push('  defp retryable?(_request, _other), do: false');
  lines.push('');
  lines.push('  defp retry_delay(attempt) do');
  lines.push('    base = min(@initial_retry_delay_ms * :math.pow(@retry_multiplier, attempt), @max_retry_delay_ms)');
  lines.push('    trunc(base + base * @retry_jitter * :rand.uniform())');
  lines.push('  end');
  lines.push('');

  // decode / errors
  lines.push('  defp decode_body(%Req.Response{body: body}) when body in [nil, ""], do: nil');
  lines.push('');
  lines.push('  defp decode_body(%Req.Response{body: body}) when is_binary(body) do');
  lines.push('    case JSON.decode(body) do');
  lines.push('      {:ok, decoded} -> decoded');
  lines.push('      {:error, _} -> body');
  lines.push('    end');
  lines.push('  end');
  lines.push('');
  lines.push('  defp decode_body(%Req.Response{body: body}), do: body');
  lines.push('');
  lines.push('  defp api_error(%Req.Response{status: status} = response) do');
  lines.push('    body = decode_body(response)');
  lines.push('');
  lines.push(`    %${ns}.ApiError{`);
  lines.push('      message: error_message(body, status),');
  lines.push('      status: status,');
  lines.push('      kind: error_kind(status),');
  lines.push('      request_id: response |> Req.Response.get_header(@request_id_header) |> List.first(),');
  lines.push('      code: if(is_map(body), do: body["code"]),');
  lines.push('      body: body');
  lines.push('    }');
  lines.push('  end');
  lines.push('');
  lines.push('  defp error_message(%{"message" => message}, _status) when is_binary(message), do: message');
  lines.push('');
  lines.push('  defp error_message(%{"error_description" => message}, _status) when is_binary(message),');
  lines.push('    do: message');
  lines.push('');
  lines.push('  defp error_message(%{"error" => message}, _status) when is_binary(message), do: message');
  lines.push('  defp error_message(_body, status), do: "HTTP " <> Integer.to_string(status)');
  lines.push('');
  const statusCodes = Object.keys(sdk.errors.statusCodeMap)
    .map(Number)
    .sort((a, b) => a - b);
  for (const status of statusCodes) {
    lines.push(`  defp error_kind(${status}), do: ${errorKindAtom(sdk.errors.statusCodeMap[status])}`);
  }
  lines.push(`  defp error_kind(status) when status >= 500, do: ${errorKindAtom(sdk.errors.serverErrorKind)}`);
  lines.push(`  defp error_kind(_status), do: ${errorKindAtom(sdk.errors.clientErrorKind)}`);

  if (timeoutEnvVar) {
    lines.push('');
    lines.push('  defp env_timeout do');
    lines.push(`    case System.get_env("${escapeString(timeoutEnvVar)}") do`);
    lines.push('      nil -> nil');
    lines.push('      value -> String.to_integer(value) * 1000');
    lines.push('    end');
    lines.push('  end');
  }

  if (autoIdempotency) {
    lines.push('');
    lines.push('  defp generate_idempotency_key do');
    lines.push('    <<a::32, b::16, c::16, d::16, e::48>> = :crypto.strong_rand_bytes(16)');
    lines.push('    c = bor(band(c, 0x0FFF), 0x4000)');
    lines.push('    d = bor(band(d, 0x3FFF), 0x8000)');
    lines.push('');
    lines.push('    ~c"~8.16.0b-~4.16.0b-~4.16.0b-~4.16.0b-~12.16.0b"');
    lines.push('    |> :io_lib.format([a, b, c, d, e])');
    lines.push('    |> to_string()');
    lines.push('  end');
  }

  lines.push('end');
  return lines.join('\n');
}

function renderCastModule(ctx: EmitterContext): string {
  const ns = nsPascal(ctx);
  const lines: string[] = [];
  lines.push(`defmodule ${ns}.Cast do`);
  lines.push('  @moduledoc """');
  lines.push('  Nil-safe casting helpers used by generated `from_map/1` and `to_map/1`');
  lines.push('  functions. Unexpected shapes pass through unchanged (lenient casting), so');
  lines.push('  new or malformed API payloads never crash the SDK.');
  lines.push('  """');
  lines.push('');
  lines.push('  @doc "Casts each element of a list with `fun`; non-lists pass through."');
  lines.push('  @spec list(term(), (term() -> term())) :: term()');
  lines.push('  def list(values, fun) when is_list(values), do: Enum.map(values, fun)');
  lines.push('  def list(other, _fun), do: other');
  lines.push('');
  lines.push('  @doc "Casts a nested map with `fun`; non-maps pass through."');
  lines.push('  @spec nested(term(), (map() -> term())) :: term()');
  lines.push('  def nested(value, fun) when is_map(value), do: fun.(value)');
  lines.push('  def nested(other, _fun), do: other');
  lines.push('');
  lines.push('  @doc "Applies an enum cast/dump function; nil passes through."');
  lines.push('  @spec enum(term(), (term() -> term())) :: term()');
  lines.push('  def enum(nil, _fun), do: nil');
  lines.push('  def enum(value, fun), do: fun.(value)');
  lines.push('');
  lines.push('  @doc "Casts each value of a map with `fun`; non-maps pass through."');
  lines.push('  @spec map_values(term(), (term() -> term())) :: term()');
  lines.push('  def map_values(map, fun) when is_map(map), do: Map.new(map, fn {k, v} -> {k, fun.(v)} end)');
  lines.push('  def map_values(other, _fun), do: other');
  lines.push('');
  lines.push('  @doc """');
  lines.push('  Dispatches a discriminated-union map to the caster for its discriminator');
  lines.push('  value. Unknown discriminator values (and non-maps) pass through unchanged.');
  lines.push('  """');
  lines.push('  @spec discriminated(term(), String.t(), %{optional(String.t()) => (map() -> term())}) :: term()');
  lines.push('  def discriminated(map, property, mapping) when is_map(map) do');
  lines.push('    case Map.fetch(mapping, Map.get(map, property)) do');
  lines.push('      {:ok, fun} -> fun.(map)');
  lines.push('      :error -> map');
  lines.push('    end');
  lines.push('  end');
  lines.push('');
  lines.push('  def discriminated(other, _property, _mapping), do: other');
  lines.push('');
  lines.push('  @doc "Dumps a struct with `fun`; nil and already-plain values pass through."');
  lines.push('  @spec dump_struct(term(), (struct() -> map())) :: term()');
  lines.push('  def dump_struct(%_{} = value, fun), do: fun.(value)');
  lines.push('  def dump_struct(other, _fun), do: other');
  lines.push('');
  lines.push('  @doc "Drops nil-valued entries from a map."');
  lines.push('  @spec drop_nils(map()) :: map()');
  lines.push('  def drop_nils(map) when is_map(map) do');
  lines.push('    map |> Enum.reject(fn {_k, v} -> is_nil(v) end) |> Map.new()');
  lines.push('  end');
  lines.push('end');
  return lines.join('\n');
}

function renderPageModule(ctx: EmitterContext): string {
  const ns = nsPascal(ctx);
  const lines: string[] = [];
  lines.push(`defmodule ${ns}.Page do`);
  lines.push('  @moduledoc """');
  lines.push('  A single page of results with lazy auto-pagination.');
  lines.push('');
  lines.push(`  Use \`${ns}.Page.stream/1\` to lazily iterate every item across all pages.`);
  lines.push('  """');
  lines.push('');
  lines.push('  defstruct [:data, :list_metadata, :fetch_next]');
  lines.push('');
  lines.push('  @type t(item) :: %__MODULE__{');
  lines.push('          data: [item],');
  lines.push('          list_metadata: map() | nil,');
  lines.push('          fetch_next: (String.t() -> {:ok, t(item)} | {:error, term()}) | nil');
  lines.push('        }');
  lines.push('');
  lines.push('  @doc false');
  lines.push(
    '  @spec from_map(map(), String.t(), (term() -> term()), (String.t() -> {:ok, t(term())} | {:error, term()}) | nil) ::',
  );
  lines.push('          t(term())');
  lines.push('  def from_map(body, data_key, cast_item, fetch_next) when is_map(body) do');
  lines.push('    %__MODULE__{');
  lines.push('      data: body |> Map.get(data_key, []) |> cast_data(cast_item),');
  lines.push('      list_metadata: body["list_metadata"] || body["listMetadata"],');
  lines.push('      fetch_next: fetch_next');
  lines.push('    }');
  lines.push('  end');
  lines.push('');
  lines.push('  def from_map(body, _data_key, _cast_item, fetch_next) do');
  lines.push('    %__MODULE__{data: List.wrap(body), list_metadata: nil, fetch_next: fetch_next}');
  lines.push('  end');
  lines.push('');
  lines.push('  defp cast_data(values, fun) when is_list(values), do: Enum.map(values, fun)');
  lines.push('  defp cast_data(_other, _fun), do: []');
  lines.push('');
  lines.push('  @doc false');
  lines.push('  @spec next_params(map() | keyword(), String.t(), String.t()) :: map()');
  lines.push('  def next_params(params, cursor_key, cursor) do');
  lines.push('    params');
  lines.push('    |> Map.new(fn {k, v} -> {to_string(k), v} end)');
  lines.push('    |> Map.put(cursor_key, cursor)');
  lines.push('  end');
  lines.push('');
  lines.push('  @doc "The cursor for the next page, or nil when this is the last page."');
  lines.push('  @spec after_cursor(t(term())) :: String.t() | nil');
  lines.push('  def after_cursor(%__MODULE__{list_metadata: meta}) when is_map(meta), do: meta["after"]');
  lines.push('  def after_cursor(%__MODULE__{}), do: nil');
  lines.push('');
  lines.push('  @doc "Whether another page is available."');
  lines.push('  @spec has_more?(t(term())) :: boolean()');
  lines.push('  def has_more?(%__MODULE__{} = page), do: after_cursor(page) != nil');
  lines.push('');
  lines.push('  @doc """');
  lines.push('  Lazily streams every item across all pages, fetching pages on demand.');
  lines.push('');
  lines.push('  Stops if a page fetch fails; use explicit pagination when you need to');
  lines.push('  distinguish errors from the end of the collection.');
  lines.push('  """');
  lines.push('  @spec stream(t(item)) :: Enumerable.t() when item: term()');
  lines.push('  def stream(%__MODULE__{} = page) do');
  lines.push('    Stream.resource(');
  lines.push('      fn -> page end,');
  lines.push('      fn');
  lines.push('        nil ->');
  lines.push('          {:halt, nil}');
  lines.push('');
  lines.push('        %__MODULE__{} = current ->');
  lines.push('          {current.data, next_page(current)}');
  lines.push('      end,');
  lines.push('      fn _ -> :ok end');
  lines.push('    )');
  lines.push('  end');
  lines.push('');
  lines.push('  defp next_page(%__MODULE__{fetch_next: fetch_next} = page) when is_function(fetch_next, 1) do');
  lines.push('    with cursor when is_binary(cursor) <- after_cursor(page),');
  lines.push('         {:ok, %__MODULE__{} = next} <- fetch_next.(cursor) do');
  lines.push('      next');
  lines.push('    else');
  lines.push('      _ -> nil');
  lines.push('    end');
  lines.push('  end');
  lines.push('');
  lines.push('  defp next_page(%__MODULE__{}), do: nil');
  lines.push('end');
  return lines.join('\n');
}
