# Elixir SDK Architecture

Fresh Scenario B design — no existing SDK surface to preserve. Replaces the hand-written
`workos-elixir` stack (Tesla + hackney + Jason, Elixir ~> 1.16) with a modern minimal-dependency
stack: **Req + built-in JSON, Elixir ~> 1.18**.

Examples below use the `WorkOS` namespace; the emitter threads `ctx.namespacePascal` for module
names and `ctx.namespace` (snake_case) for file paths and the OTP app name.

## Architecture Overview

- **Client**: `WorkOS.Client` struct built by `WorkOS.Client.new/1`. Holds `api_key`, `base_url`,
  and request options. Resource functions take the client as their first argument — there are no
  resource "accessors" (Elixir has no objects).
- **Resource modules**: one module per service (`WorkOS.Organizations`). Functions return tagged
  tuples: `{:ok, result} | {:error, error}`.
- **Models**: one module per model with `defstruct`, `@type t`, `from_map/1` (wire → struct,
  recursive), and `to_map/1` (struct → wire, drops `nil`s).
- **Enums**: one module per enum exposing an atom union `@type t`, `values/0`, `cast/1`
  (string → atom, unknown values pass through as strings for forward compatibility), and `dump/1`.
- **Pagination**: `WorkOS.Page` struct with `data`, `list_metadata`, and a `fetch_next` closure;
  `WorkOS.Page.stream/1` lazily yields items across pages via `Stream.resource/3`.
- **Errors**: tagged tuples, not raised exceptions. Error structs are `defexception`s so callers
  _may_ `raise` them, but the SDK never raises for API failures.
- **HTTP**: Req with policy-driven retries. JSON is encoded/decoded explicitly with the built-in
  `JSON` module (`decode_body: false` on Req) so the SDK never depends on Jason.
- **Casting helpers**: shared `WorkOS.Cast` module for lists, maps, nested models, and enums.

## Naming Conventions

| Concept      | Convention                | Example                                       |
| ------------ | ------------------------- | --------------------------------------------- |
| Module       | PascalCase, namespaced    | `WorkOS.Organizations`, `WorkOS.Organization` |
| Function     | snake_case                | `list/2`, `create/3`, `get/3`                 |
| Struct field | snake_case atom           | `:allow_profiles_outside_organization`        |
| File         | snake_case mirrors module | `lib/workos/organizations.ex`                 |
| Enum value   | snake_case atom           | `:dns`, `:manual`                             |
| Type         | `t/0` on each module      | `WorkOS.Organization.t()`                     |
| OTP app      | snake_case namespace      | `:workos`                                     |
| Test module  | `<Module>Test`            | `WorkOS.OrganizationsTest`                    |

Method names come from `ctx.resolvedOperations` (snake_case already) and services from `mountOn`.

## Type Mapping

| IR TypeRef            | Elixir typespec                            |
| --------------------- | ------------------------------------------ |
| `string`              | `String.t()`                               |
| `string` (date)       | `String.t()` (ISO 8601, not parsed)        |
| `string` (date-time)  | `String.t()` (ISO 8601, not parsed)        |
| `string` (uuid)       | `String.t()`                               |
| `string` (binary)     | `binary()`                                 |
| `integer`             | `integer()`                                |
| `number`              | `number()`                                 |
| `boolean`             | `boolean()`                                |
| `unknown`             | `term()`                                   |
| `array(T)`            | `[T]`                                      |
| `model(Name)`         | `WorkOS.Name.t()`                          |
| `enum(Name)`          | `WorkOS.Name.t()`                          |
| `nullable(T)`         | `T \| nil`                                 |
| `union(V1,V2)`        | `V1 \| V2`                                 |
| `map(V)`              | `%{optional(String.t()) => V}`             |
| `map(K,V)`            | `%{optional(K) => V}`                      |
| `literal("v")`        | `String.t()` (docs note the value)         |
| `literal(42)`         | `42` (numeric literals are legal in specs) |
| `literal(true/false)` | `true` / `false`                           |
| `literal(null)`       | `nil`                                      |

## Model Pattern

