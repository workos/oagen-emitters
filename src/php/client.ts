import type { ApiSpec, Service, EmitterContext, GeneratedFile } from '@workos/oagen';
import { toPascalCase, toCamelCase } from '@workos/oagen';
import { className, servicePropertyName } from './naming.js';
import { getMountTarget } from '../shared/resolved-ops.js';
import { NON_SPEC_SERVICES } from '../shared/non-spec-services.js';

/**
 * PHP-specific class-name overrides for non-spec services.
 * If a service id isn't listed here, PascalCase(id) is used.
 */
const PHP_NON_SPEC_CLASS_NAMES: Record<string, string> = {
  webhook_verification: 'WebhookVerification',
  session_manager: 'SessionManager',
  pkce: 'PKCEHelper',
};

/** Derive PHP class name + property name from a non-spec service id. */
function phpNonSpecAccessor(id: string): { className: string; propName: string } {
  return {
    className: PHP_NON_SPEC_CLASS_NAMES[id] ?? toPascalCase(id),
    propName:
      id === 'webhook_verification'
        ? 'webhookVerification'
        : id === 'session_manager'
          ? 'sessionManager'
          : toCamelCase(id),
  };
}

/**
 * Generate the main PHP client, HTTP client, and support classes.
 */
export function generateClient(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const ns = ctx.namespacePascal;
  const dedupedServices = deduplicateByMount(spec.services, ctx);

  files.push({
    path: `lib/${ns}.php`,
    content: generateMainClient(spec, dedupedServices, ctx),
    overwriteExisting: true,
  });

  files.push({
    path: 'lib/HttpClient.php',
    content: generateHttpClient(ctx),
    overwriteExisting: true,
  });

  files.push({
    path: 'lib/PaginatedResponse.php',
    content: generatePaginatedResponse(ctx),
    overwriteExisting: true,
  });

  files.push({
    path: 'lib/RequestOptions.php',
    content: generateRequestOptions(ctx),
    overwriteExisting: true,
  });

  return files;
}

/**
 * Build a map from IR service name to the client accessor property name.
 */
export function buildServiceAccessPaths(services: Service[], ctx: EmitterContext): Map<string, string> {
  const map = new Map<string, string>();
  for (const service of services) {
    const target = getMountTarget(service, ctx);
    map.set(service.name, servicePropertyName(target));
    map.set(target, servicePropertyName(target));
  }
  return map;
}

function deduplicateByMount(services: Service[], ctx: EmitterContext): { name: string; propName: string }[] {
  const seen = new Map<string, { name: string; propName: string }>();
  for (const service of services) {
    const target = getMountTarget(service, ctx);
    if (!seen.has(target)) {
      seen.set(target, {
        name: className(target),
        propName: servicePropertyName(target),
      });
    }
  }
  return [...seen.values()];
}

