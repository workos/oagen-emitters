import type { ApiSpec, EmitterContext, GeneratedFile, Service } from '@workos/oagen';
import { resolveApiClassName, packageSegment, servicePropertyName, buildExportedClassNameSet } from './naming.js';
import { getMountTarget } from '../shared/resolved-ops.js';

const KOTLIN_SRC_PREFIX = 'src/main/kotlin/';

/**
 * Generate service accessor properties for the hand-maintained `WorkOS` class.
 *
 * Each accessor is a `val` property with a custom getter that delegates to
 * `WorkOS.service(...)` for lazy, cached construction. The generated file
 * contains a `WorkOS` class stub with only these properties — the oagen
 * merger deep-merges them into the existing hand-written `WorkOS.kt`.
 *
 * Each referenced service class is hoisted into a top-level `import` so the
 * accessor bodies use the short class name.
 *
 * The accessor KDoc ("Lazily-constructed [X] accessor…") is load-bearing: it is
 * how the merger tells a generated accessor from a hand-written one, so an
 * accessor whose service leaves the spec — a renamed or resplit tag — gets
 * pruned along with its import instead of dangling as a reference to a class
 * that is no longer emitted. Don't reword it here without updating
 * `KOTLIN_MANAGED_ACCESSOR_DOC` in oagen's Kotlin merge adapter.
 *
 * Never scope this on `ctx.scopedServices`: pruning assumes the emitted set is
 * every service, so a partial client would delete the accessors it left out.
 */
export function generateClient(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const targets = deduplicateByMount(spec.services, ctx);
  if (targets.length === 0) return [];

  const imports = new Set<string>();
  const accessorLines: string[] = [];
  const exportedClasses = buildExportedClassNameSet(ctx);
  for (const mount of targets) {
    const apiCls = resolveApiClassName(mount, exportedClasses);
    const fqn = `com.workos.${packageSegment(mount)}.${apiCls}`;
    imports.add(fqn);
    const prop = servicePropertyName(mount);
    accessorLines.push('');
    accessorLines.push(`  /** Lazily-constructed [${apiCls}] accessor for this [WorkOS] client. */`);
    accessorLines.push(`  val ${prop}: ${apiCls}`);
    accessorLines.push('    get() =');
    accessorLines.push('      service(');
    accessorLines.push(`        ${apiCls}::class`);
    accessorLines.push('      ) {');
    accessorLines.push(`        ${apiCls}(this)`);
    accessorLines.push('      }');
  }

  const lines: string[] = [];
  lines.push('package com.workos');
  lines.push('');
  for (const imp of [...imports].sort()) lines.push(`import ${imp}`);
  if (imports.size > 0) lines.push('');
  lines.push('open class WorkOS {');
  for (const line of accessorLines) lines.push(line);
  lines.push('}');
  lines.push('');

  return [
    {
      path: `${KOTLIN_SRC_PREFIX}com/workos/WorkOS.kt`,
      content: lines.join('\n'),
    },
  ];
}

function deduplicateByMount(services: Service[], ctx: EmitterContext): string[] {
  const targets = new Set<string>();
  for (const s of services) targets.add(getMountTarget(s, ctx));
  return [...targets].sort();
}
