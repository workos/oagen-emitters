import type { ApiSpec, EmitterContext, GeneratedFile, Service } from '@workos/oagen';
import { toPascalCase, toSnakeCase } from '@workos/oagen';
import { resolveResourceClassName } from './resources.js';
import { className, serviceTypeName, humanize } from './naming.js';
import { getMountTarget } from '../shared/resolved-ops.js';

/**
 * Generate the C# client file with service accessors.
 * Produces: WorkOSClient.Generated.cs (partial class with service properties).
 */
export function generateClient(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  return [generateClientFile(spec, ctx)];
}

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

function generateClientFile(spec: ApiSpec, ctx: EmitterContext): GeneratedFile {
  const topLevel = deduplicateByMount(spec.services, ctx);
  const lines: string[] = [];

  lines.push(`namespace ${ctx.namespacePascal}`);
  lines.push('{');
  lines.push('    /// <summary>');
  lines.push('    /// Generated service accessors for WorkOSClient.');
  lines.push('    /// </summary>');
  lines.push('    public partial class WorkOSClient');
  lines.push('    {');

  // Service properties with lazy initialization
  for (const service of topLevel) {
    const resolvedName = resolveResourceClassName(service, ctx);
    const propName = className(resolvedName);
    const svcType = serviceTypeName(resolvedName);
    const backingField = propName.charAt(0).toLowerCase() + propName.slice(1);
    const human = humanize(resolvedName);
    lines.push(`        private ${svcType} ${backingField};`);
    lines.push('');
    lines.push(`        /// <summary>Gets the <see cref="${svcType}"/> for ${human} API operations.</summary>`);
    lines.push(`        public virtual ${svcType} ${propName} => this.${backingField} ??= new ${svcType}(this);`);
    lines.push('');
  }

  lines.push('    }');
  lines.push('}');

  return {
    path: 'Client/WorkOSClient.Generated.cs',
    content: lines.join('\n'),
    overwriteExisting: true,
  };
}
