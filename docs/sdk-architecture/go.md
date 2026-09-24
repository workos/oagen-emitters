# Go SDK Architecture

Scenario B (fresh) -- no backwards-compatibility constraints.
Reference: stripe/stripe-go for idiomatic Go patterns.

## Architecture Overview

Single flat `workos` package. All types, services, and the client live in one package,
accessed as `workos.Organization`, `workos.NewClient(...)`, etc.

- **Client**: Instance-scoped via `NewClient(apiKey, ...Option)`
- **Services**: Unexported structs with exported methods, accessed as fields on Client
- **Models**: Exported structs with `json:"snake_case"` tags
- **Enums**: Typed `string` constants (no iota)
- **Params**: `*Params` structs with embedded `RequestOptions` for per-request overrides
- **Errors**: SDK-native error types implementing `error` interface
- **Pagination**: Iterator with `Next()` / `Current()` / `Err()`

## Naming Conventions

| IR Name                    | Go Name               | Context                                  |
| -------------------------- | --------------------- | ---------------------------------------- |
| `Organization` (model)     | `Organization`        | Struct type                              |
| `organization` (file)      | `organization.go`     | File name                                |
| `listUsers` (method)       | `ListUsers`           | Exported method                          |
| `user_id` (field)          | `UserID`              | Struct field (PascalCase, acronym-aware) |
| `Status` (enum)            | `Status`              | Type declaration                         |
| `active` (enum value)      | `StatusActive`        | Const: `{TypeName}{PascalValue}`         |
| `Organizations` (service)  | `organizationService` | Unexported struct                        |
| `organizations` (accessor) | `Organizations()`     | Client method returning service          |

### Acronym handling

Go convention preserves full-caps for common acronyms: `ID`, `URL`, `SSO`, `API`, `HTTP`,
`JWT`, `MFA`, `CORS`, `SAML`, `SCIM`, `RBAC`, `OAuth`, `OIDC`, `UUID`, `JSON`, `HTML`.

## Type Mapping

| IR TypeRef                   | Go Type                           |
| ---------------------------- | --------------------------------- |
| `primitive:string`           | `string`                          |
| `primitive:string:date`      | `string`                          |
| `primitive:string:date-time` | `string`                          |
| `primitive:string:uuid`      | `string`                          |
| `primitive:string:binary`    | `[]byte`                          |
| `primitive:integer`          | `int`                             |
| `primitive:number`           | `float64`                         |
| `primitive:boolean`          | `bool`                            |
| `primitive:unknown`          | `interface{}`                     |
| `array`                      | `[]T`                             |
| `model`                      | `*ModelName` (pointer for nested) |
| `enum`                       | `EnumType`                        |
| `nullable`                   | `*T` (pointer)                    |
| `union` (discriminated)      | `*NameUnion` (see below)          |
| `union` (untagged)           | `interface{}`                     |
| `map`                        | `map[string]T`                    |
| `literal:string`             | `string`                          |
| `literal:null`               | `interface{}`                     |

## Model Pattern

```go
// Organization represents an organization.
type Organization struct {
    ID          string            `json:"id"`
    Name        string            `json:"name"`
    Domains     []string          `json:"domains"`
    Metadata    map[string]string `json:"metadata,omitempty"`
    CreatedAt   string            `json:"created_at"`
    UpdatedAt   string            `json:"updated_at"`
}
```

- Required fields: value types (no pointer)
- Optional fields: pointer types with `omitempty`
- Nested models: always pointers
- JSON tags: snake_case matching the API wire format

## Discriminated Union Pattern

Go has no sum types, so a discriminated `oneOf` on a model field becomes a
sealed wrapper in `unions.go`: the discriminator plus one nil-able pointer per
variant. Each arm decodes into its own struct, so a payload never lands in the
wrong variant and no variant loses a field the others don't have.

