import type { ApiSpec, Service, EmitterContext, GeneratedFile } from '@workos/oagen';
import { className, servicePropertyName } from './naming.js';
import { getMountTarget } from '../shared/resolved-ops.js';

/**
 * Generate the main PHP client class (service wiring only).
 *
 * Static infrastructure (HttpClient, PaginatedResponse, RequestOptions) is
 * now hand-maintained in the target SDK with @oagen-ignore-file.
 */
export function generateClient(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const ns = ctx.namespacePascal;
  const dedupedServices = deduplicateByMount(spec.services, ctx);

  return [
    {
      path: `lib/${ns}.php`,
      content: generateMainClient(spec, dedupedServices, ctx),
      overwriteExisting: true,
    },
  ];
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
  // Non-spec service accessors are now hand-maintained in the target SDK
  // via @oagen-ignore-start/@oagen-ignore-end regions.
  const allImports: string[] = [];
  for (const svc of services) {
    allImports.push(`use ${ns}\\Service\\${svc.name};`);
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
  lines.push('');
  lines.push('    public function __construct(');
  lines.push('        ?string $apiKey = null,');
  lines.push('        ?string $clientId = null,');
  lines.push(`        string $baseUrl = '${spec.baseUrl}',`);
  lines.push('        int $timeout = 60,');
  lines.push('        int $maxRetries = 3,');
  lines.push('        ?\\GuzzleHttp\\HandlerStack $handler = null,');
  lines.push('        ?string $userAgent = null,');
  lines.push('    ) {');
  lines.push("        $apiKey ??= getenv('WORKOS_API_KEY') ?: self::$apiKey ?? '';");
  lines.push("        $clientId ??= getenv('WORKOS_CLIENT_ID') ?: self::$clientId;");
  lines.push(
    '        $this->httpClient = new HttpClient($apiKey, $clientId, $baseUrl, $timeout, $maxRetries, $handler, $userAgent);',
  );
  lines.push('    }');

  // Resource accessors
  for (const svc of services) {
    lines.push('');
    lines.push(`    public function ${svc.propName}(): ${svc.name}`);
    lines.push('    {');
    lines.push(`        return $this->${svc.propName} ??= new Service\\${svc.name}($this->httpClient);`);
    lines.push('    }');
  }

  lines.push('}');
  return lines.join('\n');
}
