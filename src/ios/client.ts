import type { EmitterContext, GeneratedFile } from '@workos/oagen';
import { groupByMount } from '../shared/resolved-ops.js';
import { generateSmokePlan } from './smoke-plan.js';
import { moduleName, clientClassName, resourceTypeName, accessorName, withResolvedOps } from './naming.js';

/**
 * Generate the spec-driven client surface: a `{Namespace}Client+Resources.swift`
 * extension with one accessor per mount group, plus the smoke-plan sidecar.
 * The client class core (configuration, transport, initializers) and the rest
 * of the HTTP runtime (Configuration, Transport, errors, pagination, coding)
 * are hand-maintained in the SDK repo with `@oagen-ignore-file`, as are the
 * repo resources (`Package.swift`, `.swift-format`, `script/ci`, `.gitignore`).
 */
export function generateClient(ctx: EmitterContext): GeneratedFile[] {
  return [
    {
      path: `Sources/${moduleName(ctx)}/${clientClassName(ctx)}+Resources.swift`,
      content: renderResourceAccessors(ctx),
      overwriteExisting: true,
    },
    generateSmokePlan(ctx),
  ];
}

function renderResourceAccessors(ctx: EmitterContext): string {
  const clientName = clientClassName(ctx);
  const groups = [...groupByMount(withResolvedOps(ctx)).values()].sort((a, b) => a.name.localeCompare(b.name));

  const lines: string[] = [];
  lines.push('import Foundation');
  lines.push('');
  lines.push(`/// The spec-driven resource accessors for \`\`${clientName}\`\`. The client class`);
  lines.push(`/// itself is hand-maintained in \`${clientName}.swift\`.`);
  lines.push(`extension ${clientName} {`);
  let first = true;
  for (const group of groups) {
    const resource = resourceTypeName(group.name, ctx);
    const accessor = accessorName(group.name);
    if (!first) lines.push('');
    first = false;
    lines.push(`    /// Operations for the ${resource} API.`);
    lines.push(`    public var ${accessor}: ${resource} { ${resource}(transport: transport) }`);
  }
  lines.push('}');
  return lines.join('\n');
}
