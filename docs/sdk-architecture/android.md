# Android / Kotlin SDK Architecture

Design document for the `android` oagen emitter, which generates an idiomatic
**Kotlin** SDK packaged as an **Android library** from the language-agnostic IR.

> **Emitter identifier:** `android`. Target language: Kotlin (Android). Emitter
> source lives in `src/android/`; unit tests in `test/android/`; smoke runner at
> `smoke/sdk-android.ts`.

This is a **Scenario B (fresh)** emitter: there is no existing published Android
SDK to preserve. The emitter generates only the **spec-driven surface** — models,
enums, resources, the client's resource-accessor file, and the per-mount test
suites. Everything spec-independent (the HTTP runtime: `Configuration`,
`Transport`, errors, pagination, JSON body building; the test support:
`MockWebServer` wiring and `testClient`; and the repo resources:
`build.gradle.kts`, `settings.gradle.kts`, `AndroidManifest.xml`,
`.editorconfig`, `proguard-rules.pro`) is **hand-maintained in the SDK repo**,
marked with `// @oagen-ignore-file` so generation never overwrites or prunes it.
This matches the iOS and Go emitters' static-code-extraction model.

Throughout this document, `{Namespace}` is `ctx.namespacePascal` (e.g. `WorkOS`)
and `{namespace}` is `ctx.namespace` (e.g. `workos`). **No SDK-specific names are
hard-coded** — everything flows from `ctx` and the IR. This is a deliberate
departure from the `kotlin` emitter, which hardcodes `package com.workos`.

---

## Relationship to the `kotlin` emitter

Both emitters target Kotlin, so the split needs justification. They differ on
every axis that matters for an Android artifact:

| Axis        | `kotlin` (server JVM)                 | `android` (this emitter)                    |
| ----------- | ------------------------------------- | ------------------------------------------- |
| JSON        | Jackson (reflection, `@JsonProperty`) | kotlinx.serialization (compile-time plugin) |
| Dates       | `java.time.OffsetDateTime`            | `kotlinx.datetime.Instant`                  |
| HTTP        | JVM HTTP stack                        | OkHttp                                      |
| Async       | `suspend` + `@JvmOverloads`           | `suspend`, no Java-interop overloads        |
| Package     | hardcoded `com.workos`                | namespace-driven `com.{namespace}.android`  |
| Layout      | `src/main/kotlin/` JVM library        | Android Gradle library module               |
| Integration | merges into live `workos-kotlin`      | fully generated (Scenario B)                |

The decisive constraint is **Jackson**. It relies on runtime reflection, which
costs method count, needs explicit R8/ProGuard keep rules, and is discouraged on
Android. kotlinx.serialization resolves serializers at compile time via the
Kotlin compiler plugin — no reflection, no keep rules, R8-shrinkable. That alone
makes a shared emitter impractical, since the annotation model, serializer
wiring, and enum forward-compatibility strategy all differ.

`com.{namespace}.android` (rather than `com.{namespace}`) follows the convention
Stripe uses for its Android SDK (`com.stripe.android`) and avoids a class-name
collision with the server SDK's `com.workos.WorkOS` if both ever land on one
classpath. The package prefix is overridable via
`ctx.emitterOptions.packagePrefix`.

---

## Structural Guidelines

| Category                   | Choice                                                                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Language / concurrency** | Kotlin, `suspend` functions (coroutines). One `suspend fun` per operation — no callback or `Flow` variants except the auto-pager       |
| **Package manager**        | Gradle with the Android Library plugin (`com.android.library`)                                                                         |
| **Build tool**             | Gradle Kotlin DSL (`build.gradle.kts`) — **hand-maintained**, not generated                                                            |
| **Android baseline**       | `minSdk 24`, `compileSdk 35`, JVM target 17 (declared in the hand-maintained Gradle files)                                             |
| **HTTP client**            | OkHttp — the de-facto Android standard, already present in most apps, and pairs with MockWebServer for wire-level tests                |
| **JSON**                   | kotlinx.serialization (`@Serializable`, `@SerialName`) — compile-time, reflection-free, R8-safe                                        |
| **Dates**                  | `kotlinx.datetime.Instant`, ISO-8601 (avoids the `java.time` desugaring requirement below API 26)                                      |
| **Documentation**          | KDoc (`/** … */`)                                                                                                                      |
| **Type signatures**        | Inline — Kotlin needs no separate signature files, so `generateTypeSignatures` returns `[]`                                            |
| **Linting / formatting**   | ktlint via `./gradlew ktlintFormat`; `formatCommand` no-ops when no `gradlew` is present so a missing toolchain never fails generation |
| **Testing framework**      | JUnit 5 (`org.junit.jupiter`) + `kotlinx-coroutines-test` (`runTest`)                                                                  |
| **HTTP mocking (tests)**   | OkHttp `MockWebServer` — records the outgoing request for wire-parity assertions                                                       |
| **Pagination**             | List methods return `Page<T>`; an opt-in `…AutoPaging` companion returns `Flow<T>`                                                     |

---

## Architecture Overview

The generated SDK is a single Android library module. A consumer:

