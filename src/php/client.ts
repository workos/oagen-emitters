import type { ApiSpec, EmitterContext, GeneratedFile, Service } from '@workos/oagen';
import { servicePropertyName, groupServicesByNamespace } from './naming.js';
import { resolveResourceClassName } from './resources.js';

/**
 * Generate the main PHP client class, HTTP client, and project scaffolding.
 */
export function generateClient(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  assertPublicClientReachability(spec, ctx);

  const files: GeneratedFile[] = [];

  files.push(...generateMainClient(spec, ctx));
  files.push(...generateHttpClient(ctx));
  files.push(...generateRequestOptions(ctx));
  files.push(...generatePaginatedResponse(ctx));
  files.push(...generateComposerJson(ctx));
  files.push(...generatePhpunitXml(ctx));

  return files;
}

/**
 * Build a map from IR service name to the public access path on the client.
 */
export function buildServiceAccessPaths(services: Service[], ctx: EmitterContext): Map<string, string> {
  const { standalone, namespaces } = groupServicesByNamespace(services, ctx);
  const paths = new Map<string, string>();

  for (const entry of standalone) {
    paths.set(entry.service.name, `${entry.prop}()`);
  }

  for (const ns of namespaces) {
    if (ns.baseEntry) {
      paths.set(ns.baseEntry.service.name, `${ns.prefix}()`);
    }
    for (const entry of ns.entries) {
      paths.set(entry.service.name, `${ns.prefix}()->${entry.subProp}()`);
    }
  }

  return paths;
}

function assertPublicClientReachability(spec: ApiSpec, ctx: EmitterContext): void {
  const accessPaths = buildServiceAccessPaths(spec.services, ctx);
  const unreachableServices = spec.services
    .filter((service) => service.operations.length > 0 && !accessPaths.has(service.name))
    .map((service) => service.name);

  if (unreachableServices.length > 0) {
    throw new Error(`PHP emitter reachability audit failed for services: ${unreachableServices.join(', ')}`);
  }
}

function generateMainClient(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  groupServicesByNamespace(spec.services, ctx); // validates service grouping
  const lines: string[] = [];

  lines.push('<?php');
  lines.push('');
  lines.push(`namespace ${ctx.namespacePascal};`);
  lines.push('');

  // Import resource classes
  for (const service of spec.services) {
    if (service.operations.length === 0) continue;
    const resourceName = resolveResourceClassName(service, ctx);
    lines.push(`use ${ctx.namespacePascal}\\Resources\\${resourceName};`);
  }
  lines.push('');

  lines.push(`class ${ctx.namespacePascal}`);
  lines.push('{');
  lines.push('    private HttpClient $httpClient;');

  // Lazy resource instances
  for (const service of spec.services) {
    if (service.operations.length === 0) continue;
    const resourceName = resolveResourceClassName(service, ctx);
    const propName = servicePropertyName(resourceName);
    lines.push(`    private ?${resourceName} $${propName}Instance = null;`);
  }
  lines.push('');

  // Constructor
  lines.push('    public function __construct(');
  lines.push('        ?string $apiKey = null,');
  lines.push(`        string $baseUrl = '${spec.baseUrl || 'https://api.workos.com'}',`);
  lines.push('        int $timeout = 60,');
  lines.push('        int $maxRetries = 3,');
  lines.push('        ?\\GuzzleHttp\\HandlerStack $handler = null,');
  lines.push('    ) {');
  lines.push("        $apiKey ??= getenv('WORKOS_API_KEY') ?: '';");
  lines.push('        if (empty($apiKey)) {');
  lines.push(
    "            throw new Exceptions\\ConfigurationException('API key is required. Set WORKOS_API_KEY or pass apiKey.');",
  );
  lines.push('        }');
  lines.push('        $this->httpClient = new HttpClient($apiKey, $baseUrl, $timeout, $maxRetries, $handler);');
  lines.push('    }');

  // Resource accessors
  for (const service of spec.services) {
    if (service.operations.length === 0) continue;
    const resourceName = resolveResourceClassName(service, ctx);
    const propName = servicePropertyName(resourceName);
    const methodName = servicePropertyName(resourceName);

    lines.push('');
    lines.push(`    public function ${methodName}(): ${resourceName}`);
    lines.push('    {');
    lines.push(`        return $this->${propName}Instance ??= new ${resourceName}($this->httpClient);`);
    lines.push('    }');
  }

  lines.push('}');

  return [
    {
      path: `src/${ctx.namespacePascal}.php`,
      content: lines.join('\n'),
      integrateTarget: true,
      overwriteExisting: true,
    },
  ];
}