```elixir
defmodule WorkOS.Organization do
  @moduledoc """
  An organization within WorkOS.
  """

  alias WorkOS.Cast

  defstruct [
    :id,
    :name,
    :allow_profiles_outside_organization,
    :domains,
    :created_at,
    :updated_at,
    :external_id,
    :metadata
  ]

  @type t :: %__MODULE__{
          id: String.t(),
          name: String.t(),
          allow_profiles_outside_organization: boolean(),
          domains: [WorkOS.OrganizationDomain.t()],
          created_at: String.t(),
          updated_at: String.t(),
          external_id: String.t() | nil,
          metadata: %{optional(String.t()) => String.t()} | nil
        }

  @doc false
  @spec from_map(map()) :: t()
  def from_map(map) when is_map(map) do
    %__MODULE__{
      id: map["id"],
      name: map["name"],
      allow_profiles_outside_organization: map["allow_profiles_outside_organization"],
      domains: Cast.list(map["domains"], &WorkOS.OrganizationDomain.from_map/1),
      created_at: map["created_at"],
      updated_at: map["updated_at"],
      external_id: map["external_id"],
      metadata: map["metadata"]
    }
  end

  @doc false
  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{} = struct) do
    %{
      "id" => struct.id,
      "name" => struct.name,
      "allow_profiles_outside_organization" => struct.allow_profiles_outside_organization,
      "domains" => Cast.dump_list(struct.domains, &WorkOS.OrganizationDomain.to_map/1),
      "created_at" => struct.created_at,
      "updated_at" => struct.updated_at,
      "external_id" => struct.external_id,
      "metadata" => struct.metadata
    }
    |> Cast.drop_nils()
  end
end
```

Key points:

- No `@enforce_keys` — API payloads are cast leniently; missing keys become `nil`.
- `from_map/1` reads string keys (wire format) and recurses into nested models/enums via `Cast`.
- `to_map/1` produces string-keyed maps and drops `nil` values.
- Field order: required fields first, then optional — mirrored in `defstruct` and `@type t`.
- Generic models (`typeParams`) degrade to `term()` for the parameterized fields.

## Enum Pattern

```elixir
defmodule WorkOS.OrganizationDomainVerificationStrategy do
  @moduledoc """
  Verification strategy for organization domains.
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
end
```

- Unknown wire values pass through as strings — new API enum values never crash the SDK.
- Numeric enums (rare) generate `@type t :: 1 | 2`, `values/0`, and identity `cast/1`/`dump/1`.

## Resource Pattern

```elixir
defmodule WorkOS.Organizations do
  @moduledoc """
  Resource module for organizations.
  """

  alias WorkOS.{Client, Page}

  @doc """
  List all organizations.

  ## Parameters

    * `params` — query parameters: `:limit`, `:before`, `:after`, `:order`
    * `opts` — per-request options (see `WorkOS.Client.request/5`)
  """
  @spec list(Client.t(), map(), keyword()) ::
          {:ok, Page.t(WorkOS.Organization.t())} | {:error, WorkOS.Error.error()}
  def list(client, params \\ %{}, opts \\ []) do
    with {:ok, body} <- Client.request(client, :get, "/organizations", params, opts) do
      {:ok,
       Page.from_map(body, &WorkOS.Organization.from_map/1, fn cursor ->
         list(client, Map.put(params, :after, cursor), opts)
       end)}
    end
  end

  @doc """
  Create a new organization.
  """
  @spec create(Client.t(), map(), keyword()) ::
          {:ok, WorkOS.Organization.t()} | {:error, WorkOS.Error.error()}
  def create(client, params, opts \\ []) do
    with {:ok, body} <- Client.request(client, :post, "/organizations", params, opts) do
      {:ok, WorkOS.Organization.from_map(body)}
    end
  end

  @doc """
  Get an organization by ID.
  """
  @spec get(Client.t(), String.t(), keyword()) ::
          {:ok, WorkOS.Organization.t()} | {:error, WorkOS.Error.error()}
  def get(client, organization_id, opts \\ []) do
    path = "/organizations/" <> URI.encode_www_form(organization_id)

    with {:ok, body} <- Client.request(client, :get, path, %{}, opts) do
      {:ok, WorkOS.Organization.from_map(body)}
    end
  end

  @doc """
  Delete an organization.
  """
  @spec delete(Client.t(), String.t(), keyword()) :: {:ok, nil} | {:error, WorkOS.Error.error()}
  def delete(client, organization_id, opts \\ []) do
    path = "/organizations/" <> URI.encode_www_form(organization_id)

    with {:ok, _body} <- Client.request(client, :delete, path, %{}, opts) do
      {:ok, nil}
    end
  end
end
```

