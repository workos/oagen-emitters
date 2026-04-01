# PHP SDK Architecture

## Overview

A PHP 8.2+ SDK using readonly classes, backed enums, Guzzle for HTTP, and PHPUnit for testing. PSR-4 autoloading with Composer.

## Naming Conventions

| IR Name               | PHP Convention      | Example                |
|-----------------------|---------------------|------------------------|
| `UserProfile` (class) | PascalCase          | `UserProfile`          |
| `UserProfile` (file)  | PascalCase.php      | `UserProfile.php`      |
| `listUsers` (method)  | camelCase           | `listUsers`            |
| `user_id` (field)     | camelCase            | `userId`               |
| `ACTIVE` (enum case)  | PascalCase           | `Active`               |

## Type Mapping

| IR TypeRef                       | PHP Type Hint         | PHPDoc Type             |
|----------------------------------|-----------------------|-------------------------|
| `string`                         | `string`              | `string`                |
| `string` (date)                  | `string`              | `string`                |
| `string` (date-time)             | `\DateTimeImmutable`  | `\DateTimeImmutable`    |
| `string` (uuid)                  | `string`              | `string`                |
| `string` (binary)                | `string`              | `string`                |
| `integer`                        | `int`                 | `int`                   |
| `number`                         | `float`               | `float`                 |
| `boolean`                        | `bool`                | `bool`                  |
| `unknown`                        | `mixed`               | `mixed`                 |
| `array<T>`                       | `array`               | `array<T>`              |
| `model Foo`                      | `Foo`                 | `Foo`                   |
| `enum Foo`                       | `Foo`                 | `Foo`                   |
| `nullable<T>`                    | `?T`                  | `T\|null`               |
| `union<A,B>`                     | `A\|B`                | `A\|B`                  |
| `map<string,V>`                  | `array`               | `array<string, V>`      |
| `literal "foo"`                  | `string`              | `string`                |

## Model Pattern

Readonly classes with constructor promotion, `fromArray()` factory, and `toArray()` serialization:

```php
<?php

namespace WorkOS\Models;

readonly class Organization implements \JsonSerializable
{
    public function __construct(
        public string $id,
        public string $name,
        public ?string $slug = null,
        public ?\DateTimeImmutable $createdAt = null,
    ) {}

    public static function fromArray(array $data): static
    {
        return new static(
            id: $data['id'],
            name: $data['name'],
            slug: $data['slug'] ?? null,
            createdAt: isset($data['created_at'])
                ? new \DateTimeImmutable($data['created_at'])
                : null,
        );
    }

    public function toArray(): array
    {
        return array_filter([
            'id' => $this->id,
            'name' => $this->name,
            'slug' => $this->slug,
            'created_at' => $this->createdAt?->format(\DateTimeInterface::RFC3339_EXTENDED),
        ], fn ($v) => $v !== null);
    }

    public function jsonSerialize(): array
    {
        return $this->toArray();
    }
}
```

## Enum Pattern

PHP 8.1+ backed enums:

```php
<?php

namespace WorkOS\Enums;

enum OrganizationStatus: string
{
    case Active = 'active';
    case Inactive = 'inactive';

    public static function tryFromValue(string $value): self|string
    {
        return self::tryFrom($value) ?? $value;
    }
}
```

## Resource Pattern

Resource classes with typed methods, injected HTTP client:

```php
<?php

namespace WorkOS\Resources;

use WorkOS\HttpClient;
use WorkOS\Models\Organization;
use WorkOS\PaginatedResponse;
use WorkOS\RequestOptions;

class Organizations
{
    public function __construct(
        private readonly HttpClient $client,
    ) {}

    public function get(string $id, ?RequestOptions $options = null): Organization
    {
        $response = $this->client->request(
            method: 'GET',
            path: "organizations/{$id}",
            options: $options,
        );
        return Organization::fromArray($response);
    }

    public function list(
        ?int $limit = null,
        ?string $after = null,
        ?RequestOptions $options = null,
    ): PaginatedResponse
    {
        $response = $this->client->request(
            method: 'GET',
            path: 'organizations',
            query: array_filter([
                'limit' => $limit,
                'after' => $after,
            ], fn ($v) => $v !== null),
            options: $options,
        );
        return PaginatedResponse::fromArray($response, Organization::class);
    }
}
```