function generateHttpClient(ctx: EmitterContext): GeneratedFile[] {
  const ns = ctx.namespacePascal;

  const content = `<?php

namespace ${ns};

use GuzzleHttp\\Client;
use GuzzleHttp\\Exception\\ConnectException;
use GuzzleHttp\\Exception\\RequestException;
use GuzzleHttp\\HandlerStack;
use Psr\\Http\\Message\\ResponseInterface;
use ${ns}\\Exceptions\\ApiException;
use ${ns}\\Exceptions\\AuthenticationException;
use ${ns}\\Exceptions\\BadRequestException;
use ${ns}\\Exceptions\\AuthorizationException;
use ${ns}\\Exceptions\\ConflictException;
use ${ns}\\Exceptions\\ConnectionException;
use ${ns}\\Exceptions\\NotFoundException;
use ${ns}\\Exceptions\\RateLimitExceededException;
use ${ns}\\Exceptions\\ServerException;
use ${ns}\\Exceptions\\TimeoutException;
use ${ns}\\Exceptions\\UnprocessableEntityException;

class HttpClient
{
    private Client $client;
    private int $maxRetries;

    private const STATUS_CODE_EXCEPTIONS = [
        400 => BadRequestException::class,
        401 => AuthenticationException::class,
        403 => AuthorizationException::class,
        404 => NotFoundException::class,
        409 => ConflictException::class,
        422 => UnprocessableEntityException::class,
        429 => RateLimitExceededException::class,
    ];

    private const RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 504];

    public function __construct(
        private readonly string $apiKey,
        string $baseUrl,
        int $timeout,
        int $maxRetries,
        ?HandlerStack $handler = null,
    ) {
        $this->maxRetries = $maxRetries;
        $this->client = new Client([
            'base_uri' => rtrim($baseUrl, '/') . '/',
            'timeout' => $timeout,
            'headers' => [
                'Authorization' => 'Bearer ' . $this->apiKey,
                'Content-Type' => 'application/json',
                'User-Agent' => '${ns}-php/0.1.0',
            ],
            'handler' => $handler,
            'http_errors' => false,
        ]);
    }

    /**
     * @param array<string, mixed>|null $query
     * @param array<string, mixed>|null $body
     * @param RequestOptions|null $options
     * @return array<string, mixed>
     */
    public function request(
        string $method,
        string $path,
        ?array $query = null,
        ?array $body = null,
        ?RequestOptions $options = null,
    ): array {
        $guzzleOptions = [];

        if ($query !== null && count($query) > 0) {
            $guzzleOptions['query'] = $query;
        }

        if ($body !== null && count($body) > 0) {
            $guzzleOptions['json'] = $body;
        }

        $extraHeaders = [];
        if ($options !== null) {
            if ($options->extraHeaders !== null) {
                $extraHeaders = $options->extraHeaders;
            }
            if ($options->timeout !== null) {
                $guzzleOptions['timeout'] = $options->timeout;
            }
            if ($options->idempotencyKey !== null) {
                $extraHeaders['Idempotency-Key'] = $options->idempotencyKey;
            }
        }

        if (count($extraHeaders) > 0) {
            $guzzleOptions['headers'] = $extraHeaders;
        }

        $maxRetries = $options?->maxRetries ?? $this->maxRetries;

        return $this->requestWithRetry($method, $path, $guzzleOptions, $maxRetries);
    }

    /**
     * @return array<string, mixed>
     */
    private function requestWithRetry(string $method, string $path, array $options, int $maxRetries): array
    {
        $attempt = 0;
        while (true) {
            try {
                $response = $this->client->request($method, $path, $options);
                $statusCode = $response->getStatusCode();

                if ($statusCode >= 200 && $statusCode < 300) {
                    $responseBody = (string) $response->getBody();
                    if (empty($responseBody)) {
                        return [];
                    }
                    return json_decode($responseBody, true) ?? [];
                }

                if (in_array($statusCode, self::RETRYABLE_STATUS_CODES) && $attempt < $maxRetries) {
                    $retryAfter = $this->getRetryDelay($response, $attempt);
                    usleep((int) ($retryAfter * 1_000_000));
                    $attempt++;
                    continue;
                }

                $this->throwForStatus($response);
            } catch (ConnectException $e) {
                if ($attempt < $maxRetries) {
                    usleep((int) ($this->calculateBackoff($attempt) * 1_000_000));
                    $attempt++;
                    continue;
                }
                if (str_contains($e->getMessage(), 'timed out')) {
                    throw new TimeoutException($e->getMessage(), $e);
                }
                throw new ConnectionException($e->getMessage(), 0, $e);
            }
        }
    }

    private function throwForStatus(ResponseInterface $response): never
    {
        $statusCode = $response->getStatusCode();
        $body = json_decode((string) $response->getBody(), true) ?? [];
        $requestId = $response->getHeaderLine('X-Request-ID') ?: null;

        $exceptionClass = self::STATUS_CODE_EXCEPTIONS[$statusCode] ?? null;

        if ($exceptionClass !== null) {
            throw $exceptionClass::fromResponse($statusCode, $body, $requestId);
        }

        if ($statusCode >= 500) {
            throw ServerException::fromResponse($statusCode, $body, $requestId);
        }

        throw ApiException::fromResponse($statusCode, $body, $requestId);
    }

    private function getRetryDelay(ResponseInterface $response, int $attempt): float
    {
        $retryAfter = $response->getHeaderLine('Retry-After');
        if ($retryAfter !== '') {
            if (is_numeric($retryAfter)) {
                return (float) $retryAfter;
            }
            $date = \\DateTimeImmutable::createFromFormat('D, d M Y H:i:s T', $retryAfter);
            if ($date !== false) {
                return max(0, $date->getTimestamp() - time());
            }
        }
        return $this->calculateBackoff($attempt);
    }

    private function calculateBackoff(int $attempt): float
    {
        $base = min(pow(2, $attempt), 30);
        $jitter = $base * (mt_rand() / mt_getrandmax()) * 0.5;
        return $base + $jitter;
    }
}`;

  return [
    {
      path: 'src/HttpClient.php',
      content,
      integrateTarget: true,
      overwriteExisting: true,
    },
  ];
}

