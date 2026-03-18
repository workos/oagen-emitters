# Node SDK Architecture

Derived from the existing WorkOS Node SDK at `workos-node`.

## Architecture Overview

- **Main client**: `WorkOS` class with HTTP methods (`get`, `post`, `put`, `patch`, `delete`) and readonly resource accessors (e.g., `workos.organizations`).
- **Resource classes**: One per service, constructor receives `WorkOS` client, async methods return deserialized domain types.
- **Dual interface system**: Domain interfaces (camelCase) and wire/response interfaces (snake_case with `Response` suffix).
- **Explicit serialization**: `deserialize{Model}` and `serialize{Options}` functions per model/operation.
- **Pagination**: `AutoPaginatable<T>` with cursor-based `after` param, `autoPagination()` async generator, 350ms rate-limit delay.
- **Error hierarchy**: Status-code-specific exception classes extending `Error`.
- **Constructor**: Accepts `string | WorkOSOptions`, env var fallback for `WORKOS_API_KEY`.
- **Factory**: `createWorkOS()` with overloads for `PublicWorkOS` (no API key) and full `WorkOS`.

## Naming Conventions

| Concept          | Convention | Example                                         |
| ---------------- | ---------- | ----------------------------------------------- |
| Class/Interface  | PascalCase | `Organization`, `UserManagement`                |
| Method           | camelCase  | `listOrganizations`, `createOrganization`       |
| Domain field     | camelCase  | `allowProfilesOutsideOrganization`              |
| Wire field       | snake_case | `allow_profiles_outside_organization`           |
| File             | kebab-case | `organization.interface.ts`                     |
| Directory        | kebab-case | `organizations/`, `user-management/`            |
| Service property | camelCase  | `workos.organizations`, `workos.userManagement` |

## Type Mapping

| IR TypeRef                | TypeScript (Domain) | TypeScript (Wire/Response) |
| ------------------------- | ------------------- | -------------------------- |
| `string`                  | `string`            | `string`                   |
| `string` (date/date-time) | `string`            | `string`                   |
| `integer`                 | `number`            | `number`                   |
| `number`                  | `number`            | `number`                   |
| `boolean`                 | `boolean`           | `boolean`                  |
| `unknown`                 | `any`               | `any`                      |
| `array(T)`                | `T[]`               | `T[]`                      |
| `model(Name)`             | `Name`              | `NameResponse`             |
| `enum(Name)`              | `Name`              | `Name`                     |
| `nullable(T)`             | `T \| null`         | `T \| null`                |
| `union(V1,V2)`            | `V1 \| V2`          | `V1 \| V2`                 |
| `map(V)`                  | `Record<string, V>` | `Record<string, V>`        |
| `literal(v)`              | `'v'`               | `'v'`                      |

## Model Pattern

From `src/organizations/interfaces/organization.interface.ts`:

```typescript
// Domain interface (camelCase)
export interface Organization {
  object: "organization";
  id: string;
  name: string;
  allowProfilesOutsideOrganization: boolean;
  domains: OrganizationDomain[];
  stripeCustomerId?: string;
  createdAt: string;
  updatedAt: string;
  externalId: string | null;
  metadata: Record<string, string>;
}

// Wire interface (snake_case, Response suffix)
export interface OrganizationResponse {
  object: "organization";
  id: string;
  name: string;
  allow_profiles_outside_organization: boolean;
  domains: OrganizationDomainResponse[];
  stripe_customer_id?: string;
  created_at: string;
  updated_at: string;
  external_id?: string | null;
  metadata?: Record<string, string>;
}
```

Key patterns:

- Required domain fields may be optional in the response interface
- Model refs in response use `Response` suffix
- Nullable fields use `| null`, optional fields use `?`

## Enum Pattern

String literal union types:

```typescript
export type OrganizationDomainVerificationStrategy = "dns" | "manual";
```

## Serialization Pattern

From `src/organizations/serializers/organization.serializer.ts`:

```typescript
export const deserializeOrganization = (
  organization: OrganizationResponse,
): Organization => ({
  object: organization.object,
  id: organization.id,
  name: organization.name,
  allowProfilesOutsideOrganization:
    organization.allow_profiles_outside_organization,
  domains: organization.domains.map(deserializeOrganizationDomain),
  ...(typeof organization.stripe_customer_id === "undefined"
    ? undefined
    : { stripeCustomerId: organization.stripe_customer_id }),
  createdAt: organization.created_at,
  updatedAt: organization.updated_at,
  externalId: organization.external_id ?? null,
  metadata: organization.metadata ?? {},
});

export const serializeCreateOrganizationOptions = (
  options: CreateOrganizationOptions,
): SerializedCreateOrganizationOptions => ({
  name: options.name,
  domain_data: options.domainData,
  external_id: options.externalId,
  metadata: options.metadata,
});
```

Key patterns:

- Deserialize: snake_case → camelCase, map nested models recursively
- Optional wire fields: spread conditional (`typeof x === 'undefined' ? undefined : { ... }`)
- Nullable domain fields: `?? null` fallback
- Default values for optional collections: `?? {}`

## Resource Pattern

From `src/organizations/organizations.ts`:

```typescript
export class Organizations {
  constructor(private readonly workos: WorkOS) {}

  async listOrganizations(
    options?: ListOrganizationsOptions,
  ): Promise<AutoPaginatable<Organization, ListOrganizationsOptions>> {
    return new AutoPaginatable(
      await fetchAndDeserialize<OrganizationResponse, Organization>(
        this.workos,
        "/organizations",
        deserializeOrganization,
        options,
      ),
      (params) =>
        fetchAndDeserialize<OrganizationResponse, Organization>(
          this.workos,
          "/organizations",
          deserializeOrganization,
          params,
        ),
      options,
    );
  }

  async createOrganization(
    payload: CreateOrganizationOptions,
    requestOptions: CreateOrganizationRequestOptions = {},
  ): Promise<Organization> {
    const { data } = await this.workos.post<OrganizationResponse>(
      "/organizations",
      serializeCreateOrganizationOptions(payload),
      requestOptions,
    );
    return deserializeOrganization(data);
  }

  async getOrganization(id: string): Promise<Organization> {
    const { data } = await this.workos.get<OrganizationResponse>(
      `/organizations/${id}`,
    );
    return deserializeOrganization(data);
  }

  async deleteOrganization(id: string): Promise<void> {
    await this.workos.delete(`/organizations/${id}`);
  }
}
```

Key patterns:

- Constructor takes `private readonly workos: WorkOS`
- List methods return `AutoPaginatable<T>` via `fetchAndDeserialize`
- Create/update methods: serialize body → POST → deserialize response
- Get methods: GET with path param → deserialize response
- Delete methods: return `Promise<void>`
- Idempotent POSTs: accept `requestOptions` with `idempotencyKey`

## Pagination Pattern

From `src/common/utils/pagination.ts`:

```typescript
export class AutoPaginatable<
  ResourceType,
  ParametersType extends PaginationOptions = PaginationOptions,
> {
  readonly object = 'list' as const;
  constructor(
    protected list: List<ResourceType>,
    private apiCall: (params: PaginationOptions) => Promise<List<ResourceType>>,
    options?: ParametersType,
  ) { ... }

  get data(): ResourceType[] { return this.list.data; }
  get listMetadata() { return this.list.listMetadata; }
  async autoPagination(): Promise<ResourceType[]> { ... }
}
```

## Error Handling

From `src/common/exceptions/`:

| Exception Class                  | Status Code |
| -------------------------------- | ----------- |
| `BadRequestException`            | 400         |
| `UnauthorizedException`          | 401         |
| `ApiKeyRequiredException`        | 403         |
| `NotFoundException`              | 404         |
| `ConflictException`              | 409         |
| `UnprocessableEntityException`   | 422         |
| `RateLimitExceededException`     | 429         |
| `GenericServerException`         | 500+        |
| `OAuthException`                 | varies      |
| `NoApiKeyProvidedException`      | runtime     |
| `SignatureVerificationException` | runtime     |