```kotlin
import com.workos.android.WorkOSClient

val client = WorkOSClient(apiKey = "sk_test_...")
val org = client.organizations.create(name = "Acme")
```

Layers:

1. **`{Namespace}Client`** (`{Namespace}Client.kt`, hand-maintained) — the entry
   point. Holds an immutable `Configuration` and a `Transport`. The generated
   `{Namespace}ClientResources.kt` exposes one extension property per **mount
   group** (`client.organizations`, `client.sso`, …).
2. **Resources** (`resources/{MountGroup}.kt`, generated) — one class per mount
   group, one `suspend fun` per operation. Methods flatten path/query/body
   parameters into the Kotlin signature and delegate to `Transport`.
3. **Transport** (`internal/Transport.kt`, hand-maintained) — OkHttp-based
   request execution: URL/query/header/body assembly, retry with exponential
   backoff + jitter, response decoding, and status-code → exception mapping.
4. **Models** (`models/{Model}.kt`, generated) — `@Serializable data class`es.
5. **Enums** (`enums/{Enum}.kt`, generated) — forward-compatible sealed classes.
6. **Errors** (`{Namespace}Exception.kt`, hand-maintained) — the exception hierarchy.
7. **Support runtime** (hand-maintained) — `JsonBody`, `Page`, `PathEncoding`,
   `RequestOptions`, `Configuration`.

### Mount-group architecture

Resources, client accessors, and the operations manifest are all derived from
`ctx.resolvedOperations` grouped by `mountOn` (via the shared `groupByMount` /
`scopedMountGroups` / `getMountTarget` helpers), **not** by raw IR service. This
matches the iOS/Kotlin/Go emitters and honors consumer `mountRules` /
`operationHints`. Method names come from `ResolvedOperation.methodName`
(snake_case) converted to Kotlin `camelCase`.

---

## Naming Conventions (`naming.ts`)

| IR concept                   | Kotlin form                                           | Function       |
| ---------------------------- | ----------------------------------------------------- | -------------- |
| Model / Enum / Resource type | `PascalCase` (acronyms upper-cased via `ACRONYM_SET`) | `typeName`     |
| File name                    | matches type name + `.kt`                             | `fileName`     |
| Method name                  | `camelCase`                                           | `methodName`   |
| Property / parameter         | `camelCase`, reserved words back-tick escaped         | `propertyName` |
| Resource accessor property   | `camelCase` of mount group                            | `accessorName` |
| Enum member                  | `UPPER_SNAKE_CASE` object name, raw value preserved   | `enumCaseName` |

- **Acronyms:** reuse `toPascalCase`/`toCamelCase` from `@workos/oagen` (they
  merge `ACRONYM_SET` = SSO, FGA, SAML, SCIM, JWT, HMAC, M2M).
- **Reserved words:** Kotlin keywords used as identifiers are wrapped in
  back-ticks (`` `object` ``, `` `is` ``, `` `in` ``, `` `when` ``, `` `val` ``, …).
  Note `object` **is** reserved in Kotlin (unlike Swift), and it is a common wire
  field name — so back-tick escaping matters more here than in the iOS emitter.
- **Wire keys:** a field's `@SerialName` is always the IR `field.name` (the wire
  name). The Kotlin property is `camelCase(field.domainName ?? field.name)`.
- **Method-name resolution:** prefer `ctx.resolvedOperations` (via the shared
  `buildResolvedLookup`/`lookupResolved`), fall back to `resolveOperations(ctx.spec)`
  when the context has none (unit tests). Uniqueness within a mount is enforced
  upstream by `assertUniqueResolvedMethods`.
- **Mount-noun trimming (`trimMountResource`):** delegates to the shared
  `trimMountedResourceFromMethod`, so method names agree across languages —
  `listOrganizations` on `Organizations` → `list`, `getUserByExternalId` on
  `UserManagement` → `getByExternalId`.
- **Resource-name collisions:** Kotlin allows a class and a file to share a
  basename across packages, but a resource in `resources/` whose name matches a
  model in `models/` still produces confusing imports, so a colliding mount gets
  a `Resource` suffix (mirroring the iOS `resourceTypeName` rule).

---

## Type Mapping (`type-map.ts`)

Implemented with the IR's `mapTypeRef` (`irMapTypeRef`) visitor.

| IR `TypeRef`                                       | Kotlin type                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------ |
| `primitive` string                                 | `String`                                                                       |
| `primitive` string, `format: date-time` / `date`   | `Instant` (`kotlinx.datetime.Instant`)                                         |
| `primitive` string, `format: byte` / `binary`      | `ByteArray`                                                                    |
| `primitive` string, `format: uuid` / `uri` / `url` | `String` (lossless wire round-trip)                                            |
| `primitive` integer                                | `Long` (`Int` when `format: int32`)                                            |
| `primitive` number                                 | `Double`                                                                       |
| `primitive` boolean                                | `Boolean`                                                                      |
| `primitive` unknown                                | `JsonElement`                                                                  |
| `array` of `T`                                     | `List<T>`                                                                      |
| `model` `Foo`                                      | `Foo`                                                                          |
| `enum` `Foo`                                       | `Foo`                                                                          |
| `literal`                                          | underlying scalar (`String`/`Long`/`Double`/`Boolean`); `null` → `JsonElement` |
| `map` of `V`                                       | `Map<String, V>`                                                               |
| `nullable` of `T`                                  | `T?`                                                                           |
| `union` (single unique variant)                    | that variant                                                                   |
| `union` (`allOf`)                                  | first variant (merged shape)                                                   |
| `union` (other / heterogeneous / discriminated)    | `JsonElement`                                                                  |