```go
// APIKeyOwnerUnion is a discriminated union: exactly one variant pointer is set,
// and Type says which. Use the As* accessors to read a variant safely.
type APIKeyOwnerUnion struct {
    Type         APIKeyOwnerUnionType `json:"type"`
    Organization *APIKeyOwner         `json:"-"`
    User         *UserAPIKeyOwner     `json:"-"`

    raw json.RawMessage
}

type APIKeyOwnerUnionType string

const (
    APIKeyOwnerUnionTypeOrganization APIKeyOwnerUnionType = "organization"
    APIKeyOwnerUnionTypeUser         APIKeyOwnerUnionType = "user"
)

if user, ok := key.Owner.AsUser(); ok {
    fmt.Println(user.OrganizationID)
}
```

- Named `{FirstVariant}Union`; the discriminator type is `{Wrapper}{Field}`
- `UnmarshalJSON` switches on the discriminator; `MarshalJSON` encodes the set variant
- Unexported `raw` replays an unrecognized discriminator value, so a variant this
  SDK version predates round-trips instead of being dropped
- Single-variant unions get a wrapper too, so adding a variant later is additive
- **Model fields only.** Per-operation error unions are discriminated as well, but
  the parser names every leading variant after the status code (dozens of unrelated
  unions all want `Error400`), so those keep collapsing to their first variant

## Enum Pattern

```go
// OrganizationStatus represents the status of an organization.
type OrganizationStatus string

const (
    OrganizationStatusActive   OrganizationStatus = "active"
    OrganizationStatusInactive OrganizationStatus = "inactive"
)
```

## Resource/Service Pattern

```go
type organizationService struct {
    client *Client
}

// ListOrganizations lists all organizations.
func (s *organizationService) ListOrganizations(
    ctx context.Context,
    params *ListOrganizationsParams,
    opts ...RequestOption,
) *Iterator[Organization] {
    // ...
}

// GetOrganization retrieves an organization by ID.
func (s *organizationService) GetOrganization(
    ctx context.Context,
    id string,
    opts ...RequestOption,
) (*Organization, error) {
    // ...
}

// CreateOrganization creates a new organization.
func (s *organizationService) CreateOrganization(
    ctx context.Context,
    params *CreateOrganizationParams,
    opts ...RequestOption,
) (*Organization, error) {
    // ...
}

// DeleteOrganization deletes an organization by ID.
func (s *organizationService) DeleteOrganization(
    ctx context.Context,
    id string,
    opts ...RequestOption,
) error {
    // ...
}
```

### Parameter Structs

```go
type CreateOrganizationParams struct {
    Name     string            `json:"name"`
    Domains  []string          `json:"domains,omitempty"`
    Metadata map[string]string `json:"metadata,omitempty"`
}

type ListOrganizationsParams struct {
    After  *string `url:"after,omitempty"`
    Before *string `url:"before,omitempty"`
    Limit  *int    `url:"limit,omitempty"`
}
```

### Path parameters

Path parameters (IDs etc.) are positional function arguments, not part of params structs.

## Client Pattern

```go
// Client is the WorkOS API client.
type Client struct {
    apiKey     string
    baseURL    string
    httpClient *http.Client
    maxRetries int
    // Service accessors
    organizations *organizationService
    users         *userService
    // ...
}

// NewClient creates a new WorkOS client.
func NewClient(apiKey string, opts ...ClientOption) *Client {
    c := &Client{
        apiKey:     apiKey,
        baseURL:    "https://api.workos.com",
        httpClient: &http.Client{Timeout: 60 * time.Second},
        maxRetries: 3,
    }
    for _, opt := range opts {
        opt(c)
    }
    c.organizations = &organizationService{client: c}
    c.users = &userService{client: c}
    return c
}

// Organizations returns the organizations service.
func (c *Client) Organizations() *organizationService {
    return c.organizations
}
```

### Functional Options

```go
type ClientOption func(*Client)

func WithBaseURL(url string) ClientOption {
    return func(c *Client) { c.baseURL = url }
}

func WithHTTPClient(client *http.Client) ClientOption {
    return func(c *Client) { c.httpClient = client }
}

func WithMaxRetries(n int) ClientOption {
    return func(c *Client) { c.maxRetries = n }
}
```

### Per-Request Options