function generateMainClient(
  spec: ApiSpec,
  services: { name: string; propName: string }[],
  ctx: EmitterContext,
): string {
  const ns = ctx.namespacePascal;
  const lines: string[] = [];

  // No <?php here — the file header from fileHeader() provides it
  lines.push(`namespace ${ns};`);
  lines.push('');

  // Use imports (sorted case-insensitively for PSR-12)
  const nonSpecAccessors = NON_SPEC_SERVICES.map((s) => phpNonSpecAccessor(s.id));
  const allImports: string[] = [];
  for (const svc of services) {
    allImports.push(`use ${ns}\\Service\\${svc.name};`);
  }
  for (const a of nonSpecAccessors) {
    allImports.push(`use ${ns}\\${a.className};`);
  }
  allImports.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  for (const imp of allImports) {
    lines.push(imp);
  }
  lines.push('');

  lines.push(`class ${ns}`);
  lines.push('{');
  lines.push('    private static ?string $apiKey = null;');
  lines.push('    private static ?string $clientId = null;');
  lines.push('    private ?HttpClient $httpClient = null;');
  lines.push('');
  lines.push('    public static function getApiKey(): ?string');
  lines.push('    {');
  lines.push('        return self::$apiKey;');
  lines.push('    }');
  lines.push('');
  lines.push('    public static function setApiKey(?string $key): void');
  lines.push('    {');
  lines.push('        self::$apiKey = $key;');
  lines.push('    }');
  lines.push('');
  lines.push('    public static function getClientId(): ?string');
  lines.push('    {');
  lines.push('        return self::$clientId;');
  lines.push('    }');
  lines.push('');
  lines.push('    public static function setClientId(?string $id): void');
  lines.push('    {');
  lines.push('        self::$clientId = $id;');
  lines.push('    }');

  // Nullable resource properties
  for (const svc of services) {
    lines.push(`    private ?Service\\${svc.name} $${svc.propName} = null;`);
  }
  // Non-spec service properties (hand-maintained modules)
  for (const a of nonSpecAccessors) {
    lines.push(`    private ?${a.className} $${a.propName} = null;`);
  }

  lines.push('');
  lines.push('    public function __construct(');
  lines.push('        ?string $apiKey = null,');
  lines.push('        ?string $clientId = null,');
  lines.push(`        string $baseUrl = '${spec.baseUrl}',`);
  lines.push('        int $timeout = 60,');
  lines.push('        int $maxRetries = 3,');
  lines.push('        ?\\GuzzleHttp\\HandlerStack $handler = null,');
  lines.push('    ) {');
  lines.push("        $apiKey ??= getenv('WORKOS_API_KEY') ?: self::$apiKey ?? '';");
  lines.push("        $clientId ??= getenv('WORKOS_CLIENT_ID') ?: self::$clientId;");
  lines.push('        self::$apiKey = $apiKey;');
  lines.push('        self::$clientId = $clientId;');
  lines.push('        $this->httpClient = new HttpClient($apiKey, $baseUrl, $timeout, $maxRetries, $handler);');
  lines.push('    }');

  // Resource accessors
  for (const svc of services) {
    lines.push('');
    lines.push(`    public function ${svc.propName}(): ${svc.name}`);
    lines.push('    {');
    lines.push(`        return $this->${svc.propName} ??= new Service\\${svc.name}($this->httpClient);`);
    lines.push('    }');
  }

  // Non-spec service accessors (hand-maintained modules)
  for (const a of nonSpecAccessors) {
    lines.push('');
    lines.push(`    public function ${a.propName}(): ${a.className}`);
    lines.push('    {');
    lines.push(`        return $this->${a.propName} ??= new ${a.className}($this->httpClient);`);
    lines.push('    }');
  }

  lines.push('}');
  return lines.join('\n');
}

function generateHttpClient(ctx: EmitterContext): string {
  const ns = ctx.namespacePascal;
  const lines: string[] = [];

  // No <?php here — the file header from fileHeader() provides it
  lines.push(`namespace ${ns};`);
  lines.push('');
  lines.push('use GuzzleHttp\\Client;');
  lines.push('use GuzzleHttp\\Exception\\ConnectException;');
  lines.push('use GuzzleHttp\\Exception\\RequestException;');
  lines.push('');
  lines.push('class HttpClient');
  lines.push('{');
  lines.push('    private Client $client;');
  lines.push('');
  lines.push('    public function __construct(');
  lines.push('        private readonly string $apiKey,');
  lines.push('        string $baseUrl,');
  lines.push('        int $timeout,');
  lines.push('        private readonly int $maxRetries,');
  lines.push('        ?\\GuzzleHttp\\HandlerStack $handler = null,');
  lines.push('    ) {');
  lines.push('        $this->client = new Client([');
  lines.push("            'base_uri' => $baseUrl,");
  lines.push("            'timeout' => $timeout,");
  lines.push("            'handler' => $handler,");
  lines.push('        ]);');
  lines.push('    }');
  lines.push('');
  lines.push('    public function request(');
  lines.push('        string $method,');
  lines.push('        string $path,');
  lines.push('        ?array $query = null,');
  lines.push('        ?array $body = null,');
  lines.push('        ?RequestOptions $options = null,');
  lines.push('    ): ?array {');
  lines.push('        return $this->requestWithRetry($method, $path, $query, $body, $options, 0);');
  lines.push('    }');
  lines.push('');
  lines.push('    private function requestWithRetry(');
  lines.push('        string $method,');
  lines.push('        string $path,');
  lines.push('        ?array $query,');
  lines.push('        ?array $body,');
  lines.push('        ?RequestOptions $options,');
  lines.push('        int $attempt,');
  lines.push('    ): ?array {');
  lines.push('        $headers = [');
  lines.push('            \'Authorization\' => "Bearer {$this->apiKey}",');
  lines.push("            'Content-Type' => 'application/json',");
  lines.push('        ];');
  lines.push('');
  lines.push('        if ($options?->extraHeaders) {');
  lines.push('            $headers = array_merge($headers, $options->extraHeaders);');
  lines.push('        }');
  lines.push('');
  lines.push('        if ($options?->idempotencyKey) {');
  lines.push("            $headers['Idempotency-Key'] = $options->idempotencyKey;");
  lines.push('        }');
  lines.push('');
  lines.push("        $requestOptions = ['headers' => $headers];");
  lines.push('        if ($query !== null) {');
  lines.push("            $requestOptions['query'] = $query;");
  lines.push('        }');
  lines.push('        if ($body !== null) {');
  lines.push("            $requestOptions['json'] = $body;");
  lines.push('        }');
  lines.push('');
  lines.push('        try {');
  lines.push('            $response = $this->client->request($method, $path, $requestOptions);');
  lines.push('            $statusCode = $response->getStatusCode();');
  lines.push('            if ($statusCode === 204) {');
  lines.push('                return null;');
  lines.push('            }');
  lines.push('            return json_decode($response->getBody()->getContents(), true);');
  lines.push('        } catch (ConnectException $e) {');
  lines.push('            if ($attempt < $this->maxRetries) {');
  lines.push('                $this->sleep($attempt);');
  lines.push('                return $this->requestWithRetry($method, $path, $query, $body, $options, $attempt + 1);');
  lines.push('            }');
  lines.push('            throw $e;');
  lines.push('        } catch (RequestException $e) {');
  lines.push('            $statusCode = $e->getResponse()?->getStatusCode();');
  lines.push(
    '            if ($statusCode !== null && in_array($statusCode, [429, 500, 502, 503, 504]) && $attempt < $this->maxRetries) {',
  );
  lines.push('                $this->sleep($attempt);');
  lines.push('                return $this->requestWithRetry($method, $path, $query, $body, $options, $attempt + 1);');
  lines.push('            }');
  lines.push('            throw $e;');
  lines.push('        }');
  lines.push('    }');
  lines.push('');
  lines.push('    private function sleep(int $attempt): void');
  lines.push('    {');
  lines.push('        $delay = min(pow(2, $attempt) * 1000, 30000);');
  lines.push('        $jitter = random_int(0, (int) ($delay * 0.1));');
  lines.push('        usleep(($delay + $jitter) * 1000);');
  lines.push('    }');
  lines.push('}');
  return lines.join('\n');
}

