import type { ApiSpec, EmitterContext, GeneratedFile, Service } from '@workos/oagen';
import { toPascalCase, toSnakeCase } from '@workos/oagen';
// naming utilities used indirectly via resolveResourceClassName
import { resolveResourceClassName } from './resources.js';
import { className, unexportedName } from './naming.js';
import { getMountTarget } from '../shared/resolved-ops.js';
import { NON_SPEC_SERVICES } from '../shared/non-spec-services.js';

/**
 * Generate the Go client file with service accessors.
 * Produces: workos.go (Client struct + constructor + service accessors).
 * Static files (client.go, pagination.go, errors.go, go.mod, options.go)
 * are hand-maintained in the target SDK with @oagen-ignore-file.
 */
export function generateClient(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  return [generateWorkOSFile(spec, ctx)];
}

/**
 * Non-spec services marked with `hasClientAccessor: true` (e.g. passwordless)
 * are included in the generated Client struct, constructor, and accessor methods
 * — identical to spec-driven services. Their service type (e.g. PasswordlessService)
 * is defined in a hand-written @oagen-ignore-file, but the Client wiring is generated.
 *
 * Other non-spec modules (webhook_verification, actions, etc.) remain fully
 * self-contained in their @oagen-ignore-file files.
 */

/**
 * Deduplicate services by mount target.
 */
function deduplicateByMount(services: Service[], ctx: EmitterContext): Service[] {
  const byTarget = new Map<string, Service>();
  for (const s of services) {
    const target = getMountTarget(s, ctx);
    const existing = byTarget.get(target);
    if (!existing || toPascalCase(s.name) === target) {
      byTarget.set(target, s);
    }
  }
  return [...byTarget.values()];
}

/**
 * Build map of service name -> accessor property name.
 */
export function buildServiceAccessPaths(services: Service[], ctx: EmitterContext): Map<string, string> {
  const topLevel = deduplicateByMount(services, ctx);
  const paths = new Map<string, string>();

  for (const service of topLevel) {
    const resolvedName = resolveResourceClassName(service, ctx);
    const prop = toSnakeCase(resolvedName);
    paths.set(service.name, prop);
  }

  // Also map mount targets
  for (const service of services) {
    const target = getMountTarget(service, ctx);
    if (!paths.has(target)) {
      const existing = paths.get(service.name);
      if (existing) paths.set(target, existing);
    }
  }

  return paths;
}

function generateWorkOSFile(spec: ApiSpec, ctx: EmitterContext): GeneratedFile {
  const topLevel = deduplicateByMount(spec.services, ctx);
  const lines: string[] = [];

  lines.push(`package ${ctx.namespace}`);
  lines.push('');
  lines.push('import "net/http"');
  lines.push('');

  // Client struct
  lines.push('// Client is the WorkOS API client.');
  lines.push('type Client struct {');
  lines.push('\tapiKey       string');
  lines.push('\tclientID     string');
  lines.push('\tbaseURL      string');
  lines.push('\thttpClient   *http.Client');
  lines.push('\tmaxRetries   int');
  lines.push('\tlogger       Logger');
  lines.push('\tappInfo      appInfo');
  lines.push('');
  // Service fields
  for (const service of topLevel) {
    const resolvedName = resolveResourceClassName(service, ctx);
    const fieldNameStr = unexportedName(resolvedName);
    const serviceTypeName = serviceType(resolvedName);
    lines.push(`\t${fieldNameStr} *${serviceTypeName}`);
  }
  // Non-spec service fields (hand-written types, generated wiring)
  for (const ns of NON_SPEC_SERVICES.filter((s) => s.hasClientAccessor)) {
    const name = className(toPascalCase(ns.id));
    lines.push(`\t${unexportedName(name)} *${serviceType(name)}`);
  }
  lines.push('}');
  lines.push('');

  // NewClient constructor
  lines.push('// NewClient creates a new WorkOS API client.');
  lines.push('func NewClient(apiKey string, opts ...ClientOption) *Client {');
  lines.push('\tc := &Client{');
  lines.push('\t\tapiKey:     apiKey,');
  lines.push('\t\tbaseURL:    defaultBaseURL,');
  lines.push('\t\thttpClient: &http.Client{Timeout: defaultTimeout},');
  lines.push('\t\tmaxRetries: defaultMaxRetries,');
  lines.push('\t}');
  lines.push('\tfor _, opt := range opts {');
  lines.push('\t\topt(c)');
  lines.push('\t}');
  // Initialize services
  for (const service of topLevel) {
    const resolvedName = resolveResourceClassName(service, ctx);
    const fieldNameStr = unexportedName(resolvedName);
    const serviceTypeName = serviceType(resolvedName);
    lines.push(`\tc.${fieldNameStr} = &${serviceTypeName}{client: c}`);
  }
  // Initialize non-spec services
  for (const ns of NON_SPEC_SERVICES.filter((s) => s.hasClientAccessor)) {
    const name = className(toPascalCase(ns.id));
    lines.push(`\tc.${unexportedName(name)} = &${serviceType(name)}{client: c}`);
  }
  lines.push('\treturn c');
  lines.push('}');
  lines.push('');

  // Service accessor methods
  for (const service of topLevel) {
    const resolvedName = resolveResourceClassName(service, ctx);
    const accessorName = resolvedName;
    const fieldNameStr = unexportedName(resolvedName);
    const serviceTypeName = serviceType(resolvedName);
    lines.push(`// ${accessorName} returns the ${resolvedName} service.`);
    lines.push(`func (c *Client) ${accessorName}() *${serviceTypeName} {`);
    lines.push(`\treturn c.${fieldNameStr}`);
    lines.push('}');
    lines.push('');
  }
  // Non-spec service accessor methods
  for (const ns of NON_SPEC_SERVICES.filter((s) => s.hasClientAccessor)) {
    const name = className(toPascalCase(ns.id));
    const typeName = serviceType(name);
    lines.push(`// ${name} returns the ${name} service.`);
    lines.push(`func (c *Client) ${name}() *${typeName} {`);
    lines.push(`\treturn c.${unexportedName(name)}`);
    lines.push('}');
    lines.push('');
  }
  return {
    path: `${ctx.namespace}.go`,
    content: lines.join('\n'),
    overwriteExisting: true,
  };
}

function singularizePascal(name: string): string {
  if (name.endsWith('ies')) {
    return `${name.slice(0, -3)}y`;
  }
  if (name.endsWith('s') && !name.endsWith('ss')) {
    return name.slice(0, -1);
  }
  return name;
}

function serviceType(name: string): string {
  return `${className(singularizePascal(name))}Service`;
}