`JsonElement` (from kotlinx.serialization) is the `unknown` carrier, chosen over
`Any` because it is `@Serializable` out of the box — `Any` would need a custom
serializer at every use site.

**Optionality:** a field/parameter is nullable (`T?`) when `!required` **or** the
type is `nullable`. Nullable constructor/method parameters get a `= null`
default, which is what lets Kotlin callers use named arguments freely.

> **Discriminated unions (v1):** modeled as **flat data classes** — the base
> model carries the superset of variant fields (all variant-specific fields
> nullable), using `enrichModelsFromSpec` + `flattenDiscriminatedUnionFields`
> (same approach as the iOS/Go/Kotlin base models). This decodes any variant
> losslessly and always compiles. Native Kotlin sealed-interface unions with a
> kotlinx.serialization polymorphic serializer are a **documented future
> enhancement** — deferred because a slightly-wrong custom serializer would fail
> wire-parity smoke tests, whereas a nullable-field data class never does.

---

## Model Pattern (`models.ts`)

Each IR `Model` → one `@Serializable public data class` file.

```kotlin
package com.workos.android.models

import kotlinx.datetime.Instant
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** An organization. */
@Serializable
public data class Organization(
    /** The unique identifier of the organization. */
    @SerialName("id") public val id: String,
    /** The name of the organization. */
    @SerialName("name") public val name: String,
    /** The timestamp when the organization was created. */
    @SerialName("created_at") public val createdAt: Instant? = null,
)
```

Rules:

- **`data class`** gives `equals`/`hashCode`/`copy`/`toString` for free — no
  hand-written equivalent of Swift's `Equatable` conformance needed.
- **Primary-constructor properties** are ordered **required first, then nullable**
  (nullables get `= null`), so callers can rely on named arguments and omit optionals.
- **`@SerialName` is always emitted** (deterministic) so wire keys survive
  property renaming; the value is the IR wire name.
- **`@Serializable` on every model**; the kotlinx plugin generates the serializer
  at compile time.
- **Deprecated fields** → `@Deprecated("…")` on the property.
- **Empty models** → an `@Serializable public class Foo` with no body (a Kotlin
  `data class` requires at least one constructor parameter, so empty models
  degrade to a plain class).
- **Property de-duplication:** flattening discriminated-union variants can repeat
  a field; duplicates by Kotlin property name are dropped so the constructor
  doesn't declare the same parameter twice.
- Discriminated-union base models are emitted as flat data classes (see Type Mapping).

---

## Enum Pattern (`enums.ts`)

Forward-compatible **sealed classes** — a server-added value must not crash
decoding, _and_ must round-trip losslessly:

```kotlin
package com.workos.android.enums

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder

/** Enumeration of valid ConnectionState values. */
@Serializable(with = ConnectionState.Serializer::class)
public sealed class ConnectionState(public val rawValue: String) {
    public data object Active : ConnectionState("active")
    public data object Inactive : ConnectionState("inactive")

    /** A value not known at SDK generation time. */
    public data class Unknown(public val value: String) : ConnectionState(value)

    public companion object {
        public val allKnownValues: List<ConnectionState> = listOf(Active, Inactive)

        public fun fromRawValue(rawValue: String): ConnectionState =
            when (rawValue) {
                "active" -> Active
                "inactive" -> Inactive
                else -> Unknown(rawValue)
            }
    }

    internal object Serializer : KSerializer<ConnectionState> {
        override val descriptor = PrimitiveSerialDescriptor("ConnectionState", PrimitiveKind.STRING)
        override fun deserialize(decoder: Decoder): ConnectionState = fromRawValue(decoder.decodeString())
        override fun serialize(encoder: Encoder, value: ConnectionState) = encoder.encodeString(value.rawValue)
    }
}
```

- A **sealed class, not an `enum class`**. A Kotlin `enum class` cannot carry the
  unrecognized wire string, so an unknown value would re-serialize as the wrong
  token and break wire parity on round-trip. The sealed class preserves the raw
  value in `Unknown(value)` — exact parity with the iOS emitter's
  `case unknown(String)`.
- `when` over a sealed class is still exhaustiveness-checked, so this costs
  nothing versus an enum at the call site.
- `fromRawValue` is **total** — unknown wire values map to `Unknown` instead of throwing.
- A generated `Serializer` is always emitted rather than relying on any implicit
  conformance.
- `allKnownValues` mirrors the iOS `allKnownCases` convenience.
- Integer-valued enums use an `Int` `rawValue` with `PrimitiveKind.INT` and the
  same shape.
- Member names: `PascalCase` object names derived from the wire value; collisions
  get a numeric suffix; numeric-leading values get a `Value` prefix. The
  sentinel name `Unknown` is reserved so a real `unknown` wire value is suffixed
  rather than colliding.

