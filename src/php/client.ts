import type { ApiSpec, EmitterContext, GeneratedFile, Service } from '@workos/oagen';
import { toPascalCase } from '@workos/oagen';
import { servicePropertyName, groupServicesByNamespace } from './naming.js';
import { resolveResourceClassName } from './resources.js';
import { getMountTarget } from '../shared/resolved-ops.js';

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
  files.push(...generateUndefined(ctx));
  // Version.php is hand-maintained in the target repo (release-please)
  // files.push(...generateVersion(ctx));

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

/**
 * Filter out services whose operations are mounted on a different service.
 * These don't get their own client accessor — they're reached via the mount target.
 */
function filterMountedServices(services: Service[], ctx: EmitterContext): Service[] {
  return services.filter((s) => {
    const mountTarget = getMountTarget(s, ctx);
    return mountTarget === toPascalCase(s.name);
  });
}

function assertPublicClientReachability(spec: ApiSpec, ctx: EmitterContext): void {
  const topLevelServices = filterMountedServices(spec.services, ctx);
  const accessPaths = buildServiceAccessPaths(topLevelServices, ctx);
  const unreachableServices = topLevelServices
    .filter((service) => service.operations.length > 0 && !accessPaths.has(service.name))
    .map((service) => service.name);

  if (unreachableServices.length > 0) {
    throw new Error(`PHP emitter reachability audit failed for services: ${unreachableServices.join(', ')}`);
  }
}