Function signature rules:

1. `client` is always the first argument.
2. Required path params follow as positional `String.t()` args, interpolated with
   `URI.encode_www_form/1`.
3. `params` map carries query params (GET/DELETE/HEAD) or the request body (POST/PUT/PATCH).
   Omitted entirely when the operation has neither. Defaults to `%{}` when all params optional;
   required when the body is required.
4. `opts` keyword list is always last: `:idempotency_key`, `:headers`, `:timeout` and other
   per-request options.
5. Returns `{:ok, struct}`, `{:ok, Page.t(item)}` for paginated lists, `{:ok, nil}` for void
   responses, `{:error, error}` on failure. Primitive/unknown responses return the decoded term.
6. Paginated operations build a `fetch_next` closure that re-invokes the same function with the
   `after` cursor merged into `params`.

## Pagination Pattern

```elixir
defmodule WorkOS.Page do
  @moduledoc """
  A single page of results with lazy auto-pagination.
  """

  defstruct [:data, :list_metadata, :fetch_next]

  @type t(item) :: %__MODULE__{
          data: [item],
          list_metadata: map() | nil,
          fetch_next: (String.t() -> {:ok, t(item)} | {:error, term()}) | nil
        }

  @doc false
  def from_map(body, cast_item, fetch_next) when is_map(body) do
    %__MODULE__{
      data: body |> Map.get("data", []) |> Enum.map(cast_item),
      list_metadata: Map.get(body, "list_metadata"),
      fetch_next: fetch_next
    }
  end

  @spec after_cursor(t(term)) :: String.t() | nil
  def after_cursor(%__MODULE__{list_metadata: meta}), do: meta && meta["after"]

  @spec has_more?(t(term)) :: boolean()
  def has_more?(page), do: after_cursor(page) != nil

  @doc "Lazily streams every item across all pages."
  @spec stream(t(item)) :: Enumerable.t(item) when item: term()
  def stream(%__MODULE__{} = page) do
    Stream.resource(
      fn -> page end,
      fn
        nil -> {:halt, nil}
        %__MODULE__{} = p ->
          next =
            case {has_more?(p), p.fetch_next} do
              {true, fetch} when is_function(fetch, 1) ->
                case fetch.(after_cursor(p)) do
                  {:ok, next_page} -> next_page
                  {:error, _} -> nil
                end
              _ -> nil
            end

          {p.data, next}
      end,
      fn _ -> :ok end
    )
  end
end
```

The `data` envelope key comes from `PaginationMeta.dataPath` (defaults to `"data"` when
undefined). Offset and link-header strategies adjust the cursor extraction accordingly.

## Error Handling

```elixir
defmodule WorkOS.Error do
  @moduledoc "Shared error type union."
  @type error :: WorkOS.ApiError.t() | WorkOS.TransportError.t()
end

defmodule WorkOS.ApiError do
  @moduledoc "A non-2xx response from the API."
  defexception [:message, :status, :kind, :request_id, :code, :body]

  @type kind ::
          :bad_request
          | :authentication
          | :not_found
          | :unprocessable_entity
          | :rate_limit
          | :server
          | :unknown

  @type t :: %__MODULE__{
          message: String.t(),
          status: pos_integer(),
          kind: kind(),
          request_id: String.t() | nil,
          code: String.t() | nil,
          body: map() | String.t() | nil
        }
end

defmodule WorkOS.TransportError do
  @moduledoc "A network-level failure (DNS, timeout, connection refused)."
  defexception [:message, :reason]
  @type t :: %__MODULE__{message: String.t(), reason: term()}
end

defmodule WorkOS.ConfigurationError do
  @moduledoc "Missing or invalid client configuration."
  defexception [:message]
  @type t :: %__MODULE__{message: String.t()}
end
```