---

## Resource / Client Pattern (`resources.ts`, `client.ts`)

### Client

The client class core lives in the SDK repo (hand-maintained,
`@oagen-ignore-file`); the emitter generates only the spec-driven accessors as
**extension properties**, which is the closest Kotlin analogue to the Swift
extension the iOS emitter emits:

```kotlin
// WorkOSClientResources.kt (generated)
package com.workos.android

import com.workos.android.resources.Organizations
import com.workos.android.resources.SSO

/** Operations for the Organizations API. */
public val WorkOSClient.organizations: Organizations
    get() = Organizations(transport)

/** Operations for the SSO API. */
public val WorkOSClient.sso: SSO
    get() = SSO(transport)
```

- `generateClient` returns the accessor file (with `overwriteExisting: true`, the
  Go/iOS pattern) plus the staging-only smoke-plan sidecar.
- Extension properties in the same module can read the client's `internal val
transport`, so the runtime stays hand-maintained without widening its visibility.
- Accessors construct a fresh resource object per access. Resource classes hold
  only a `Transport` reference, so this is as cheap as the Swift value-type
  structs and avoids caching/retain-cycle bookkeeping.

### Resource + method

```kotlin
public class Organizations internal constructor(
    private val transport: Transport,
) {
    /**
     * Creates a new organization.
     *
     * @param name The name of the organization.
     * @param requestOptions Per-request overrides (idempotency key, API key, headers, timeout).
     * @return The created [Organization].
     */
    public suspend fun create(
        name: String,
        domains: List<String>? = null,
        requestOptions: RequestOptions? = null,
    ): Organization {
        val path = "organizations"
        val body = JsonBody()
        body.set("name", name)
        body.set("domains", domains)
        return transport.request(
            method = "POST",
            path = path,
            query = emptyList(),
            body = body,
            options = requestOptions,
        )
    }

    public suspend fun get(
        id: String,
        requestOptions: RequestOptions? = null,
    ): Organization {
        val path = "organizations/${PathEncoding.segment(id)}"
        return transport.request(
            method = "GET",
            path = path,
            query = emptyList(),
            body = null,
            options = requestOptions,
        )
    }

    public suspend fun delete(
        id: String,
        requestOptions: RequestOptions? = null,
    ) {
        val path = "organizations/${PathEncoding.segment(id)}"
        transport.requestVoid(
            method = "DELETE",
            path = path,
            query = emptyList(),
            body = null,
            options = requestOptions,
        )
    }
}
```

Method construction (driven by `planOperation(op)`):

- **Path params** → interpolated into a Kotlin template string, each wrapped in
  `PathEncoding.segment(...)` (SSRF-safe per-segment percent-encoding; see the
  security note in `shared/path-template.ts`). Segments come from the shared
  `parsePathTemplate`.
- **Query params** → appended to a `MutableList<QueryParam>`, honoring `explode`
  for arrays (repeat key vs comma-join).
- **Body** → a `JsonBody` builder; `set` is a no-op for `null`, so optional
  fields are omitted rather than sent as JSON `null`.
  `requestBodyEncoding` selects JSON (default) vs form-urlencoded.
- **Return type** → from `planOperation`: model, `List<Model>` (array response),
  `Page<Item>` (paginated), or `Unit` (delete / no model). `transport.request` is
  `reified` on the return type, so no explicit type token is passed.
- **`requestOptions: RequestOptions? = null`** is always the last parameter.
  Per `docs/lang-gen/sdk-runtime-contract.md` §1, the hand-maintained
  `RequestOptions` must carry **all five** overrides, and the transport must
  actually honor each (§7 — a typed field that the runtime ignores does not count):

  ```kotlin
  public data class RequestOptions(
      val headers: Map<String, String>? = null,  // extra headers
      val timeoutSeconds: Long? = null,          // timeout override
      val maxRetries: Int? = null,               // retry override
      val baseUrl: String? = null,               // base URL override
      val idempotencyKey: String? = null,        // idempotency key override
  )
  ```

- **No `@JvmOverloads`** — Kotlin default arguments serve Kotlin callers, and
  Android consumers are Kotlin-first. This is a deliberate difference from the
  `kotlin` emitter, which targets Java interop too.

### Wrappers (union-split operations)

When a `ResolvedOperation` has `wrappers` (from consumer `split` hints, e.g.
`authenticate` → `authenticateWithPassword`/`authenticateWithCode`), one
`suspend fun` is emitted per wrapper, each exposing only its variant's fields and
injecting `defaults` + `inferFromClient` values (read from the client
configuration, e.g. `transport.configuration.clientId`). Built from
`ResolvedWrapper` fields via the shared `wrapper-utils`.

### URL builders (browser-redirect operations)

`urlBuilder` operations (e.g. `GET /sso/authorize`, `GET /sso/logout`) never
issue an HTTP request: `generateResources` emits a **non-suspend** function
returning the assembled URL `String` via `transport.buildUrl(path, query)`.
Hidden `defaults` (`response_type=code`) and `inferFromClient` values
(`client_id`, appended only when `Configuration.clientId` is set) join the
caller's query parameters, mirroring the iOS and Go emitters. They are skipped in
`buildOperationsMap` and the smoke plan — there is no live HTTP call to verify.

---

## Serialization Pattern (hand-maintained `internal/Json.kt`, `internal/JsonBody.kt`)

- A single `Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = false }`
  instance configured in the runtime. `ignoreUnknownKeys` is essential for
  forward compatibility — a server-added response field must not throw.
- **`JsonBody`** — a small builder wrapping a `MutableMap<String, JsonElement>`.
  Serves the same role as the iOS emitter's `EncodableBody`. Required surface:

  | Method                                               | Contract                                                                         |
  | ---------------------------------------------------- | -------------------------------------------------------------------------------- |
  | `set(key: String, value: Any?)`                      | Add one field. **Ignores `null`**, which is how optional body fields are omitted |
  | `setRaw(serializer: SerializationStrategy<T>, v: T)` | Replace the whole body with a serialized object (raw, unexpanded bodies)         |
  | `setRawJson(value: JsonElement)`                     | Replace the whole body with a pre-built element                                  |
  | `toJsonElement()`                                    | The raw override if set, else the accumulated field map                          |

  `setRaw`/`setRawJson` exist because an operation whose request body is a
  field-less model (or a non-object schema) cannot be flattened into named
  parameters — it is passed whole. Handing that object straight to
  `transport.request(body = …)` does not typecheck, since the transport takes a
  `JsonBody`. `set` alone cannot express it either, because there is no field key.
  The emitter names the compile-time serializer for a model body
  (`Foo.serializer()`); any other raw shape is exposed to callers as a
  `JsonElement` parameter, since no named serializer can be derived.

- **Dates** — `kotlinx.datetime.Instant` serializes as ISO-8601 by default.

---

## Pagination Pattern (hand-maintained `Page.kt`, `internal/AutoPaging.kt`)

```kotlin
@Serializable
public data class Page<T>(
    @SerialName("data") public val data: List<T>,
    @SerialName("list_metadata") public val listMetadata: ListMetadata,
)

