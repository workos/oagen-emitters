# iOS / Swift SDK Architecture

Design document for the `ios` oagen emitter, which generates an idiomatic
**Swift** SDK (targeting the iOS platform and all other Apple platforms) from
the language-agnostic IR.

> **Emitter identifier:** `ios`. Target language: Swift. Emitter source lives in
> `src/ios/`; unit tests in `test/ios/`; smoke runner at `smoke/sdk-ios.ts`.

This is a **Scenario B (fresh)** emitter: there is no existing published Swift
SDK to preserve. The emitter therefore generates a **complete, self-contained,
compilable Swift Package** — including the HTTP runtime, configuration, error
types, and pagination — following the "full generation" model used by the Go
emitter (as opposed to the Kotlin emitter, which emits mergeable stubs into a
hand-maintained SDK).

Throughout this document, `{Namespace}` is `ctx.namespacePascal` (e.g. `WorkOS`)
and `{namespace}` is `ctx.namespace` (e.g. `workos`). **No SDK-specific names are
hard-coded** — everything flows from `ctx` and the IR.

---

## Structural Guidelines

| Category                   | Choice                                                                                                                                                                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Language / concurrency** | Swift, `async`/`await` (single `async throws` method per operation — no completion-handler or Combine variants)                                                                                                                                                |
| **Package manager**        | Swift Package Manager (`Package.swift`)                                                                                                                                                                                                                        |
| **Build tool**             | SPM (`swift build`)                                                                                                                                                                                                                                            |
| **swift-tools-version**    | `6.2`                                                                                                                                                                                                                                                          |
| **Platforms**              | iOS 17, macCatalyst 17, macOS 14, watchOS 10, tvOS 17, visionOS 1 (matches the Clerk iOS SDK baseline)                                                                                                                                                         |
| **HTTP client**            | `URLSession` (Foundation) — zero third-party dependencies                                                                                                                                                                                                      |
| **JSON**                   | `Codable` with generated `CodingKeys` (explicit wire-key mapping); `JSONEncoder`/`JSONDecoder`                                                                                                                                                                 |
| **Dates**                  | `Foundation.Date`, ISO-8601 with fractional-second fallback (custom encode/decode strategy in `Coding.swift`)                                                                                                                                                  |
| **Documentation**          | DocC (`///` doc comments)                                                                                                                                                                                                                                      |
| **Linting / formatting**   | `swift-format` (Apple official); the `.swift-format` config is a hand-maintained repo resource in the SDK repo (as are `script/ci` and `.gitignore`); `formatCommand` runs `swift-format -i` (or the toolchain-bundled `swift format -i`) over generated files |
| **Testing framework**      | Swift Testing (`import Testing`, `@Test`, `#expect`)                                                                                                                                                                                                           |
| **HTTP mocking (tests)**   | Custom `URLProtocol` stub (`MockURLProtocol`) — no third-party mocking dependency                                                                                                                                                                              |

---

## Architecture Overview

The generated SDK is a single SPM library target `{Namespace}`. A consumer:

```swift
import WorkOS

let client = WorkOSClient(apiKey: "sk_test_...")
let org = try await client.organizations.create(name: "Acme")
```

Layers:

1. **`{Namespace}Client`** (`{Namespace}Client.swift`) — the entry point. Holds an
   immutable `Configuration` and a `Transport`, and exposes one lazily-created
   resource accessor per **mount group** (`client.organizations`, `client.sso`, …).
2. **Resources** (`Resources/{MountGroup}.swift`) — one `struct` per mount group,
   one `async throws` method per operation. Methods flatten path/query/body
   parameters into the Swift signature and delegate to `Transport`.
3. **Transport** (`Internal/Transport.swift`) — `URLSession`-based request
   execution: URL/query/header/body assembly, retry with exponential backoff +
   jitter, response decoding, and status-code → error mapping.
4. **Models** (`Models/{Model}.swift`) — `Codable` structs.
5. **Enums** (`Enums/{Enum}.swift`) — forward-compatible `Codable` enums.
6. **Errors** (`Errors/{Namespace}Error.swift`) — the error type hierarchy.
7. **Support runtime** (`Internal/`) — `AnyCodable`, `Pagination`, `PathEncoding`,
   `Coding`, `RequestOptions`, `Configuration`.

### Mount-group architecture