function generateMainClient(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const sdk = ctx.spec.sdk;
  const topLevelServices = filterMountedServices(spec.services, ctx);
  groupServicesByNamespace(topLevelServices, ctx); // validates service grouping
  const lines: string[] = [];

  lines.push('');
  lines.push(`namespace ${ctx.namespacePascal};`);
  lines.push('');

  // Import resource classes (only top-level, not mounted sub-services)
  for (const service of topLevelServices) {
    if (service.operations.length === 0) continue;
    const resourceName = resolveResourceClassName(service, ctx);
    lines.push(`use ${ctx.namespacePascal}\\Resources\\${resourceName};`);
  }
  lines.push('');

  lines.push('/**');
  lines.push(` * Class ${ctx.namespacePascal}.`);
  lines.push(' *');
  lines.push(' * This class allows users to get and set configuration for the package.');
  lines.push(' */');
  lines.push(`class ${ctx.namespacePascal}`);
  lines.push('{');

  // ── App info for User-Agent enrichment ──
  lines.push('    /** @var array{name: string, version?: string, url?: string}|null */');
  lines.push('    private static ?array $appInfo = null;');
  lines.push('');
  lines.push('    /** @var \\Psr\\Log\\LoggerInterface|null */');
  lines.push('    private static ?\\Psr\\Log\\LoggerInterface $logger = null;');
  lines.push('');

  // ── Legacy static configuration properties (backwards-compatible) ──
  lines.push('    /**');
  lines.push('     * @var null|string WorkOS API key');
  lines.push('     */');
  lines.push('    private static $apiKey = null;');
  lines.push('');
  lines.push('    /**');
  lines.push('     * @var null|string WorkOS Client ID');
  lines.push('     */');
  lines.push('    private static $clientId = null;');
  lines.push('');
  lines.push('    /**');
  lines.push('     * @var string WorkOS base API URL.');
  lines.push('     */');
  lines.push('    private static $apiBaseUrl = "https://api.workos.com/";');
  lines.push('');
  lines.push('    /**');
  lines.push('     * @var string SDK identifier');
  lines.push('     */');
  lines.push('    private static $identifier = Version::SDK_IDENTIFIER;');
  lines.push('');
  lines.push('    /**');
  lines.push('     * @var string SDK version');
  lines.push('     */');
  lines.push('    private static $version = Version::SDK_VERSION;');
  lines.push('');

  // ── Instance properties for new resource-accessor pattern ──
  lines.push('    private ?HttpClient $httpClient = null;');

  // Lazy resource instances (only top-level services)
  for (const service of topLevelServices) {
    if (service.operations.length === 0) continue;
    const resourceName = resolveResourceClassName(service, ctx);
    const propName = servicePropertyName(resourceName);
    lines.push(`    private ?${resourceName} $${propName}Instance = null;`);
  }
  lines.push('');

  // ── Legacy static methods (backwards-compatible) ──
  lines.push('    /**');
  lines.push('     * @return null|string WorkOS API key');
  lines.push('     */');
  lines.push('    public static function getApiKey()');
  lines.push('    {');
  lines.push('        if (isset(self::$apiKey)) {');
  lines.push('            return self::$apiKey;');
  lines.push('        }');
  lines.push('');
  lines.push('        $envValue = self::getEnvVariable("WORKOS_API_KEY");');
  lines.push('        if ($envValue) {');
  lines.push('            self::$apiKey = $envValue;');
  lines.push('            return self::$apiKey;');
  lines.push('        }');
  lines.push('');
  lines.push('        $msg = "\\$apiKey is required";');
  lines.push(`        throw new \\${ctx.namespacePascal}\\Exception\\ConfigurationException($msg);`);
  lines.push('    }');
  lines.push('');
  lines.push('    /**');
  lines.push('     * @param null|string $apiKey WorkOS API key');
  lines.push('     */');
  lines.push('    public static function setApiKey($apiKey)');
  lines.push('    {');
  lines.push('        self::$apiKey = $apiKey;');
  lines.push('    }');
  lines.push('');
  lines.push('    /**');
  lines.push('     * @throws \\WorkOS\\Exception\\ConfigurationException');
  lines.push('     *');
  lines.push('     * @return null|string WorkOS Client ID');
  lines.push('     */');
  lines.push('    public static function getClientId()');
  lines.push('    {');
  lines.push('        if (isset(self::$clientId)) {');
  lines.push('            return self::$clientId;');
  lines.push('        }');
  lines.push('');
  lines.push('        $envValue = self::getEnvVariable("WORKOS_CLIENT_ID");');
  lines.push('        if ($envValue) {');
  lines.push('            self::$clientId = $envValue;');
  lines.push('            return self::$clientId;');
  lines.push('        }');
  lines.push('');
  lines.push('        $msg = "\\$clientId is required";');
  lines.push(`        throw new \\${ctx.namespacePascal}\\Exception\\ConfigurationException($msg);`);
  lines.push('    }');
  lines.push('');
  lines.push('    /**');
  lines.push('     * @param string $clientId WorkOS Client ID');
  lines.push('     */');
  lines.push('    public static function setClientId($clientId)');
  lines.push('    {');
  lines.push('        self::$clientId = $clientId;');
  lines.push('    }');
  lines.push('');
  lines.push('    /**');
  lines.push('     * @return string WorkOS base API URL');
  lines.push('     */');
  lines.push('    public static function getApiBaseURL()');
  lines.push('    {');
  lines.push('        return self::$apiBaseUrl;');
  lines.push('    }');
  lines.push('');
  lines.push('    /**');
  lines.push('     * @param string $apiBaseUrl WorkOS base API URL');
  lines.push('     */');
  lines.push('    public static function setApiBaseUrl($apiBaseUrl)');
  lines.push('    {');
  lines.push('        self::$apiBaseUrl = $apiBaseUrl;');
  lines.push('    }');
  lines.push('');
  lines.push('    /**');
  lines.push('     * @param string $identifier SDK identifier');
  lines.push('     */');
  lines.push('    public static function setIdentifier($identifier)');
  lines.push('    {');
  lines.push('        self::$identifier = $identifier;');
  lines.push('    }');
  lines.push('');
  lines.push('    /**');
  lines.push('     * @return string SDK identifier');
  lines.push('     */');
  lines.push('    public static function getIdentifier()');
  lines.push('    {');
  lines.push('        return self::$identifier;');
  lines.push('    }');
  lines.push('');
  lines.push('    /**');
  lines.push('     * @param string $version SDK version');
  lines.push('     */');
  lines.push('    public static function setVersion($version)');
  lines.push('    {');
  lines.push('        self::$version = $version;');
  lines.push('    }');
  lines.push('');
  lines.push('    /**');
  lines.push('     * @return string SDK version');
  lines.push('     */');
  lines.push('    public static function getVersion()');
  lines.push('    {');
  lines.push('        return self::$version;');
  lines.push('    }');
  lines.push('');
  lines.push('    /**');
  lines.push('     * Set a PSR-3 logger for SDK debug output.');
  lines.push('     *');
  lines.push('     * @param \\Psr\\Log\\LoggerInterface $logger');
  lines.push('     */');
  lines.push('    public static function setLogger(\\Psr\\Log\\LoggerInterface $logger): void');
  lines.push('    {');
  lines.push('        self::$logger = $logger;');
  lines.push('    }');
  lines.push('');
  lines.push('    /**');
  lines.push('     * @return \\Psr\\Log\\LoggerInterface|null');
  lines.push('     */');
  lines.push('    public static function getLogger(): ?\\Psr\\Log\\LoggerInterface');
  lines.push('    {');
  lines.push('        return self::$logger;');
  lines.push('    }');
  lines.push('');

  lines.push('    /**');
  lines.push('     * Set app information for User-Agent enrichment.');
  lines.push('     * Plugin and integration authors can use this to identify their code in API logs.');
  lines.push('     *');
  lines.push('     * @param string $name Application name');
  lines.push('     * @param string|null $version Application version');
  lines.push('     * @param string|null $url Application URL');
  lines.push('     */');
  lines.push('    public static function setAppInfo(string $name, ?string $version = null, ?string $url = null): void');
  lines.push('    {');
  lines.push(
    "        self::$appInfo = array_filter(['name' => $name, 'version' => $version, 'url' => $url], fn ($v) => $v !== null);",
  );
  lines.push('    }');
  lines.push('');
  lines.push('    /**');
  lines.push('     * @return array{name: string, version?: string, url?: string}|null');
  lines.push('     */');
  lines.push('    public static function getAppInfo(): ?array');
  lines.push('    {');
  lines.push('        return self::$appInfo;');
  lines.push('    }');
  lines.push('');

  lines.push('    /**');
  lines.push('     * Get environment variable with fallback to cached config sources.');
  lines.push('     * Checks in order: getenv(), $_ENV, $_SERVER');
  lines.push('     *');
  lines.push('     * @param string $key Environment variable name');
  lines.push('     * @return string|false The environment variable value or false if not found');
  lines.push('     */');
  lines.push('    private static function getEnvVariable($key)');
  lines.push('    {');
  lines.push('        $value = getenv($key);');
  lines.push("        if ($value !== false && $value !== '') {");
  lines.push('            return $value;');
  lines.push('        }');
  lines.push('');
  lines.push("        if (isset($_ENV[$key]) && $_ENV[$key] !== '') {");
  lines.push('            return $_ENV[$key];');
  lines.push('        }');
  lines.push('');
  lines.push("        if (isset($_SERVER[$key]) && $_SERVER[$key] !== '') {");
  lines.push('            return $_SERVER[$key];');
  lines.push('        }');
  lines.push('');
  lines.push('        return false;');
  lines.push('    }');

  // ── New instance-based constructor ──
  lines.push('');
  lines.push('    /**');
  lines.push('     * Create a new WorkOS client instance with resource accessors.');
  lines.push('     */');
  lines.push('    public function __construct(');
  lines.push('        ?string $apiKey = null,');
  lines.push(`        string $baseUrl = '${spec.baseUrl || 'https://api.workos.com'}',`);
  lines.push(`        int $timeout = ${sdk.timeout.defaultTimeoutSeconds},`);
  lines.push(`        int $maxRetries = ${sdk.retry.maxRetries},`);
  lines.push('        ?\\GuzzleHttp\\HandlerStack $handler = null,');
  lines.push('        bool $enableTelemetry = true,');
  lines.push('        ?\\Psr\\Log\\LoggerInterface $logger = null,');
  lines.push('    ) {');
  lines.push("        $resolvedKey = $apiKey ?? (getenv('WORKOS_API_KEY') ?: null) ?? self::$apiKey;");
  lines.push("        if ($resolvedKey !== null && $resolvedKey !== '') {");
  lines.push('            $resolvedLogger = $logger ?? self::$logger;');
  lines.push(
    '            $this->httpClient = new HttpClient($resolvedKey, $baseUrl, $timeout, $maxRetries, $handler, $enableTelemetry, $resolvedLogger);',
  );
  lines.push('        }');
  lines.push('    }');

  // Resource accessors (only top-level services)
  for (const service of topLevelServices) {
    if (service.operations.length === 0) continue;
    const resourceName = resolveResourceClassName(service, ctx);
    const propName = servicePropertyName(resourceName);
    const methodName = servicePropertyName(resourceName);

    lines.push('');
    lines.push(`    public function ${methodName}(): ${resourceName}`);
    lines.push('    {');
    lines.push(`        if ($this->httpClient === null) {`);
    lines.push(
      `            throw new Exception\\ConfigurationException('API key is required. Set WORKOS_API_KEY, call WorkOS::setApiKey(), or pass apiKey to the constructor.');`,
    );
    lines.push('        }');
    lines.push(`        return $this->${propName}Instance ??= new ${resourceName}($this->httpClient);`);
    lines.push('    }');
  }

  lines.push('}');

  return [
    {
      path: `lib/${ctx.namespacePascal}.php`,
      content: lines.join('\n'),
      integrateTarget: true,
      overwriteExisting: true,
    },
  ];
}