@Serializable
public data class ListMetadata(
    @SerialName("before") public val before: String? = null,
    @SerialName("after") public val after: String? = null,
)
```

- Paginated list methods return `Page<Item>` (item type from
  `plan.paginatedItemModelName`, unwrapped through the shared `unwrapListModel`
  so the element type is `Organization`, not `OrganizationList`).
- Each cursor-paginated operation also gets a generated `…AutoPaging` companion
  returning `Flow<Item>`, which walks successive pages by feeding
  `listMetadata.after` back into the cursor parameter:

```kotlin
public fun listAutoPaging(
    limit: Long? = null,
    requestOptions: RequestOptions? = null,
): Flow<Organization> = autoPagingFlow { cursor ->
    list(limit = limit, after = cursor, requestOptions = requestOptions)
}
```

- The companion is only generated when the cursor parameter is an optional string
  query param the wrapper can drive (same guard as the iOS `planAutoPaging`).
- `Flow` is cold and cancellable, so it is the correct Kotlin analogue of the
  Swift `AutoPagingSequence` (`AsyncSequence`).

---

## Error Handling (hand-maintained `{Namespace}Exception.kt`)

Hand-maintained in the SDK repo (`generateErrors` returns `[]`). The hierarchy
mirrors `ctx.spec.sdk.errors` (the `ErrorPolicy.statusCodeMap`) as of extraction.
Kotlin/JVM convention is a `Throwable` hierarchy rather than a sum type, so this
diverges structurally from the Swift `enum WorkOSError`:

Per `docs/lang-gen/sdk-runtime-contract.md` §3, the error type must preserve
status code, request ID, message, API error code, **parameter name**, and the raw
response body:

```kotlin
public open class WorkOSException(
    public val statusCode: Int,
    override val message: String,
    public val code: String? = null,
    public val requestId: String? = null,
    /** The offending request parameter, when the API attributes the error to one. */
    public val param: String? = null,
    public val raw: JsonElement? = null,
) : Exception(message)

/** 400 — the request was malformed. */
public class BadRequestException(…) : WorkOSException(…)

/** 401 — authentication failed. */
public class AuthenticationException(…) : WorkOSException(…)

/** 404 — the resource was not found. */
public class NotFoundException(…) : WorkOSException(…)

// …one subclass per statusCodeMap entry

/** 5xx — a server error. */
public class ServerException(…) : WorkOSException(…)

/** A transport/connection failure. */
public class NetworkException(cause: IOException) : WorkOSException(…)

