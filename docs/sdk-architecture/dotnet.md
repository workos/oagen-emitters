# C# / .NET SDK Architecture

Target: .NET 8.0 | Serialization: Newtonsoft.Json | Test: xUnit + Moq

## Architecture Overview

The SDK follows a service-per-domain pattern. A static `WorkOS` entry point holds a singleton `WorkOSClient`. Each service (e.g., `OrganizationsService`) inherits from a shared `Service` base class that lazily resolves the client. All IO is async with `CancellationToken` support.

**Runtime files (hand-maintained, `@oagen-ignore-file`):**

- `WorkOS.cs` — static entry point
- `Client/WorkOSClient.cs` — HTTP execution, retry, error translation
- `Client/_interfaces/WorkOSOptions.cs` — client config
- `Client/_interfaces/WorkOSRequest.cs` — request DTO
- `Client/Utilities/RequestUtilities.cs` — JSON/query serialization
- `Services/Webhooks/WebhookService.cs` — webhook signature verification helper
- `Services/Webhooks/Entities/Webhook.cs` — webhook event envelope used by the helper
- `Services/Webhooks/Exceptions/WorkOSWebhookException.cs` — webhook verification exception
- `Services/_common/Service.cs` — base service class
- `Services/_common/_interfaces/BaseOptions.cs` — marker base for options
- `Services/_common/_interfaces/ListOptions.cs` — pagination base options
- `Services/_common/Entities/WorkOSList.cs` — pagination wrapper
- `Services/_common/Entities/ListMetadata.cs` — cursor metadata
- `Services/_common/Enums/PaginationOrder.cs` — asc/desc enum

**Generated files (emitter output):**

- `Services/{Mount}/Entities/*.cs` — model classes
- `Services/{Mount}/Enums/*.cs` — enum types
- `Services/{Mount}/{Mount}Service.cs` — service class with methods
- `Services/{Mount}/_interfaces/*Options.cs` — request option classes
- `test/WorkOSTests/Tests/*Test.cs` — generated service tests
- `test/WorkOSTests/testdata/*.json` — generated fixtures
- `test/WorkOSTests/xunit.runner.json` — generated xUnit runner config

## Naming Conventions

| IR Concept     | C# Convention                | Example                     |
| -------------- | ---------------------------- | --------------------------- |
| Model name     | PascalCase                   | `Organization`              |
| Enum name      | PascalCase                   | `ConnectionState`           |
| Field/property | PascalCase                   | `EmailVerified`             |
| Method         | PascalCase (no Async suffix) | `GetOrganization`           |
| File           | PascalCase.cs                | `Organization.cs`           |
| Service class  | `{Mount}Service`             | `OrganizationsService`      |
| Options class  | `{Action}{Entity}Options`    | `CreateOrganizationOptions` |
| Namespace      | `WorkOS`                     | —                           |

## Type Mapping

| IR TypeRef                     | C# Type                 |
| ------------------------------ | ----------------------- |
| `primitive:string`             | `string`                |
| `primitive:string` (date-time) | `string`                |
| `primitive:string` (uuid)      | `string`                |
| `primitive:string` (binary)    | `byte[]`                |
| `primitive:integer`            | `int`                   |
| `primitive:integer` (int64)    | `long`                  |
| `primitive:number`             | `double`                |
| `primitive:boolean`            | `bool`                  |
| `primitive:unknown`            | `object`                |
| `model:Foo`                    | `Foo` (reference type)  |
| `enum:Foo`                     | `Foo` (value type)      |
| `array`                        | `List<T>`               |
| `map`                          | `Dictionary<string, T>` |
| `nullable` (value type)        | `T?`                    |
| `nullable` (reference type)    | `T`                     |
| `union` (single)               | that type               |
| `union` (multiple)             | `object`                |

## Model Pattern

```csharp
namespace WorkOS
{
    using Newtonsoft.Json;

    /// <summary>Represents an organization.</summary>
    public class Organization
    {
        [JsonProperty("id")]
        public string Id { get; set; }

        [JsonProperty("name")]
        public string Name { get; set; }

        [JsonProperty("allow_profiles_outside_organization")]
        public bool AllowProfilesOutsideOrganization { get; set; }

        [JsonProperty("created_at")]
        public string CreatedAt { get; set; }
    }
}
```

## Enum Pattern

```csharp
namespace WorkOS
{
    using System.Runtime.Serialization;
    using Newtonsoft.Json;
    using Newtonsoft.Json.Converters;

    [JsonConverter(typeof(StringEnumConverter))]
    public enum OrganizationDomainState
    {
        [EnumMember(Value = "failed")]
        Failed,

        [EnumMember(Value = "pending")]
        Pending,

        [EnumMember(Value = "verified")]
        Verified,
    }
}
```

## Resource/Service Pattern