function generateHttpClient(ctx: EmitterContext): GeneratedFile[] {
  const ns = ctx.namespacePascal;
  const sdk = ctx.spec.sdk;

  // Generate use statements from status code map
  const statusCodeUseStatements = Object.values(sdk.errors.statusCodeMap)
    .map((kind) => `use ${ns}\\Exception\\${kind}Exception;`)
    .join('\n');

  // Generate STATUS_CODE_EXCEPTIONS map from sdk policy
  const statusCodeEntries = Object.entries(sdk.errors.statusCodeMap)
    .map(([code, kind]) => `        ${code} => ${kind}Exception::class,`)
    .join('\n');

  // Generate AI_AGENT_ENV_VARS from sdk policy
  const aiAgentEntries = sdk.userAgent.aiAgentEnvVars
    .map((entry) => `        '${entry.envVar}' => '${entry.agentName}',`)
    .join('\n');

  // Generate REQUEST_OPTIONS_KEYS from sdk policy
  const requestOptionsKeys = sdk.requestGuard.optionKeys.map((k) => `'${k}'`).join(', ');

  // Pre-compute backoff formula for PHP: min(initialDelay * pow(multiplier, $attempt), maxDelay)
  // When initialDelay is 1, omit the "1 * " prefix to match: pow(multiplier, $attempt)
  const { initialDelay, multiplier, maxDelay, jitterFactor } = sdk.retry.backoff;
  const backoffBase =
    initialDelay === 1 ? `pow(${multiplier}, $attempt)` : `${initialDelay} * pow(${multiplier}, $attempt)`;
  const backoffExpr = `min(${backoffBase}, ${maxDelay})`;

  const content = `
namespace ${ns};

use GuzzleHttp\\Client;
use GuzzleHttp\\Exception\\ConnectException;
use GuzzleHttp\\Exception\\RequestException;
use GuzzleHttp\\HandlerStack;
use Psr\\Http\\Message\\ResponseInterface;
use ${ns}\\Exception\\ApiException;
${statusCodeUseStatements}
use ${ns}\\Exception\\ConnectionException;
use ${ns}\\Exception\\ServerException;
use ${ns}\\Exception\\TimeoutException;
use Psr\\Log\\LoggerInterface;
use Psr\\Log\\NullLogger;

class HttpClient
{
    private Client $client;
    private int $maxRetries;
    private string $userAgent;
    private bool $enableTelemetry;
    private LoggerInterface $logger;

    /** @var array{requestId: string, durationMs: int}|null */
    private ?array $lastRequestMetrics = null;

    private const STATUS_CODE_EXCEPTIONS = [
${statusCodeEntries}
    ];

    private const RETRYABLE_STATUS_CODES = [${sdk.retry.retryableStatusCodes.join(', ')}];

    /** AI agent environment variables to detect. */
    private const AI_AGENT_ENV_VARS = [
${aiAgentEntries}
    ];

    public function __construct(
        private readonly string $apiKey,
        string $baseUrl,
        int $timeout,
        int $maxRetries,
        ?HandlerStack $handler = null,
        bool $enableTelemetry = true,
        ?LoggerInterface $logger = null,
    ) {
        $this->maxRetries = $maxRetries;
        $this->enableTelemetry = $enableTelemetry;
        $this->logger = $logger ?? new NullLogger();
        $this->userAgent = self::buildUserAgent();
        $this->client = new Client([
            'base_uri' => rtrim($baseUrl, '/') . '/',
            'timeout' => $timeout,
            'headers' => [
                'Authorization' => 'Bearer ' . $this->apiKey,
                'Content-Type' => 'application/json',
                'User-Agent' => $this->userAgent,
            ],
            'handler' => $handler,
            'http_errors' => false,
        ]);
    }

    private static function buildUserAgent(): string
    {
        $ua = Version::SDK_IDENTIFIER . '/' . Version::SDK_VERSION;

        // Append app info if set
        $appInfo = ${ns}::getAppInfo();
        if ($appInfo !== null) {
            $ua .= ' ' . $appInfo['name'];
            if (isset($appInfo['version'])) {
                $ua .= '/' . $appInfo['version'];
            }
            if (isset($appInfo['url'])) {
                $ua .= ' (' . $appInfo['url'] . ')';
            }
        }

        // Detect AI agents
        foreach (self::AI_AGENT_ENV_VARS as $envVar => $agentName) {
            if (getenv($envVar) !== false && getenv($envVar) !== '') {
                $ua .= ' AIAgent/' . $agentName;
                break;
            }
        }

        return $ua;
    }

    /** Keys that belong in RequestOptions, not in params. */
    private const REQUEST_OPTIONS_KEYS = [${requestOptionsKeys}];

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
        // Guard: detect RequestOptions keys accidentally passed as params
        foreach ([$query ?? [], $body ?? []] as $params) {
            foreach (self::REQUEST_OPTIONS_KEYS as $optKey) {
                if (array_key_exists($optKey, $params)) {
                    throw new \\InvalidArgumentException(
                        "Found '{$optKey}' in request params. This key belongs in RequestOptions, not in the params array. "
                        . "Use: new RequestOptions({$optKey}: ...) instead."
                    );
                }
            }
        }

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
                $extraHeaders['${sdk.idempotency.headerName}'] = $options->idempotencyKey;
            }
            if ($options->apiKey !== null) {
                $extraHeaders['Authorization'] = 'Bearer ' . $options->apiKey;
            }
        }

        // Telemetry header: send previous request's ID + latency
        if ($this->enableTelemetry && $this->lastRequestMetrics !== null) {
            $extraHeaders['${sdk.telemetry.headerName}'] = json_encode([
                'last_request_id' => $this->lastRequestMetrics['requestId'],
                'last_request_duration_ms' => $this->lastRequestMetrics['durationMs'],
            ]);
        }

        if (count($extraHeaders) > 0) {
            $guzzleOptions['headers'] = $extraHeaders;
        }

        $maxRetries = $options?->maxRetries ?? $this->maxRetries;

        // Auto-generate idempotency key for retryable POST requests without one
        $hasIdempotencyKey = isset($guzzleOptions['headers']['${sdk.idempotency.headerName}']);
        if (${sdk.idempotency.autoGenerateForPost ? "strtoupper($method) === 'POST' && " : ''}$maxRetries > 0 && !$hasIdempotencyKey) {
            $guzzleOptions['headers']['${sdk.idempotency.headerName}'] = self::generateUuidV4();
        }

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
                $this->logger->debug('WorkOS API request', ['method' => $method, 'path' => $path]);
                $startTime = hrtime(true);
                $response = $this->client->request($method, $path, $options);
                $durationMs = (int) ((hrtime(true) - $startTime) / 1_000_000);
                $statusCode = $response->getStatusCode();

                // Record telemetry
                $requestId = $response->getHeaderLine('${sdk.telemetry.requestIdHeader}');
                if ($requestId !== '') {
                    $this->lastRequestMetrics = [
                        'requestId' => $requestId,
                        'durationMs' => $durationMs,
                    ];
                }

                $this->logger->debug('WorkOS API response', [
                    'method' => $method,
                    'path' => $path,
                    'status' => $statusCode,
                    'request_id' => $requestId ?: null,
                    'duration_ms' => $durationMs,
                ]);

                if ($statusCode >= 200 && $statusCode < 300) {
                    $responseBody = (string) $response->getBody();
                    if (empty($responseBody)) {
                        return [];
                    }
                    return json_decode($responseBody, true) ?? [];
                }

                if (in_array($statusCode, self::RETRYABLE_STATUS_CODES) && $attempt < $maxRetries) {
                    $retryAfter = $this->getRetryDelay($response, $attempt);
                    if ($statusCode === 429) {
                        $this->logger->warning('WorkOS API rate limited', [
                            'path' => $path,
                            'retry_after' => $retryAfter,
                            'request_id' => $requestId ?: null,
                        ]);
                    }
                    $this->logger->info('WorkOS API retrying request', [
                        'attempt' => $attempt + 1,
                        'max_retries' => $maxRetries,
                        'backoff_seconds' => $retryAfter,
                    ]);
                    usleep((int) ($retryAfter * 1_000_000));
                    $attempt++;
                    continue;
                }

                $this->logger->error('WorkOS API non-retryable error', [
                    'status' => $statusCode,
                    'path' => $path,
                    'request_id' => $requestId ?: null,
                ]);

                $this->throwForStatus($response);
            } catch (ConnectException $e) {
                if ($attempt < $maxRetries) {
                    $backoff = $this->calculateBackoff($attempt);
                    $this->logger->info('WorkOS API retrying after connection error', [
                        'attempt' => $attempt + 1,
                        'max_retries' => $maxRetries,
                        'backoff_seconds' => $backoff,
                    ]);
                    usleep((int) ($backoff * 1_000_000));
                    $attempt++;
                    continue;
                }
                $this->logger->error('WorkOS API connection failed', ['message' => $e->getMessage()]);
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
        $requestId = $response->getHeaderLine('${sdk.telemetry.requestIdHeader}') ?: null;

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
        $base = ${backoffExpr};
        $jitter = $base * (mt_rand() / mt_getrandmax()) * ${jitterFactor};
        return $base + $jitter;
    }

    private static function generateUuidV4(): string
    {
        $data = random_bytes(16);
        $data[6] = chr((ord($data[6]) & 0x0f) | 0x40);
        $data[8] = chr((ord($data[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}`;

  return [
    {
      path: 'lib/HttpClient.php',
      content,
      integrateTarget: true,
      overwriteExisting: true,
    },
  ];
}