function generateRequestOptions(ctx: EmitterContext): GeneratedFile[] {
  return [
    {
      path: 'src/RequestOptions.php',
      content: `<?php

namespace ${ctx.namespacePascal};

class RequestOptions
{
    public function __construct(
        /** @var array<string, string>|null */
        public readonly ?array $extraHeaders = null,
        public readonly ?float $timeout = null,
        public readonly ?string $idempotencyKey = null,
        public readonly ?int $maxRetries = null,
        public readonly ?string $baseUrl = null,
    ) {}
}`,
      integrateTarget: true,
      overwriteExisting: true,
    },
  ];
}

function generatePaginatedResponse(ctx: EmitterContext): GeneratedFile[] {
  return [
    {
      path: 'src/PaginatedResponse.php',
      content: `<?php

namespace ${ctx.namespacePascal};

/**
 * @template T
 * @implements \\IteratorAggregate<int, T>
 */
class PaginatedResponse implements \\IteratorAggregate
{
    /**
     * @param array<T> $data
     * @param array<string, mixed> $listMetadata
     * @param (\\Closure(array): PaginatedResponse<T>)|null $fetchPage
     */
    public function __construct(
        public readonly array $data,
        public readonly array $listMetadata,
        private readonly ?\\Closure $fetchPage = null,
    ) {}

    /**
     * @template M
     * @param array<string, mixed> $data
     * @param class-string<M>|null $modelClass
     * @param (\\Closure(array): PaginatedResponse<M>)|null $fetchPage
     * @return PaginatedResponse<M>
     */
    public static function fromArray(array $data, ?string $modelClass = null, ?\\Closure $fetchPage = null): static
    {
        $items = $data['data'] ?? [];
        if ($modelClass !== null && method_exists($modelClass, 'fromArray')) {
            $items = array_map(fn (array \\$item) => $modelClass::fromArray(\\$item), $items);
        }
        return new static(
            data: $items,
            listMetadata: $data['list_metadata'] ?? [],
            fetchPage: $fetchPage,
        );
    }

    public function after(): ?string
    {
        return $this->listMetadata['after'] ?? null;
    }

    public function before(): ?string
    {
        return $this->listMetadata['before'] ?? null;
    }

    public function hasMore(): bool
    {
        return $this->after() !== null;
    }

    /**
     * @return \\Generator<int, T>
     */
    public function autoPagingIterator(): \\Generator
    {
        $page = $this;
        while (true) {
            yield from $page->data;
            if (empty($page->data) || !$page->hasMore() || $page->fetchPage === null) {
                break;
            }
            $page = ($page->fetchPage)(['after' => $page->after()]);
        }
    }

    /**
     * @return \\Generator<int, T>
     */
    public function getIterator(): \\Generator
    {
        return $this->autoPagingIterator();
    }
}`,
      integrateTarget: true,
      overwriteExisting: true,
    },
  ];
}

