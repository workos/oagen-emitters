import type { EmitterContext, GeneratedFile } from '@workos/oagen';
import { groupByMount } from '../shared/resolved-ops.js';
import { renderImportBlock } from './imports.js';
import {
  clientClassName,
  resourceTypeName,
  accessorName,
  subPackage,
  mainSourcePath,
  withResolvedOps,
} from './naming.js';
import { generateSmokePlan } from './smoke-plan.js';

/**
 * Generate the spec-driven client surface: a `{Namespace}ClientResources.kt` file
 * of extension properties, one per mount group, plus the smoke-plan sidecar.
 *
 * The client class core (configuration, transport, constructors) and the rest of
 * the HTTP runtime (Configuration, Transport, exceptions, pagination, JSON) are
 * hand-maintained in the SDK repo with `@oagen-ignore-file`, as are the repo
 * resources (`build.gradle.kts`, `AndroidManifest.xml`, `proguard-rules.pro`).
 *
 * Extension properties are used rather than members because a generated file
 * cannot add members to a hand-maintained class. Same-module extensions can still
 * read the client's `internal val transport`, so the runtime keeps its narrow
 * visibility. This is the Kotlin analogue of the Swift `extension` the iOS
 * emitter emits.
 */
export function generateClient(ctx: EmitterContext): GeneratedFile[] {
  const rctx = withResolvedOps(ctx);
  return [
    {
      path: mainSourcePath(rctx, '', `${clientClassName(rctx)}Resources`),
      content: renderResourceAccessors(rctx),
      overwriteExisting: true,
    },
    generateSmokePlan(rctx),
  ];
}

function renderResourceAccessors(ctx: EmitterContext): string {
  const clientName = clientClassName(ctx);
  const pkg = subPackage(ctx, '');
  const groups = [...groupByMount(ctx).values()].sort((a, b) => a.name.localeCompare(b.name));

  const imports = new Set<string>();
  for (const group of groups) {
    imports.add(`${subPackage(ctx, 'resources')}.${resourceTypeName(group.name, ctx)}`);
  }

  const lines: string[] = [];
  lines.push(`package ${pkg}`);
  lines.push('');
  const importLines = renderImportBlock(imports, pkg);
  if (importLines.length > 0) {
    lines.push(...importLines);
    lines.push('');
  }
  lines.push(`// The spec-driven resource accessors for [${clientName}]. The client class`);
  lines.push(`// itself is hand-maintained in ${clientName}.kt.`);

  let first = true;
  for (const group of groups) {
    const resource = resourceTypeName(group.name, ctx);
    const accessor = accessorName(group.name);
    if (!first) lines.push('');
    first = false;
    lines.push('');
    lines.push(`/** Operations for the ${resource} API. */`);
    lines.push(`public val ${clientName}.${accessor}: ${resource}`);
    lines.push(`    get() = ${resource}(transport)`);
  }
  return lines.join('\n');
}