Resources, client accessors, and the operations manifest are all derived from
`ctx.resolvedOperations` grouped by `mountOn` (via the shared `groupByMount` /
`scopedMountGroups` / `getMountTarget` helpers), **not** by raw IR service. This
matches the Kotlin/Go emitters and honors consumer `mountRules`/`operationHints`.
Method names come from `ResolvedOperation.methodName` (snake_case) converted to
Swift `camelCase`.

---

## Naming Conventions (`naming.ts`)

| IR concept                   | Swift form                                            | Function       |
| ---------------------------- | ----------------------------------------------------- | -------------- |
| Model / Enum / Resource type | `PascalCase` (acronyms upper-cased via `ACRONYM_SET`) | `typeName`     |
| File name                    | matches type name + `.swift`                          | `fileName`     |
| Method name                  | `camelCase`                                           | `methodName`   |
| Property / parameter         | `camelCase`, reserved words back-tick escaped         | `propertyName` |
| Resource accessor property   | `camelCase` of mount group                            | `accessorName` |

- **Acronyms:** reuse `toPascalCase`/`toCamelCase` from `@workos/oagen` (they
  merge `ACRONYM_SET` = SSO, FGA, SAML, SCIM, JWT, HMAC, M2M).
- **Reserved words:** Swift keywords used as identifiers are wrapped in back-ticks
  (`` `default` ``, `` `protocol` ``, `` `self` ``, `` `Type` ``, `` `associatedtype` ``, …).
  Note `object` is _not_ reserved in Swift (unlike Kotlin) so no rename is needed —
  but a `CodingKeys` entry still maps the property to its wire key.
- **Wire keys:** a field's `CodingKey` raw value is always the IR `field.name`
  (the wire name). The Swift property is `camelCase(field.domainName ?? field.name)`.
- **Method-name resolution:** prefer `ctx.resolvedOperations` (via the shared
  `buildResolvedLookup`/`lookupResolved`), fall back to `resolveOperations(ctx.spec)`
  when the context has none (unit tests). Uniqueness within a mount is enforced
  upstream by `assertUniqueResolvedMethods`.
- **Mount-noun trimming (`trimMountResource`):** strips the mount resource noun
  only when it directly follows the leading verb, matching word-for-word from
  the front of the mount name (singular/plural tolerant) — `listOrganizations`
  on `Organizations` → `list`, `getUserByExternalId` on `UserManagement` →
  `getByExternalId`, but `listUserAuthFactors` on `MultiFactorAuth` is left
  untouched. This mirrors the Go/Kotlin `trimMountedResourceFromMethod`
  semantics exactly so method names agree across languages. Untrimmed words
  keep their original casing, so acronyms (`updateJWTTemplate`) survive.

---

## Type Mapping (`type-map.ts`)

Implemented with the IR's `mapTypeRef` (`irMapTypeRef`) visitor.

| IR `TypeRef`                                       | Swift type                                                                                    |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `primitive` string                                 | `String`                                                                                      |
| `primitive` string, `format: date-time` / `date`   | `Date`                                                                                        |
| `primitive` string, `format: byte` / `binary`      | `Data`                                                                                        |
| `primitive` string, `format: uuid` / `uri` / `url` | `String` (lossless wire round-trip)                                                           |
| `primitive` integer                                | `Int` (64-bit on all supported platforms)                                                     |
| `primitive` number                                 | `Double`                                                                                      |
| `primitive` boolean                                | `Bool`                                                                                        |
| `primitive` unknown                                | `AnyCodable`                                                                                  |
| `array` of `T`                                     | `[T]`                                                                                         |
| `model` `Foo`                                      | `Foo`                                                                                         |
| `enum` `Foo`                                       | `Foo`                                                                                         |
| `literal`                                          | underlying scalar type of the literal (`String`/`Int`/`Double`/`Bool`); `null` → `AnyCodable` |
| `map` of `V`                                       | `[String: V]`                                                                                 |
| `nullable` of `T`                                  | `T?`                                                                                          |
| `union` (single unique variant)                    | that variant                                                                                  |
| `union` (`allOf`)                                  | first variant (merged shape)                                                                  |
| `union` (discriminated, named base model exists)   | the base model type                                                                           |
| `union` (other / heterogeneous)                    | `AnyCodable`                                                                                  |