function generateComposerJson(ctx: EmitterContext): GeneratedFile[] {
  const composerJson = {
    name: `workos/${ctx.namespace}-php`,
    description: `${ctx.namespacePascal} PHP SDK`,
    type: 'library',
    license: 'MIT',
    require: {
      php: '>=8.2',
      'guzzlehttp/guzzle': '^7.0',
    },
    'require-dev': {
      'phpunit/phpunit': '^11.0',
    },
    autoload: {
      'psr-4': {
        [`${ctx.namespacePascal}\\`]: 'src/',
      },
    },
    'autoload-dev': {
      'psr-4': {
        [`Tests\\${ctx.namespacePascal}\\`]: 'tests/',
      },
    },
    config: {
      'sort-packages': true,
    },
  };

  return [
    {
      path: 'composer.json',
      content: JSON.stringify(composerJson, null, 4),
      integrateTarget: true,
      overwriteExisting: false,
      headerPlacement: 'skip' as const,
    },
  ];
}

function generatePhpunitXml(_ctx: EmitterContext): GeneratedFile[] {
  return [
    {
      path: 'phpunit.xml',
      content: `<?xml version="1.0" encoding="UTF-8"?>
<phpunit xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xsi:noNamespaceSchemaLocation="vendor/phpunit/phpunit/phpunit.xsd"
    bootstrap="vendor/autoload.php"
    colors="true"
    cacheDirectory=".phpunit.cache">
    <testsuites>
        <testsuite name="default">
            <directory>tests</directory>
        </testsuite>
    </testsuites>
    <source>
        <include>
            <directory>src</directory>
        </include>
    </source>
</phpunit>`,
      integrateTarget: true,
      overwriteExisting: false,
      headerPlacement: 'skip' as const,
    },
  ];
}