```go
type RequestOption func(*requestConfig)

type requestConfig struct {
    extraHeaders   http.Header
    timeout        time.Duration
    maxRetries     *int
    baseURL        string
    idempotencyKey string
}

func WithExtraHeaders(h http.Header) RequestOption {
    return func(r *requestConfig) { r.extraHeaders = h }
}

func WithTimeout(d time.Duration) RequestOption {
    return func(r *requestConfig) { r.timeout = d }
}

func WithIdempotencyKey(key string) RequestOption {
    return func(r *requestConfig) { r.idempotencyKey = key }
}
```

## Pagination Pattern

```go
// Iterator provides auto-pagination over list endpoints.
type Iterator[T any] struct {
    cur     *T
    items   []T
    err     error
    params  listParams
    fetcher func(context.Context, listParams) (*listResponse[T], error)
    ctx     context.Context
    done    bool
}

// Next advances the iterator. Returns false when done or on error.
func (it *Iterator[T]) Next() bool { ... }

// Current returns the current item.
func (it *Iterator[T]) Current() *T { return it.cur }

// Err returns any error from the last page fetch.
func (it *Iterator[T]) Err() error { return it.err }
```

## Error Handling

```go
type APIError struct {
    StatusCode int    `json:"-"`
    RequestID  string `json:"-"`
    Code       string `json:"code"`
    Message    string `json:"message"`
}

func (e *APIError) Error() string {
    return fmt.Sprintf("workos: %d %s: %s", e.StatusCode, e.Code, e.Message)
}

// Sentinel types for errors.Is() / type assertions
type AuthenticationError struct{ *APIError }
type NotFoundError struct{ *APIError }
type RateLimitExceededError struct{ *APIError }
type UnprocessableEntityError struct{ *APIError }
type ServerError struct{ *APIError }
```

## Retry Logic

- Exponential backoff with jitter: `min(base * 2^attempt + jitter, maxDelay)`
- Retryable statuses: 429, 500, 502, 503, 504
- Respect `Retry-After` header
- Auto-generate UUID idempotency key for POST requests, reused across retries
- Default max retries: 3

## Test Pattern

```go
func TestOrganizations_GetOrganization(t *testing.T) {
    server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        require.Equal(t, http.MethodGet, r.Method)
        require.Equal(t, "/organizations/org_123", r.URL.Path)
        w.Header().Set("Content-Type", "application/json")
        w.WriteHeader(http.StatusOK)
        fixture, _ := os.ReadFile("testdata/organization.json")
        w.Write(fixture)
    }))
    defer server.Close()

    client := workos.NewClient("sk_test", workos.WithBaseURL(server.URL))
    org, err := client.Organizations().GetOrganization(context.Background(), "org_123")
    require.NoError(t, err)
    require.Equal(t, "org_123", org.ID)
}
```

## Structural Guidelines

| Category           | Choice                                            |
| ------------------ | ------------------------------------------------- |
| Testing Framework  | `testing` + `github.com/stretchr/testify/require` |
| HTTP Mocking       | `net/http/httptest`                               |
| Documentation      | GoDoc comments                                    |
| Type Signatures    | Native Go types (inline)                          |
| Linting/Formatting | `gofmt` / `go vet`                                |
| HTTP Client        | `net/http` (stdlib)                               |
| JSON Parsing       | `encoding/json` (stdlib)                          |
| Package Manager    | Go modules (`go.mod`)                             |
| Build Tool         | `go build` / `go test`                            |

## Directory Structure (generated SDK)

```
workos-go/
+-- go.mod
+-- go.sum
+-- workos.go              // Package doc, NewClient, ClientOption, RequestOption
+-- client.go              // Client struct, HTTP request execution, retry logic
+-- errors.go              // Error types
+-- pagination.go          // Iterator[T]
+-- unions.go              // Sealed wrappers for discriminated unions
+-- {service}.go           // Models, enums, params, service client for each service
+-- {service}_test.go      // Tests for each service
+-- testdata/
|   +-- {model}.json       // JSON fixtures
```