**Optionality:** a field/parameter is Optional (`T?`) when `!required` **or** the
type is `nullable`. Optional init parameters get a `= nil` default.

> **Discriminated unions (v1):** modeled as **flat structs** — the base model is
> emitted as a `struct` carrying the superset of variant fields (all
> variant-specific fields optional), using `enrichModelsFromSpec` +
> `flattenDiscriminatedUnionFields` (same approach as Go/Kotlin base models).
> This decodes any variant losslessly and always compiles. Native Swift sum
> types (`enum` with associated values + custom `init(from:)`) are a **documented
> future enhancement** — deferred because a slightly-wrong custom decoder would
> fail wire-parity smoke tests, whereas an optional-field struct never does.

---

## Model Pattern (`models.ts`)

Each IR `Model` → one `public struct: Codable, Sendable, Equatable` file.

```swift
import Foundation

/// An organization.
public struct Organization: Codable, Sendable, Equatable {
    /// The unique identifier of the organization.
    public let id: String
    /// The name of the organization.
    public let name: String
    /// The timestamp when the organization was created.
    public let createdAt: Date?

    public init(id: String, name: String, createdAt: Date? = nil) {
        self.id = id
        self.name = name
        self.createdAt = createdAt
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case name
        case createdAt = "created_at"
    }
}
```

Rules:

- **Public initializer is required.** Swift synthesizes only an _internal_
  memberwise init; a library needs an explicit `public init`. Parameters are
  ordered **required first, then optional** (optionals get `= nil`) for ergonomics.
- **`CodingKeys`** are always generated (deterministic) so wire keys survive
  regardless of property renaming; the raw value is the IR wire name.
- **`Equatable`/`Sendable`** are added when all field types support them
  (`AnyCodable` is `Sendable` & `Equatable`, so this holds universally).
- **Deprecated fields** → `@available(*, deprecated, message: "...")` on the property.
- **Empty models** → an empty struct with an empty `public init()`.
- Discriminated-union base models are emitted as flat structs (see Type Mapping).

---

## Enum Pattern (`enums.ts`)

Forward-compatible enums (a server-added value must **not** crash decoding):

```swift
import Foundation

/// Enumeration of valid ConnectionState values.
public enum ConnectionState: RawRepresentable, Codable, Sendable, Hashable {
    case active
    case inactive
    /// A value not known at SDK generation time.
    case unknown(String)

    public init(rawValue: String) {
        switch rawValue {
        case "active": self = .active
        case "inactive": self = .inactive
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .active: return "active"
        case .inactive: return "inactive"
        case .unknown(let value): return value
        }
    }

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self.init(rawValue: raw)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}
```

- `init(rawValue:)` is **non-failable** — unknown wire values map to
  `.unknown(String)` instead of throwing. This mirrors Kotlin's `Unknown` +
  `@JsonEnumDefaultValue` sentinel.
- Explicit `init(from:)`/`encode(to:)` are generated (not relying on subtle
  stdlib `RawRepresentable` Codable conditional conformance).
- `CaseIterable` is **not** conformed (associated-value case `unknown` precludes
  synthesis). A `static let allKnownCases: [Self]` is generated for convenience.
- Integer enums use `Int` rawValue with the same pattern.
- Member names: `camelCase` of the wire value; collisions get a numeric suffix;
  numeric-leading values get a `value`-prefix.

---

## Resource / Client Pattern (`resources.ts`, `client.ts`)

### Client

```swift
public final class WorkOSClient: Sendable {
    public let configuration: Configuration
    let transport: Transport

    public init(configuration: Configuration) {
        self.configuration = configuration
        self.transport = Transport(configuration: configuration)
    }

    /// Convenience initializer.
    public convenience init(apiKey: String, baseURL: URL? = nil) {
        self.init(configuration: Configuration(apiKey: apiKey, baseURL: baseURL))
    }

    public var organizations: Organizations { Organizations(transport: transport) }
    public var sso: SSO { SSO(transport: transport) }
    // …one accessor per mount group
}
```

- `generateClient` returns the **whole** client file plus the runtime/config/
  package scaffolding (see below), all with `overwriteExisting: true` (Go pattern).
- Resource accessors are computed properties returning value-type resource
  structs that capture the shared `Transport`. (Cheap to create; no retain cycle.)

### Resource + method

