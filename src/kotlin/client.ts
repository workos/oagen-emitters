import type { ApiSpec, EmitterContext, GeneratedFile, Service } from '@workos/oagen';
import { apiClassName, packageSegment, servicePropertyName } from './naming.js';
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
 * Accessors use fully-qualified type names so the merger doesn't need to
 * inject imports into the hand-written file.
 */
export function generateClient(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const targets = deduplicateByMount(spec.services, ctx);
  if (targets.length === 0) return [];

  const accessorLines: string[] = [];
  for (const mount of targets) {
    const apiCls = apiClassName(mount);
    const fqn = `com.workos.${packageSegment(mount)}.${apiCls}`;
    const prop = servicePropertyName(mount);
    accessorLines.push('');
    accessorLines.push(`  /** Lazily-constructed [${fqn}] accessor for this [WorkOS] client. */`);
    accessorLines.push(`  val ${prop}: ${fqn}`);
    accessorLines.push('    get() =');
    accessorLines.push('      service(');
    accessorLines.push(`        ${fqn}::class`);
    accessorLines.push('      ) {');
    accessorLines.push(`        ${fqn}(this)`);
    accessorLines.push('      }');
  }

  const lines: string[] = [];
  lines.push('package com.workos');
  lines.push('');
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