function generateRequestOptions(ctx: EmitterContext): GeneratedFile[] {
  return [
    {
      path: 'lib/RequestOptions.php',
      content: `
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
        public readonly ?string $apiKey = null,
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
      path: 'lib/PaginatedResponse.php',
      content: `
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
            $items = array_map(fn (array $item) => $modelClass::fromArray($item), $items);
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
     * Serialize the current page to a wire-format array, including metadata.
     *
     * @return array<string, mixed>
     */
    public function toArray(): array
    {
        $data = array_map(
            fn ($item) => method_exists($item, 'toArray') ? $item->toArray() : $item,
            $this->data,
        );
        return [
            'data' => $data,
            'list_metadata' => $this->listMetadata,
        ];
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

function generateUndefined(ctx: EmitterContext): GeneratedFile[] {
  return [
    {
      path: 'lib/Undefined.php',
      content: `
namespace ${ctx.namespacePascal};

/**
 * Sentinel enum for distinguishing "not provided" from "explicitly null".
 *
 * Used as the default value for optional body parameters on update (PUT/PATCH)
 * endpoints so that omitted fields are not sent, while explicitly passing null
 * sends a JSON null.
 */
enum Undefined
{
    case Value;
}`,
      integrateTarget: true,
      overwriteExisting: true,
    },
  ];
}

// oxlint-disable-next-line no-unused-vars -- kept for future use; call site is commented out
function generateVersion(ctx: EmitterContext): GeneratedFile[] {
  return [
    {
      path: 'lib/Version.php',
      content: `
namespace ${ctx.namespacePascal};

class Version
{
    public const SDK_IDENTIFIER = "WorkOS PHP";
    public const SDK_VERSION = "0.0.0";
}`,
      headerPlacement: 'skip',
      integrateTarget: true,
      skipIfExists: true,
    },
  ];
}