/** The response body could not be decoded. */
public class DecodingException(cause: Throwable) : WorkOSException(…)
```

`Transport` inspects the HTTP status, decodes the error envelope, and throws the
appropriate subclass via the status-code map. `errorDocUrlTemplate` (if present)
is surfaced in the message. Subclassing (rather than sealed) keeps the hierarchy
extensible without a breaking change when the spec adds a status code.

---

## Retry Logic (hand-maintained `internal/Transport.kt`)

Hand-maintained; behavior mirrors `ctx.spec.sdk.retry` (`RetryPolicy`) as of
extraction:

- Retry on `retryableStatusCodes` (default `[429, 500, 502, 503, 504]`), and on
  connection errors / timeouts per policy flags.
- Up to `maxRetries` (default 3) attempts.
- Exponential backoff: `initialDelay * multiplier^attempt`, capped at `maxDelay`,
  with `± jitterFactor` randomization, awaited with `kotlinx.coroutines.delay`
  (non-blocking — never `Thread.sleep`, which would stall the calling
  dispatcher). The generated Kotlin may use randomness; **the emitter itself must
  not** — emitters stay pure and deterministic.
- Honors a `Retry-After` header when present.
- Idempotency: for retryable POSTs (`IdempotencyPolicy.autoGenerateForPost`), a
  UUID is generated once and sent under `IdempotencyPolicy.headerName` on every attempt.

---

## Configuration (hand-maintained `Configuration.kt`)

```kotlin
public data class Configuration(
    public val apiKey: String,
    public val baseUrl: String = "https://api.workos.com",
    public val timeoutSeconds: Long = 60,
    public val maxRetries: Int = 3,
    public val clientId: String? = null,
    // …fields inferred from ctx.spec.auth + SdkBehavior
)
```

Hand-maintained; the defaults captured at extraction time came from the spec
policy (`baseUrl` from `ctx.spec.baseUrl`, bearer auth from `ctx.spec.auth`,
User-Agent from `SdkBehavior.userAgent.sdkIdentifierTemplate`, timeout from
`SdkBehavior.timeout.defaultTimeoutSeconds`). Policy changes are applied by hand
in the SDK repo.

---

## Test Pattern (`tests.ts`)

JUnit 5 + MockWebServer + `runTest`:

```kotlin
package com.workos.android.resources

import kotlin.test.assertEquals
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Test

class OrganizationsTest {
    @Test
    fun `create sends expected request`() = runTest {
        val (client, server) = testClient("""{"id":"org_1","name":"Acme"}""")

        val org = client.organizations.create(name = "Acme")

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/organizations", request.path?.substringBefore('?'))
        assertEquals("org_1", org.id)
    }
}
```

The generated suites depend on a small hand-maintained support surface
(`support/TestClient.kt`, `@oagen-ignore-file`). Keeping MockWebServer's API
behind these helpers means a MockWebServer upgrade is a one-file edit rather than
a regeneration of every suite:

| Helper                                                   | Contract                                                                                              |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `testClient(responding: String = "{}")`                  | Starts a `MockWebServer`, enqueues one 200 response, returns `Pair<{Namespace}Client, MockWebServer>` |
| `testClientWithStubs(stubs: List<String>)`               | Same, enqueuing one 200 response per stub (drives the pagination test)                                |
| `testClientWithStatus(code, body, headers = emptyMap())` | Enqueues one failure response — drives the §6 error-path tests                                        |
| `RecordedRequest.pathOnly()`                             | Request path with the query string stripped                                                           |
| `RecordedRequest.queryParam(name)`                       | Single query-parameter value, **percent-decoded**                                                     |
| `RecordedRequest.headerValue(name)`                      | Single request-header value — proves per-request options reached the wire                             |
| `RecordedRequest.bodyJson()`                             | Request body parsed into a `JsonObject`                                                               |

Every client these helpers return must be configured `maxRetries = 0`. Otherwise
the retryable statuses (429 and 5xx) consume the single enqueued response on the
first attempt and the test blocks waiting for one that was never enqueued.

- One `@Test` per operation per mount group asserts: HTTP method, path, and that
  the response decodes into the expected type.
- **Backtick test names** (``fun `create sends expected request`()``) are the
  Kotlin convention and read better in reports than camelCase.
- **Union-split wrappers** get one `@Test` each, asserting the discriminating
  default (`grant_type` / `application_type`) landed in the request body.
- **URL builders** get a non-suspend `builds expected url` test asserting the
  assembled URL's path and query — no mock traffic.
- **Nested model bodies** are sample-constructed through the generated data
  classes' constructors (required fields only, recursion-depth capped), so
  operations like `createEvent` are exercised rather than skipped; only
  heterogeneous-union bodies remain untestable.
- The transport behavior suite (auth header, request options, typed errors,
  retries, idempotency) is hand-maintained alongside the transport it tests.

---

## Directory Structure (emitted `GeneratedFile` paths, target-root-relative)

`{pkg}` is the package path (`com/workos/android` by default).

```
build.gradle.kts                                 # repo resource (hand-maintained)
settings.gradle.kts                              # repo resource (hand-maintained)
gradle/libs.versions.toml                        # repo resource (hand-maintained)
proguard-rules.pro                               # repo resource (hand-maintained)
.editorconfig                                    # repo resource (hand-maintained)
src/main/AndroidManifest.xml                     # repo resource (hand-maintained)
src/main/kotlin/{pkg}/
  {Namespace}Client.kt                           # hand-maintained (@oagen-ignore-file)
  {Namespace}ClientResources.kt                  # client.ts (accessor extensions)
  Configuration.kt                               # hand-maintained (@oagen-ignore-file)
  RequestOptions.kt                              # hand-maintained (@oagen-ignore-file)
  {Namespace}Exception.kt                        # hand-maintained (@oagen-ignore-file)
  Page.kt                                        # hand-maintained (@oagen-ignore-file)
  helpers/                                       # hand-maintained (@oagen-ignore-file)
    Pkce.kt                                      #   H08 + `val {Namespace}Client.pkce`
    AuthKit.kt                                   #   H10 (composes the generated URL builder)
    PublicClient.kt                              #   H19 public/PKCE-only facade
    Passwordless.kt                              #   non-spec + `val {Namespace}Client.passwordless`
    Signing.kt                                   #   HMAC-SHA256 signature primitives (H02)
    WebhookVerification.kt                       #   H01, H02
    Actions.kt                                   #   H03 + `val {Namespace}Client.actions`
    Iron.kt                                      #   H06 Fe26.2 seal/unseal
    Session.kt                                   #   H04, H05, H07 + `val {Namespace}Client.session`
    VaultCrypto.kt                               #   H18 + `val {Namespace}Client.vaultCrypto`
  models/
    {Model}.kt                                   # models.ts (one per model)
  enums/
    {Enum}.kt                                    # enums.ts (one per enum)
  resources/
    {MountGroup}.kt                              # resources.ts (one per mount group)
  internal/
    Transport.kt                                 # hand-maintained (@oagen-ignore-file)
    Json.kt                                      # hand-maintained (@oagen-ignore-file)
    JsonBody.kt                                  # hand-maintained (@oagen-ignore-file)
    PathEncoding.kt                              # hand-maintained (@oagen-ignore-file)
    AutoPaging.kt                                # hand-maintained (@oagen-ignore-file)