Each exception: extends `Error`, has `readonly status`, `readonly name`, `requestID`, optional `code`.

## Client Architecture

From `src/workos.ts`:

```typescript
export class WorkOS {
  readonly baseURL: string;
  readonly client: HttpClient;
  readonly organizations = new Organizations(this);
  // ... other resource accessors

  constructor(keyOrOptions?: string | WorkOSOptions, maybeOptions?: WorkOSOptions) { ... }

  async post<Result, Entity>(path, entity, options?: PostOptions): Promise<{ data: Result }> { ... }
  async get<Result>(path, options?: GetOptions): Promise<{ data: Result }> { ... }
  async put<Result, Entity>(path, entity, options?): Promise<{ data: Result }> { ... }
  async delete(path, options?): Promise<void> { ... }
}
```

## HTTP Client (Retry Logic)

From `src/common/net/http-client.ts`:

- `MAX_RETRY_ATTEMPTS = 3`
- `BACKOFF_MULTIPLIER = 1.5`
- `MINIMUM_SLEEP_TIME_IN_MILLISECONDS = 500`
- `RETRY_STATUS_CODES = [408, 500, 502, 504]`
- Path-specific retry: only for `/fga/`, `/vault/`, `/audit_logs/events`
- Jitter: `sleepTime * (Math.random() + 0.5)`

## Testing Pattern

Framework: Jest + `jest-fetch-mock`

From `src/organizations/organizations.spec.ts`:

```typescript
import fetch from "jest-fetch-mock";
import {
  fetchOnce,
  fetchURL,
  fetchSearchParams,
  fetchBody,
} from "../common/utils/test-utils";

const workos = new WorkOS("sk_test_Sz3IQjepeSWaI4cMS4ms4sMuU");

describe("Organizations", () => {
  beforeEach(() => fetch.resetMocks());

  it("returns organizations and metadata", async () => {
    fetchOnce(listOrganizationsFixture);
    const { data, listMetadata } =
      await workos.organizations.listOrganizations();
    expect(fetchSearchParams()).toEqual({ order: "desc" });
    expect(data).toHaveLength(7);
  });
});
```

Test utilities: `fetchOnce`, `fetchURL`, `fetchSearchParams`, `fetchHeaders`, `fetchBody`.

## Directory Structure

```
src/
├── workos.ts                    # Main client class
├── index.ts                     # Barrel export
├── factory.ts                   # createWorkOS factory
├── common/
│   ├── exceptions/              # Error hierarchy
│   ├── interfaces/              # WorkOSOptions, PostOptions, GetOptions, PaginationOptions
│   ├── net/                     # HttpClient abstract base
│   ├── serializers/             # list, event, pagination serializers
│   └── utils/                   # AutoPaginatable, fetchAndDeserialize, test-utils
├── {service}/
│   ├── {service}.ts             # Resource class
│   ├── {service}.spec.ts        # Tests
│   ├── interfaces/              # Model, Response, Options interfaces
│   │   └── index.ts             # Re-exports
│   ├── serializers/             # Serialize/deserialize functions
│   │   └── index.ts             # Re-exports
│   └── fixtures/                # JSON test data
```

## Structural Guidelines

| Category          | Choice                                   |
| ----------------- | ---------------------------------------- |
| Testing Framework | Jest                                     |
| HTTP Mocking      | jest-fetch-mock                          |
| Type Signatures   | TypeScript interfaces (inline)           |
| HTTP Client       | Abstract HttpClient with FetchHttpClient |
| JSON Parsing      | Built-in JSON.parse/stringify            |
| Package Manager   | npm                                      |
| Build Tool        | TypeScript compiler + bundler            |
| Module Format     | CJS + ESM dual                           |

## Additional Generator Files

Beyond the standard scaffold, this emitter requires:

- `serializers.ts` — explicit serialize/deserialize function generation
- `common.ts` — AutoPaginatable, fetchAndDeserialize, List types, shared utilities
- `config.ts` — WorkOSOptions, PostOptions, GetOptions, PaginationOptions