function generatePaginatedResponse(ctx: EmitterContext): string {
  const ns = ctx.namespacePascal;
  const lines: string[] = [];

  // No <?php here — the file header from fileHeader() provides it
  lines.push(`namespace ${ns};`);
  lines.push('');
  lines.push('class PaginatedResponse implements \\IteratorAggregate');
  lines.push('{');
  lines.push('    public function __construct(');
  lines.push('        public readonly array $data,');
  lines.push('        public readonly array $listMetadata,');
  lines.push('        private readonly ?\\Closure $fetchPage = null,');
  lines.push('    ) {');
  lines.push('    }');
  lines.push('');
  lines.push('    public static function fromArray(array $response, ?string $modelClass = null): self');
  lines.push('    {');
  lines.push("        $data = $response['data'] ?? [];");
  lines.push('        if ($modelClass !== null) {');
  lines.push('            $data = array_map(fn ($item) => $modelClass::fromArray($item), $data);');
  lines.push('        }');
  lines.push("        return new self($data, $response['list_metadata'] ?? []);");
  lines.push('    }');
  lines.push('');
  lines.push('    public function hasMore(): bool');
  lines.push('    {');
  lines.push("        return ($this->listMetadata['after'] ?? null) !== null;");
  lines.push('    }');
  lines.push('');
  lines.push('    public function autoPagingIterator(): \\Generator');
  lines.push('    {');
  lines.push('        return $this->getIterator();');
  lines.push('    }');
  lines.push('');
  lines.push('    public function getIterator(): \\Generator');
  lines.push('    {');
  lines.push('        $page = $this;');
  lines.push('        while (true) {');
  lines.push('            yield from $page->data;');
  lines.push('            if (!$page->hasMore() || $page->fetchPage === null) {');
  lines.push('                break;');
  lines.push('            }');
  lines.push("            $page = ($page->fetchPage)(['after' => $page->listMetadata['after']]);");
  lines.push('        }');
  lines.push('    }');
  lines.push('}');
  return lines.join('\n');
}

function generateRequestOptions(ctx: EmitterContext): string {
  const ns = ctx.namespacePascal;
  const lines: string[] = [];

  // No <?php here — the file header from fileHeader() provides it
  lines.push(`namespace ${ns};`);
  lines.push('');
  lines.push('class RequestOptions');
  lines.push('{');
  lines.push('    public function __construct(');
  lines.push('        public readonly ?array $extraHeaders = null,');
  lines.push('        public readonly ?string $idempotencyKey = null,');
  lines.push('        public readonly ?int $timeout = null,');
  lines.push('    ) {');
  lines.push('    }');
  lines.push('}');
  return lines.join('\n');
}