src/test/kotlin/{pkg}/
  support/
    TestClient.kt                                # hand-maintained (@oagen-ignore-file)
  TransportBehaviorTest.kt                       # hand-maintained (@oagen-ignore-file)
  {MountGroup}Test.kt                            # tests.ts (one per mount group)
```

> Test suites live in the SDK's **root** package, not a `resources` sub-package,
> because the resource accessors are extension properties declared there —
> a suite in the same package resolves `client.organizations` with no import.

### Namespace casing

`namespacePascal` is passed through verbatim from `--namespace`, and it names the
client class (`{Namespace}Client`). Generate with **`--namespace WorkOS`** to get
exact acronym casing; a lower-case namespace is capitalized (`workos` →
`WorkosClient`) so output is always a legal Kotlin identifier, but the `OS`
casing cannot be recovered. The package segment is independent: it lower-cases
and strips separators from `ctx.namespace`, so both spellings yield
`com.workos.android`.

> **No barrel file** — Kotlin has no re-export mechanism, so the public surface is
> every `public` declaration reachable from the package. Consumers import from the
> concrete package (`com.workos.android.models.Organization`). An extractor would
> treat the whole `src/main/kotlin/{pkg}/` tree as the surface.

---

## Emitter File Layout (`src/android/`)

| File           | Responsibility                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| `index.ts`     | `androidEmitter: Emitter` — wires enrichment + sub-generators, `fileHeader`, `formatCommand`         |
| `naming.ts`    | Kotlin identifier casing, reserved-word escaping, method-name resolution, package/path helpers       |
| `type-map.ts`  | IR `TypeRef` → Kotlin type string (via `irMapTypeRef`) + implied imports                             |
| `models.ts`    | `generateModels` — `@Serializable data class`es with `@SerialName`                                   |
| `enums.ts`     | `generateEnums` — forward-compatible sealed classes + generated `KSerializer`                        |
| `resources.ts` | `generateResources` — mount-group resource classes, `suspend fun` methods, URL builders, auto-pagers |
| `wrappers.ts`  | union-split wrapper method rendering                                                                 |
| `client.ts`    | `generateClient` — `{Namespace}ClientResources.kt` extension properties + smoke-plan sidecar         |
| `tests.ts`     | `generateTests` — per-mount JUnit 5 suites (support files are hand-maintained in the SDK repo)       |
| `manifest.ts`  | `buildOperationsMap` — `"METHOD /path"` → `{ sdkMethod, service }`                                   |
| `imports.ts`   | Deterministic import-block collection and ktlint-compatible ordering                                 |

---

## Non-spec accessors: why Kotlin sidesteps the base-class hazard

`prompt-4-cleanup` warns that compat accessors (passwordless, vault, actions, pkce)
must live in the **generated** client file rather than a hand-maintained base class,
because their constructors type-hint the full subclass and `self` in the base does
not satisfy that constraint — it produced
`"WorkOSClient*" is not assignable to "WorkOSClient"` during the Python extraction.

That hazard does not exist here, and the reason is structural rather than lucky.
Kotlin mounts these as **extension properties on the concrete class**:

```kotlin
public val WorkOSClient.passwordless: Passwordless
    get() = Passwordless(this)