## Client Architecture

Main client with resource accessors:

```php
<?php

namespace WorkOS;

class WorkOS
{
    private HttpClient $httpClient;
    private ?Resources\Organizations $organizations = null;

    public function __construct(
        string $apiKey = null,
        string $baseUrl = 'https://api.workos.com',
        int $timeout = 60,
        int $maxRetries = 3,
    ) {
        $apiKey ??= getenv('WORKOS_API_KEY') ?: '';
        $this->httpClient = new HttpClient($apiKey, $baseUrl, $timeout, $maxRetries);
    }

    public function organizations(): Resources\Organizations
    {
        return $this->organizations ??= new Resources\Organizations($this->httpClient);
    }
}
```

## Error Handling

Exception hierarchy extending a base `ApiException`:

```php
<?php

namespace WorkOS\Exceptions;

class ApiException extends \Exception { /* status_code, request_id, etc. */ }
class AuthenticationException extends ApiException {}
class BadRequestException extends ApiException {}
class NotFoundException extends ApiException {}
class UnprocessableEntityException extends ApiException {}
class RateLimitExceededException extends ApiException {}
class ServerException extends ApiException {}
class ConfigurationException extends \Exception {}
class ConnectionException extends \Exception {}
class TimeoutException extends \Exception {}
```

## Pagination

Generic paginated response with auto-iteration:

```php
<?php

namespace WorkOS;

class PaginatedResponse implements \IteratorAggregate
{
    public function __construct(
        public readonly array $data,
        public readonly array $listMetadata,
        private readonly ?\Closure $fetchPage = null,
    ) {}

    public function hasMore(): bool { return ($this->listMetadata['after'] ?? null) !== null; }

    public function getIterator(): \Generator
    {
        $page = $this;
        while (true) {
            yield from $page->data;
            if (!$page->hasMore() || $page->fetchPage === null) break;
            $page = ($page->fetchPage)(['after' => $page->listMetadata['after']]);
        }
    }
}
```

## Retry Logic

Exponential backoff with jitter. Retryable statuses: 429, 500, 502, 503, 504. Respects `Retry-After` header.

## Testing

PHPUnit with Guzzle `MockHandler`:

```php
<?php

namespace Tests\Resources;

use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Psr7\Response;
use PHPUnit\Framework\TestCase;
use WorkOS\WorkOS;

class OrganizationsTest extends TestCase
{
    public function testGet(): void
    {
        $fixture = json_decode(file_get_contents(__DIR__ . '/../Fixtures/organization.json'), true);
        $mock = new MockHandler([new Response(200, [], json_encode($fixture))]);
        $client = new WorkOS(apiKey: 'test', handler: HandlerStack::create($mock));

        $result = $client->organizations()->get('org_01234');
        $this->assertInstanceOf(\WorkOS\Models\Organization::class, $result);
    }
}
```

## Structural Guidelines

| Category           | Choice                     |
|--------------------|----------------------------|
| PHP Version        | 8.2+                       |
| HTTP Client        | Guzzle 7                   |
| Testing            | PHPUnit 11                 |
| HTTP Mocking       | Guzzle MockHandler         |
| Documentation      | PHPDoc                     |
| Type Signatures    | Native type hints + PHPDoc |
| Linting/Formatting | PHP CS Fixer               |
| JSON Parsing       | Native json_decode/encode  |
| Package Manager    | Composer                   |
| Build Tool         | N/A (interpreted)          |

## Directory Structure

```
src/
├── {Namespace}.php              # Main client class
├── HttpClient.php               # HTTP client with retry logic
├── PaginatedResponse.php        # Cursor pagination
├── RequestOptions.php           # Per-request options
├── Enums/
│   └── {EnumName}.php
├── Models/
│   └── {ModelName}.php
├── Resources/
│   └── {ServiceName}.php
└── Exceptions/
    ├── ApiException.php
    ├── AuthenticationException.php
    └── ...
tests/
├── Fixtures/
│   └── {model_name}.json
├── Resources/
│   └── {ServiceName}Test.php
├── Models/
│   └── {ModelName}Test.php
└── ClientTest.php
composer.json
phpunit.xml
```