```swift
public struct Organizations: Sendable {
    let transport: Transport

    /// Creates a new organization.
    /// - Parameter name: The name of the organization.
    /// - Returns: The created ``Organization``.
    public func create(
        name: String,
        domains: [String]? = nil,
        requestOptions: RequestOptions? = nil
    ) async throws -> Organization {
        var body: [String: AnyCodable] = [:]
        body["name"] = AnyCodable(name)
        if let domains { body["domains"] = AnyCodable(domains) }
        return try await transport.request(
            method: "POST",
            path: "organizations",
            query: [],
            body: body,
            options: requestOptions,
            as: Organization.self
        )
    }

    public func get(id: String, requestOptions: RequestOptions? = nil) async throws -> Organization {
        try await transport.request(
            method: "GET",
            path: "organizations/\(PathEncoding.segment(id))",
            query: [],
            body: nil,
            options: requestOptions,
            as: Organization.self
        )
    }

    public func delete(id: String, requestOptions: RequestOptions? = nil) async throws {
        try await transport.requestVoid(
            method: "DELETE",
            path: "organizations/\(PathEncoding.segment(id))",
            query: [],
            body: nil,
            options: requestOptions
        )
    }
}
```

Method construction (driven by `planOperation(op)`):

- **Path params** → interpolated into the path string, each wrapped in
  `PathEncoding.segment(...)` (SSRF-safe per-segment percent-encoding). Path
  segments come from the shared `parsePathTemplate`.
- **Query params** → appended to a `[URLQueryItem]` array, honoring `explode`
  for arrays (repeat key vs comma-join).
- **Body** → a `[String: AnyCodable]` dictionary, only including present optional
  values. `requestBodyEncoding` selects JSON (default) vs form-urlencoded.
- **Return type** → from `planOperation`: model, `[Model]` (array response),
  `Page<Item>` (paginated), or `Void` (delete / no model).
- **`requestOptions: RequestOptions? = nil`** is always the last parameter.
- **No** `@JvmOverloads`, suspend, or Java-friendly overloads (JVM-only concepts).

### Wrappers (union-split operations)

When a `ResolvedOperation` has `wrappers` (from consumer `split` hints, e.g.
`authenticate` → `authenticateWithPassword`/`authenticateWithCode`), one
`async throws` method is emitted per wrapper, each exposing only its variant's
fields and injecting `defaults` + `inferFromClient` values (read from the client
config, e.g. `transport.configuration.clientID`). Built from `ResolvedWrapper`
fields via the shared `wrapper-utils`.

### URL builders (browser-redirect operations)

`urlBuilder` operations (e.g. `GET /sso/authorize`, `GET /sso/logout`) never
issue an HTTP request: `generateResources` emits a synchronous method that
returns the assembled `URL` via `Transport.buildURL(path:query:)`. Hidden
`defaults` (`response_type=code`) and `inferFromClient` values (`client_id`,
appended only when `Configuration.clientID` is set) join the caller's query
parameters, mirroring the Go emitter's URL builders. They are still skipped in
`buildOperationsMap` and the smoke plan — there is no live HTTP call to verify.

---

## Serialization Pattern (`Internal/Coding.swift`, `Internal/AnyCodable.swift`)

- **`JSONEncoder`/`JSONDecoder`** configured once in `Transport` with a custom
  date strategy: encode ISO-8601 with fractional seconds; decode tries
  fractional-second ISO-8601 first, then plain ISO-8601, then a date-only format.
- **`AnyCodable`** — a `Sendable`, `Equatable` wrapper over arbitrary JSON
  (`null`/`Bool`/`Int`/`Double`/`String`/`[AnyCodable]`/`[String: AnyCodable]`),
  used for `unknown` primitives and heterogeneous unions. Decodes/encodes any
  JSON value losslessly.

---

## Pagination Pattern (`Internal/Pagination.swift`)