```

`this` is a `WorkOSClient` — the concrete type — so there is no base/subclass
variance to violate. Consequently the accessors live in hand-maintained
`helpers/` files rather than the generated client file, which is the opposite of
the Python arrangement and is correct for this language.

Two invariants keep it safe, both pinned by tests:

1. The emitter never generates an accessor for a `NON_SPEC_SERVICES` entry
   (`test/android/non-spec.test.ts`) — a generated accessor would reference a type
   that only exists in the SDK repo and break the standalone staging build.
2. Generated and hand-maintained accessor names are disjoint. They share one
   namespace (both are `val {Namespace}Client.x` in the same package), so a
   collision is a redeclaration **compile** error, not a silent shadow.

---

## Session cookies: why the wire shape is Node's, not `workos-kotlin`'s

Sealed session cookies are a cross-SDK contract, and the two Kotlin SDKs disagree
on it. `workos-kotlin` serializes `SessionCookieData` with the SDK's shared Jackson
mapper, which has no naming strategy — so its own fields come out camelCase, while
the nested `user` comes out **snake_case**, because the generated models carry
`@JsonProperty("email_verified")` and friends. `workos-node` writes camelCase at
every level.

The consequence is that a cookie sealed by a Node backend does not open in
`workos-kotlin`: Jackson looks for `email_verified`, does not find it, and the
Kotlin module rejects the missing non-null constructor parameter.

That asymmetry matters more for `android` than for any server SDK, because on
Android the seal is almost never produced locally — a backend seals it and the app
opens it. So `helpers/Session.kt` deliberately does **not** mirror
`workos-kotlin` here:

- **Writes** the `workos-node` shape — camelCase at every level.
- **Reads** either shape, accepting each key in camelCase or snake_case.

The mechanism is a shallow key rename applied to the model sub-objects only.
Shallow is load-bearing: `User.metadata` holds caller-supplied keys, so recursing
would rewrite application data (`tenant_id` → `tenantId`). `User` and
`AuthenticateResponseImpersonator` are flat apart from `metadata`, and `metadata`
itself is unchanged by either transform, so one level is both sufficient and safe.
`test/../SessionTest.kt` pins all three properties: the Node shape, the
`workos-kotlin` shape, and metadata surviving a round trip.

`authenticate()` and `refresh()` are `suspend` here where `workos-kotlin`'s block.
JWKS retrieval is network I/O and must not run on Android's main thread; the
JWKS-backed verifier confines it to `Dispatchers.IO`.

---

## Compiler heap (required in `gradle.properties`)

`Transport.request` is a `suspend inline fun <reified T>`, so it is inlined at
**every** operation call site — 261 of them — and each reified instantiation
materializes a distinct `kotlinx.serialization` serializer. The default Kotlin
compiler heap is not enough for that, and the failure is badly misreported:

```
e: org.jetbrains.kotlin.codegen.CompilationException:
   Back-end (JVM) Internal error: Couldn't transform method node:
Caused by: java.lang.OutOfMemoryError: GC overhead limit exceeded
```

The "Internal error" and the file it names (some arbitrary model) are both red
herrings — it is purely an out-of-memory condition. The hand-maintained
`gradle.properties` must raise the heap:

```properties
org.gradle.jvmargs=-Xmx6g -XX:MaxMetaspaceSize=1g
kotlin.daemon.jvmargs=-Xmx6g
```

If a future SDK grows past this, the alternative is to drop `reified` and pass an
explicit `KSerializer<T>` from the generated call site, trading a little
call-site noise for a much smaller inlined footprint.

---

## Known Limitations

- **Deep-object query params are bracket-expanded, not `style`/`explode`-driven.**
  A `map`-typed query parameter (e.g. SSO's `provider_query_params`) expands to one
  bracketed entry per key — `provider_query_params[hd]=example.com` — which is what
  the API and the other WorkOS SDKs send, and is pinned by the generated
  `SSOTest`/`UserManagementTest` URL-builder tests. It is hard-coded rather than
  read from the operation's OpenAPI `style`/`explode`, so a future parameter
  wanting a different deep-object encoding would need real `style` support in the
  query builder. Non-string map values go through `.toString()`. The iOS emitter
  still has the original `.toString()`-the-whole-map gap.
- **Heterogeneous unions widen to `JsonElement`.** Callers get raw JSON rather
  than a typed variant. Generated tests skip operations whose required body is
  such a union, so those paths are covered only by the live smoke runner.

---

## Future Enhancements (documented, not in v1)

- **Native sealed-interface unions:** emit discriminated unions as sealed
  interfaces with a kotlinx.serialization polymorphic serializer keyed on the
  discriminator, instead of flattened nullable-field data classes.
- **Kotlin Multiplatform:** swap OkHttp for Ktor and `src/main/kotlin` for
  `src/commonMain/kotlin` so one emitter serves Android _and_ iOS. This is the
  main reason to keep the runtime hand-maintained and the emitter output
  dependency-agnostic.
- **Structural dedup / typealias:** collapse structurally-identical models and
  enums to `typealias` (the Kotlin emitter's two-pass dedup), reducing duplicate types.
- **Aggregate event sealed interface:** a `{Namespace}Event` sum type over all
  webhook event envelopes for exhaustive `when` handling.
- **PATCH tri-state:** a `PatchField<T>` wrapper distinguishing "absent" from
  "explicitly null" for PATCH bodies.
- **Explicit API mode:** enable Kotlin's `explicitApi()` in the generated Gradle
  config and assert every generated declaration carries an explicit visibility
  modifier (the emitter already emits `public` everywhere).