```csharp
namespace WorkOS
{
    using System.Net.Http;
    using System.Threading;
    using System.Threading.Tasks;

    public class OrganizationsService : Service
    {
        public OrganizationsService() { }
        public OrganizationsService(WorkOSClient client) : base(client) { }

        public async Task<Organization> GetOrganization(
            string id,
            CancellationToken cancellationToken = default)
        {
            var request = new WorkOSRequest
            {
                Method = HttpMethod.Get,
                Path = $"/organizations/{id}",
            };
            return await this.Client.MakeAPIRequest<Organization>(request, cancellationToken);
        }

        public async Task<WorkOSList<Organization>> ListOrganizations(
            ListOrganizationsOptions options = null,
            CancellationToken cancellationToken = default)
        {
            var request = new WorkOSRequest
            {
                Method = HttpMethod.Get,
                Path = "/organizations",
                Options = options,
            };
            return await this.Client.MakeAPIRequest<WorkOSList<Organization>>(request, cancellationToken);
        }

        public async Task<Organization> CreateOrganization(
            CreateOrganizationOptions options,
            CancellationToken cancellationToken = default)
        {
            var request = new WorkOSRequest
            {
                Method = HttpMethod.Post,
                Path = "/organizations",
                Options = options,
            };
            return await this.Client.MakeAPIRequest<Organization>(request, cancellationToken);
        }

        public async Task DeleteOrganization(
            string id,
            CancellationToken cancellationToken = default)
        {
            var request = new WorkOSRequest
            {
                Method = HttpMethod.Delete,
                Path = $"/organizations/{id}",
            };
            await this.Client.MakeRawAPIRequest(request, cancellationToken);
        }
    }
}
```

## Options Pattern

```csharp
namespace WorkOS
{
    using Newtonsoft.Json;

    public class CreateOrganizationOptions : BaseOptions
    {
        [JsonProperty("name")]
        public string Name { get; set; }

        [JsonProperty("domain_data")]
        public List<OrganizationDomainDataOptions> DomainData { get; set; }
    }

    public class ListOrganizationsOptions : ListOptions
    {
        [JsonProperty("domains")]
        public string[] Domains { get; set; }
    }
}
```

## Pagination Pattern

```csharp
// Returned by list methods — NOT an iterator
public class WorkOSList<T>
{
    [JsonProperty("data")]
    public List<T> Data { get; set; }

    [JsonProperty("list_metadata")]
    public ListMetadata ListMetadata { get; set; }
}
```

## Error Handling

The runtime translates HTTP status codes to SDK-native exceptions:

- `AuthenticationError` (401)
- `NotFoundError` (404)
- `UnprocessableEntityError` (422)
- `RateLimitExceededError` (429)
- `ServerError` (500+)

These are hand-maintained in the runtime. The emitter generates error-handling _tests_, not the error classes themselves.

## Hidden Parameter Injection

For operations with defaults/inferFromClient, the service method sets properties on the options before making the request:

```csharp
public async Task<AuthenticationResponse> AuthenticateWithPassword(
    AuthenticateWithPasswordOptions options,
    CancellationToken cancellationToken = default)
{
    options.GrantType = "password";
    options.ClientId = this.Client.ClientId;
    options.ClientSecret = this.Client.ApiKey;
    var request = new WorkOSRequest
    {
        Method = HttpMethod.Post,
        Path = "/user_management/authenticate",
        Options = options,
    };
    return await this.Client.MakeAPIRequest<AuthenticationResponse>(request, cancellationToken);
}
```

## Testing Pattern

xUnit + Moq with HttpMock utility:

```csharp
public class OrganizationsServiceTest
{
    private readonly HttpMock httpMock;
    private readonly OrganizationsService service;

    public OrganizationsServiceTest()
    {
        this.httpMock = new HttpMock();
        var client = new WorkOSClient(new WorkOSOptions
        {
            ApiKey = "sk_test",
            HttpClient = this.httpMock.HttpClient,
        });
        this.service = new OrganizationsService(client);
    }

    [Fact]
    public async Task TestGetOrganization()
    {
        var fixture = File.ReadAllText("testdata/organization.json");
        this.httpMock.MockResponse(HttpMethod.Get, "/organizations/org_01234", HttpStatusCode.OK, fixture);
        var result = await this.service.GetOrganization("org_01234");
        Assert.NotNull(result);
        Assert.Equal("org_01234", result.Id);
        this.httpMock.AssertRequestWasMade(HttpMethod.Get, "/organizations/org_01234");
    }
}
```

## Structural Guidelines

| Category           | Choice                      |
| ------------------ | --------------------------- |
| Target Framework   | .NET 8.0                    |
| HTTP Client        | System.Net.Http.HttpClient  |
| JSON Parsing       | Newtonsoft.Json 13.x        |
| Testing Framework  | xUnit 2.x                   |
| HTTP Mocking       | Moq 4.x (HttpClientHandler) |
| Linting/Formatting | StyleCop.Analyzers          |
| Package Manager    | NuGet                       |
| Build Tool         | dotnet CLI / MSBuild        |

## Directory Structure

```
src/WorkOS.net/
├── WorkOS.cs                          # @oagen-ignore-file
├── Client/                            # @oagen-ignore-file (all)
│   ├── WorkOSClient.cs
│   ├── _interfaces/
│   └── Utilities/
├── Services/
│   ├── _common/                       # @oagen-ignore-file (all)
│   ├── Webhooks/                      # Mixed hand-written + generated
│   │   ├── Entities/Webhook.cs        # @oagen-ignore-file
│   │   ├── Exceptions/WorkOSWebhookException.cs
│   │   ├── WebhookService.cs          # @oagen-ignore-file
│   │   └── WebhooksService.cs         # Generated
│   └── {ServiceName}/                 # Generated
│       ├── {ServiceName}Service.cs
│       ├── _interfaces/
│       │   └── {Action}{Entity}Options.cs
│       ├── Entities/
│       │   └── {Entity}.cs
│       └── Enums/
│           └── {EnumName}.cs
test/WorkOSTests/
├── Utilities/HttpMock.cs              # @oagen-ignore-file
├── Client/                            # @oagen-ignore-file
├── Services/Webhooks/WebhookTests.cs  # @oagen-ignore-file
├── Tests/{ServiceName}Test.cs         # Generated
└── xunit.runner.json                  # Generated
```