| `kind`                  | Status  |
| ----------------------- | ------- |
| `:bad_request`          | 400     |
| `:authentication`       | 401/403 |
| `:not_found`            | 404     |
| `:unprocessable_entity` | 422     |
| `:rate_limit`           | 429     |
| `:server`               | 500+    |
| `:unknown`              | other   |

The status → kind mapping is generated from `ctx.spec.sdk.errors`. All error modules are
`defexception`s so callers can `raise` them, but SDK functions always return tagged tuples.
`WorkOS.ConfigurationError` **is** raised — from `Client.new/1` when no API key can be resolved
(programmer error, not runtime failure).

## Client Architecture

Nothing in the client layer is spec-dependent — Elixir resources are standalone
modules that take the client as their first argument, so there are no service
accessors to generate. The entry module, `client.ex`, `cast.ex`, `page.ex`, and
`errors.ex` are hand-maintained in the target SDK (`@oagen-ignore-file`);
`generateClient` and `generateErrors` return `[]`.

```elixir
defmodule WorkOS.Client do
  @moduledoc """
  WorkOS API client.

  ## Usage

      client = WorkOS.Client.new(api_key: "sk_...")
      {:ok, page} = WorkOS.Organizations.list(client)

  The API key falls back to the `WORKOS_API_KEY` environment variable.
  """

  defstruct [:api_key, :base_url, :timeout, :max_retries, :req_options]

  @type t :: %__MODULE__{
          api_key: String.t(),
          base_url: String.t(),
          timeout: pos_integer(),
          max_retries: non_neg_integer(),
          req_options: keyword()
        }

  @base_url "https://api.workos.com"

  @spec new(keyword()) :: t()
  def new(opts \\ []) do
    api_key = opts[:api_key] || System.get_env("WORKOS_API_KEY") ||
      raise WorkOS.ConfigurationError, message: "Missing API key ..."
    # base_url / timeout / max_retries defaults from SdkBehavior; req_options
    # is a test/advanced escape hatch merged into every request (e.g. plug: {Req.Test, ...}).
    ...
  end

  @spec request(t(), atom(), String.t(), map(), keyword()) ::
          {:ok, map() | list() | String.t() | nil} | {:error, WorkOS.Error.error()}
  def request(client, method, path, params, opts \\ []) do
    # 1. query params (GET/DELETE/HEAD) or JSON body (POST/PUT/PATCH)
    # 2. headers: authorization, user-agent, idempotency-key
    # 3. Req.request with retry policy; decode_body: false
    # 4. decode with JSON.decode/1; 2xx -> {:ok, body}, else {:error, ApiError/TransportError}
    ...
  end
end
```

- **JSON**: bodies are encoded with `JSON.encode_to_iodata!/1` and responses decoded with
  `JSON.decode/1` (built into Elixir 1.18+). Req is configured with `decode_body: false` so the
  SDK controls decoding and never touches Jason.
- **Auth**: `Authorization: Bearer <api_key>` from the spec's auth scheme.
- **User-Agent**: from `ctx.spec.sdk.userAgent` template (e.g. `workos-elixir/<version>`).
- **Idempotency**: `Idempotency-Key` header injected for operations with
  `injectIdempotencyKey` — from `opts[:idempotency_key]` or an auto-generated UUID when the
  policy enables auto-generation.

## Retry Logic

Generated from `ctx.spec.sdk.retry`:

- Retryable statuses (default `429, 500, 502, 503, 504`) and transport errors trigger a retry.
- `max_retries` from policy (default 3), exponential backoff with jitter via Req's
  `retry_delay` function; `Retry-After` respected on 429 (Req honors it natively).
- Implemented with Req's `retry: &retryable?/1` + `max_retries:` options — no hand-rolled loop.

## Testing Pattern

Framework: **ExUnit** with **Req.Test** plug stubs (no real HTTP, `async: true` everywhere).