Cursor pagination (the IR's dominant strategy):

```swift
public struct Page<Element: Codable & Sendable>: Codable, Sendable {
    public let data: [Element]
    public let listMetadata: ListMetadata

    private enum CodingKeys: String, CodingKey {
        case data
        case listMetadata = "list_metadata"
    }
}

public struct ListMetadata: Codable, Sendable, Equatable {
    public let before: String?
    public let after: String?
}
```

- Paginated list methods return `Page<Item>` (item type from
  `plan.paginatedItemModelName`).
- An `AutoPagingSequence<Element>` (an `AsyncSequence`) is generated in the
  runtime for callers that want to iterate every page with `for try await`.
  List methods return a `Page`; the auto-pager is opt-in and driven by the same
  `Transport`.

---

## Error Handling (`errors.ts`)

Generated from `ctx.spec.sdk.errors` (the `ErrorPolicy.statusCodeMap`):

```swift
public struct APIError: Error, Sendable, Equatable {
    public let statusCode: Int
    public let message: String
    public let code: String?
    public let requestID: String?
    public let raw: AnyCodable?
}

public enum WorkOSError: Error, Sendable {
    /// 400 — the request was malformed.
    case badRequest(APIError)
    /// 401 — authentication failed.
    case authentication(APIError)
    /// 404 — the resource was not found.
    case notFound(APIError)
    // …one case per statusCodeMap entry
    /// 5xx — a server error.
    case server(APIError)
    /// An unrecognized non-2xx status.
    case api(APIError)
    /// A transport/connection failure.
    case network(URLError)
    /// The response body could not be decoded.
    case decoding(any Error)
    /// The response was not a valid HTTP response.
    case invalidResponse
}
```

`Transport` inspects the HTTP status, decodes the error envelope into `APIError`,
and maps the status to the appropriate `WorkOSError` case via the generated
status-code map. `errorDocUrlTemplate` (if present) is surfaced in the message.

---

## Retry Logic (`Internal/Transport.swift`)

Generated from `ctx.spec.sdk.retry` (`RetryPolicy`):

- Retry on `retryableStatusCodes` (default `[429, 500, 502, 503, 504]`), and on
  connection errors / timeouts per policy flags.
- Up to `maxRetries` (default 3) attempts.
- Exponential backoff: `initialDelay * multiplier^attempt`, capped at `maxDelay`,
  with `± jitterFactor` randomization (`Double.random` at runtime — the generated
  Swift may use randomness; the emitter itself must not).
- Honors a `Retry-After` header when present.
- Idempotency: for retryable POSTs (`IdempotencyPolicy.autoGenerateForPost`), a
  `UUID` is generated once and sent under `IdempotencyPolicy.headerName` on every
  attempt.

---

## Configuration (`config.ts`, emitted via `generateClient`)

```swift
public struct Configuration: Sendable {
    public var apiKey: String
    public var baseURL: URL
    public var timeout: TimeInterval
    public var maxRetries: Int
    public var clientID: String?
    // …fields inferred from ctx.spec.auth + SdkBehavior

    public init(apiKey: String, baseURL: URL? = nil, /* … */) { … }
}
```

- `baseURL` defaults to `ctx.spec.baseUrl` (or first `ctx.spec.servers[]`).
- Auth from `ctx.spec.auth`: `bearer` → `Authorization: Bearer <apiKey>`;
  `apiKey` scheme → configured header/query.
- User-Agent from `SdkBehavior.userAgent.sdkIdentifierTemplate`.
- Timeout from `SdkBehavior.timeout.defaultTimeoutSeconds`.

---

## Test Pattern (`tests.ts`)

Swift Testing + `MockURLProtocol`:

```swift
import Testing
import Foundation
@testable import WorkOS

@Suite struct OrganizationsTests {
    @Test func createOrganizationSendsExpectedRequest() async throws {
        let (client, recorder) = makeTestClient(
            responding: #"{"id":"org_1","name":"Acme"}"#
        )
        let org = try await client.organizations.create(name: "Acme")

        #expect(recorder.lastRequest?.httpMethod == "POST")
        #expect(recorder.lastRequest?.url?.path == "/organizations")
        #expect(org.id == "org_1")
    }
}
```

- **`MockURLProtocol`** (test support file) intercepts `URLSession` and returns a
  canned status/body while recording the outgoing `URLRequest` (method, URL,
  headers, body) for wire-parity assertions.
- One `@Test` per operation per mount group asserts: HTTP method, path, and that
  the response decodes into the expected type.
- **Union-split wrappers** get one `@Test` each (`authenticateWithPassword`,
  `createOAuthApplication`, …) asserting the discriminating default
  (`grant_type` / `application_type`) landed in the request body.
- **URL builders** get a synchronous `…BuildsExpectedUrl` test asserting the
  assembled URL's path and query (defaults plus caller params) — no mock traffic.
- **Nested model bodies** are sample-constructed through the generated structs'
  memberwise initializers (required fields only, recursion-depth capped), so
  operations like `createEvent` (Audit Logs) are exercised rather than skipped;
  only heterogeneous-union bodies remain untestable.
- A `makeTestClient(responding:)` helper wires a `URLSession` with the mock
  protocol into a `{Namespace}Client`.

---

## Directory Structure (emitted `GeneratedFile` paths, target-root-relative)

```
Package.swift                                  # repo resource (hand-maintained, not generated)
.swift-format                                  # repo resource (hand-maintained, not generated)
script/ci                                      # repo resource (hand-maintained, not generated)
.gitignore                                     # repo resource (hand-maintained, not generated)
Sources/{Namespace}/
  {Namespace}Client.swift                      # client.ts
  Configuration.swift                          # config.ts (via generateClient)
  RequestOptions.swift                         # via generateClient
  Errors/
    {Namespace}Error.swift                     # errors.ts
  Models/
    {Model}.swift                              # models.ts (one per model)
  Enums/
    {Enum}.swift                               # enums.ts (one per enum)
  Resources/
    {MountGroup}.swift                         # resources.ts (one per mount group)
  Internal/
    Transport.swift                            # via generateClient (runtime)
    AnyCodable.swift                           # via generateClient
    Pagination.swift                           # via generateClient
    PathEncoding.swift                         # via generateClient
    Coding.swift                               # via generateClient
Tests/{Namespace}Tests/
  Support/
    MockURLProtocol.swift                      # tests.ts (test support)
    TestClient.swift                           # tests.ts (makeTestClient helper)
  {MountGroup}Tests.swift                      # tests.ts (one per mount group)
```

> **No `package` statements / no barrel file** — Swift modules expose all
> `public` symbols automatically, so the public surface is every `public` type.
> The extractor treats the whole `Sources/{Namespace}/` tree as the surface.

---

## Emitter File Layout (`src/ios/`)

| File           | Responsibility                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------- |
| `index.ts`     | `iosEmitter: Emitter` — wires enrichment + sub-generators, `fileHeader`, `formatCommand`                          |
| `naming.ts`    | Swift identifier casing, reserved-word escaping, method-name resolution, mount-group helpers                      |
| `type-map.ts`  | IR `TypeRef` → Swift type string (via `irMapTypeRef`)                                                             |
| `models.ts`    | `generateModels` — Codable structs + CodingKeys + public init                                                     |
| `enums.ts`     | `generateEnums` — forward-compatible Codable enums                                                                |
| `resources.ts` | `generateResources` — mount-group resource structs, `async throws` methods                                        |
| `wrappers.ts`  | union-split wrapper method rendering                                                                              |
| `client.ts`    | `generateClient` — client + full runtime + Package.swift + config files                                           |
| `errors.ts`    | `generateErrors` — error hierarchy from `SdkBehavior.errors`                                                      |
| `runtime.ts`   | static runtime templates (Transport, AnyCodable, Pagination, PathEncoding, Coding, RequestOptions, Configuration) |
| `tests.ts`     | `generateTests` — Swift Testing suites + MockURLProtocol support                                                  |
| `manifest.ts`  | `buildOperationsMap` — `"METHOD /path"` → `{ sdkMethod, service }`                                                |

---

## Future Enhancements (documented, not in v1)

- **Native sum-type unions:** emit discriminated unions as Swift `enum`s with
  associated values + a custom `init(from:)` switching on the discriminator,
  instead of flattened optional-field structs.
- **Structural dedup / typealias:** collapse structurally-identical models and
  enums to `typealias` (the Kotlin two-pass dedup + `SortOrder` special-case),
  reducing duplicate types.
- **Aggregate event enum:** a `{Namespace}Event` sum type over all event
  envelopes for exhaustive `switch` handling of webhook events.
- **PATCH tri-state:** a `PatchField<T>` wrapper distinguishing "absent" from
  "explicitly null" for PATCH bodies.
- **Completion-handler / Combine variants** for pre-async call sites (only if a
  consumer needs to support pre-iOS-13 patterns — not applicable at iOS 17 baseline).
  </content>
  </invoke>
