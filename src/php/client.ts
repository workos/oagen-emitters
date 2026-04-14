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
  const nonSpecAccessors = NON_SPEC_SERVICES.map((s) => phpNonSpecAccessor(s.id));
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
  // Non-spec service properties — wrapped in ignore markers so the target
  // SDK can hand-maintain the list. The emitter provides a positional anchor.
  lines.push('    // @oagen-ignore-start — non-spec service properties (hand-maintained)');
  for (const a of nonSpecAccessors) {
    lines.push(`    private ?${a.className} $${a.propName} = null;`);
  }
  lines.push('    // @oagen-ignore-end');

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

  // Non-spec service accessors — wrapped in ignore markers so the target
  // SDK can hand-maintain these. The emitter provides a positional anchor.
  lines.push('');
  lines.push('    // @oagen-ignore-start — non-spec service accessors (hand-maintained)');
  for (const a of nonSpecAccessors) {
    lines.push('');
    lines.push(`    public function ${a.propName}(): ${a.className}`);
    lines.push('    {');
    lines.push(`        return $this->${a.propName} ??= new ${a.className}($this->httpClient);`);
    lines.push('    }');
  }
  lines.push('    // @oagen-ignore-end');

  lines.push('}');
  return lines.join('\n');
}