```elixir
defmodule WorkOS.OrganizationsTest do
  use ExUnit.Case, async: true

  setup do
    client =
      WorkOS.Client.new(
        api_key: "sk_test_key",
        req_options: [plug: {Req.Test, WorkOS.Client}]
      )

    {:ok, client: client}
  end

  test "list/3 returns a page of organizations", %{client: client} do
    Req.Test.stub(WorkOS.Client, fn conn ->
      Req.Test.json(conn, WorkOS.TestFixtures.fixture("organizations/list"))
    end)

    assert {:ok, %WorkOS.Page{data: [%WorkOS.Organization{} = org | _]}} =
             WorkOS.Organizations.list(client)

    assert org.id
  end

  test "list/3 surfaces API errors", %{client: client} do
    Req.Test.stub(WorkOS.Client, fn conn ->
      conn
      |> Plug.Conn.put_status(401)
      |> Req.Test.json(%{"message" => "Unauthorized"})
    end)

    assert {:error, %WorkOS.ApiError{status: 401, kind: :authentication}} =
             WorkOS.Organizations.list(client)
  end
end
```

- Fixtures: JSON files at `test/support/fixtures/{service}/{method}.json`, loaded by a generated
  `WorkOS.TestFixtures` helper (`test/support/test_fixtures.ex`).
- `Req.Test` requires `plug` (test-only dep) for `Plug.Conn` manipulation.

## Directory Structure

Files marked `[hand]` are hand-maintained in the target SDK with
`@oagen-ignore-file` — the writer never overwrites them and the manifest prune
preserves them. Everything else is regenerated on every run.

```
{output}/
├── mix.exs                          # [hand] package manifest (app: :{namespace})
├── .formatter.exs                   # [hand]
├── README.md                        # [hand]
├── lib/
│   ├── {namespace}.ex               # [hand] entry module: version/0 + moduledoc
│   └── {namespace}/
│       ├── client.ex                # [hand] Client struct + request/5
│       ├── cast.ex                  # [hand] shared casting helpers
│       ├── page.ex                  # [hand] pagination
│       ├── errors.ex                # [hand] Error, ApiError, TransportError, ConfigurationError
│       ├── {service}.ex             # one resource module per service
│       ├── {model}.ex               # one module per model
│       └── {enum}.ex                # one module per enum
└── test/
    ├── test_helper.exs              # [hand]
    ├── support/
    │   ├── test_fixtures.ex         # [hand] fixture loader
    │   └── fixtures/{service}/{method}.json
    └── {namespace}/
        ├── client_runtime_test.exs  # [hand] runtime-contract tests
        └── {service}_test.exs
```

The "barrel" for Elixir is the module system itself — `lib/{namespace}.ex` is the entry module
and every public module is addressable by name. `mix.exs` is the manifest the extractor uses.

## mix.exs

```elixir
defp deps do
  [
    {:req, "~> 0.5"},
    {:plug, "~> 1.16", only: :test},
    {:ex_doc, "~> 0.34", only: :dev, runtime: false},
    {:credo, "~> 1.7", only: [:dev, :test], runtime: false},
    {:dialyxir, "~> 1.4", only: [:dev, :test], runtime: false}
  ]
end
```

`elixir: "~> 1.18"` — required for the built-in `JSON` module. No Jason, no hackney.

## Structural Guidelines

| Category          | Choice                                                 |
| ----------------- | ------------------------------------------------------ |
| Testing Framework | ExUnit (`async: true`)                                 |
| HTTP Mocking      | Req.Test plug stubs                                    |
| Documentation     | ExDoc — `@moduledoc` / `@doc` on everything            |
| Type Signatures   | `@spec` on every public function; `@type t` per module |
| Linting           | Credo                                                  |
| Formatting        | `mix format` (`.formatter.exs` emitted)                |
| HTTP Client       | Req ~> 0.5                                             |
| JSON Parsing      | Built-in `JSON` module (Elixir 1.18+)                  |
| Package Manager   | Hex / mix                                              |
| Build Tool        | mix                                                    |
| Models            | structs + `from_map/1` / `to_map/1`                    |
| Enums             | atom unions with `cast/1` / `dump/1`                   |
| Elixir Version    | `~> 1.18`                                              |
