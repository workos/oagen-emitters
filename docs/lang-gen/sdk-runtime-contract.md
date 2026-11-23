# Cross-Language SDK Runtime Contract

Use this file as the default quality bar for every emitter and generated SDK, regardless of language.

The goal is to prevent a generated SDK from being "surface-complete but behavior-incomplete".

## 1. Client State and Configuration

- The main client must be instance-scoped. Credentials, base URL, retry configuration, and service wiring must live on the client instance.
- Do not use mutable global, static, or module-level auth/config state unless it is an explicit backward-compatibility shim.
- If compatibility shims exist, they must not become the source of truth for new generated methods.
- Operations that need `client_id`, `client_secret`, API key, or similar client config must read them from the client instance or validated request context.
- An operation that sends the API key as `client_secret` must not read the key itself. It calls the client's hand-written client-secret accessor (see [Client Secret Accessor](#client-secret-accessor)), which decides what a client without an API key does.
- Per-request options must be supported consistently across the runtime and generated methods. At minimum, support:
  - extra headers
  - timeout override
  - retry override
  - base URL override
  - idempotency key override

### Client Secret Accessor

Sign-in and token-exchange operations authenticate the application by sending the API key in the request as `client_secret` (`inferFromClient: ['client_secret']` in the operation hints). Not every client has an API key, and what a client without one should do is a property of the client, not of the operation. Generated code therefore asks the client, through one hand-written accessor per SDK, and contains no rule of its own.

The accessor has three outcomes:

- The client has an API key: return it.
- The client has no API key and may make the call without a client secret (a public client running a PKCE flow): return the value that leaves `client_secret` out of the request.
- The client has no API key and can never make the call: fail before any request is sent, with the SDK's configuration error.

Most accessors take the name of the calling method, for their error message. The emitter passes the name as the SDK spells it.

| Language | Generated call                                         | Accessor returns              | Leaves the field out | Failure                  |
| -------- | ------------------------------------------------------ | ----------------------------- | -------------------- | ------------------------ |
| Go       | `s.client.clientSecret("Method")`                      | `(string, error)`             | `""`                 | error, returned as-is    |
| Python   | `self._client._client_secret("method")`                | `Optional[str]`               | `None`               | raises                   |
| Ruby     | `@client.client_secret('method')`                      | `String` or `nil`             | `nil`                | raises                   |
| PHP      | `$this->client->requireApiKey()`                       | `string`                      | never                | throws                   |
| .NET     | `this.Client.GetClientSecret()`                        | `string`                      | never                | throws                   |
| Kotlin   | `workos.clientSecret("method")`                        | `String?`                     | `null`               | throws                   |
| Elixir   | `Client.put_client_secret(params, client, "function")` | the params map                | map unchanged        | raises                   |
| Rust     | `self.client.client_secret("method")?`                 | `Result<Option<&str>, Error>` | `None`               | `Err`, propagated by `?` |

Notes:

- Go returns the accessor's error from the generated method, so only an operation with a request body can infer `client_secret`. Inferring it into a query string fails generation: a URL builder returns a bare string and a paginated method an iterator, and neither can return the error.
- .NET passes no argument. The accessor declares `[CallerMemberName] string method = ""`, and the compiler supplies the name.
- PHP's `requireApiKey()` predates this contract. It takes no method name and refuses every client without an API key, public clients included: those exchange codes through the hand-maintained PKCE helper.
- Elixir's accessor takes and returns the params map so that it can keep a `client_secret` the caller passed, as `put_inferred/3` does for other fields.
- Where a caller can supply the secret another way (Ruby's `request_options[:api_key]`, an override parameter of a URL builder), generated code checks that first and does not call the accessor.
- The iOS and Android SDKs are public-client SDKs and read the configured key directly. The Node SDK's sign-in methods are hand-maintained.

## 2. HTTP Runtime Behavior

- Each language should have a hand-maintained base runtime file or module marked with `@oagen-ignore-file` or the language-equivalent ignore marker.
- The runtime must implement:
  - request execution
  - retry policy
  - error translation
  - pagination helpers
  - connection cleanup / async context support where applicable
- Retry policy must:
  - use exponential backoff with jitter
  - retry retryable transport failures and 429/5xx responses
  - honor `Retry-After` when present
- If retries are enabled for `POST` requests and no explicit idempotency key is provided, the runtime should generate one automatically unless the language/runtime has a documented reason not to.

## 3. Error Mapping

- The runtime must translate transport and API failures into SDK-native error classes, not leak raw HTTP-library exceptions as the primary public contract.
- Error classes should preserve, where possible:
  - status code
  - request ID
  - message
  - API error code
  - parameter name
  - raw response body / parsed response
- Generated docs and tests must match the actual error mapping implemented by the runtime.

## 4. Pagination

- List endpoints must return a typed page or collection wrapper, not a raw map or array.
- The wrapper must carry pagination metadata and a fetch-next-page callback or equivalent continuation mechanism.
- Auto-pagination must actually fetch subsequent pages, not merely expose cursor metadata.
- If the language or baseline SDK supports reverse pagination, preserve it.

## 5. Models and Serialization

- Generated models must be strongly typed and deserialize nested models recursively.
- Missing required fields should fail loudly unless the spec or baseline contract explicitly requires a fallback.
- Unknown enum values should be preserved when that is the existing SDK contract or the language ecosystem norm.
- Request serialization must preserve typed values and avoid silently dropping structured fields.

## 6. Generated Test Minimums

The generated SDK test suite must include more than existence checks.

For every language, require:

- Per-service success tests that assert:
  - response type
  - at least one meaningful field value
  - request method
  - request path
  - request body or query encoding when relevant
- Error-path tests for:
  - 401
  - 404
  - 429
  - 500
  - 400 and 422 for write operations where applicable
- Pagination tests for:
  - empty page
  - multi-page auto-pagination
- Model round-trip or serialization tests
- Query encoding tests for optional parameters, enums, arrays, and special characters where relevant

Anti-patterns:

- Do not rely on tests that only assert object existence.
- Do not treat "returns the right class" as sufficient pagination coverage.
- Do not claim per-request options support unless there is a test proving the runtime honors it.

## 7. Review Expectations

When reviewing a generated SDK, explicitly verify:

- client state is instance-scoped
- runtime options are actually honored, not just typed
- typed errors are actually thrown
- auto-pagination is wired and tested
- generated tests exercise behavior, not just shape

If any of these fail, treat it as an emitter/runtime defect even if lint, typecheck, and the current test suite pass.
