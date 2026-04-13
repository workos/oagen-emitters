import type { ApiSpec, EmitterContext, GeneratedFile, Service } from '@workos/oagen';
import { apiClassName, packageSegment, servicePropertyName } from './naming.js';
import { getMountTarget } from '../shared/resolved-ops.js';

const KOTLIN_SRC_PREFIX = 'src/main/kotlin/';

/**
 * Generate `WorkOS.Generated.kt` — a set of extension properties that expose
 * each service on the hand-maintained [com.workos.WorkOS] client. Each
 * accessor is cached on the client instance via `WorkOS.service(...)`, so
 * consecutive reads return the same service object.
 */
export function generateClient(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const targets = deduplicateByMount(spec.services, ctx);
  if (targets.length === 0) return [];

  const imports = new Set<string>();
  imports.add('com.workos.WorkOS');

  const accessorLines: string[] = [];
  for (const mount of targets) {
    const apiCls = apiClassName(mount);
    const pkg = `com.workos.${packageSegment(mount)}`;
    imports.add(`${pkg}.${apiCls}`);
    const prop = servicePropertyName(mount);
    accessorLines.push('');
    accessorLines.push(`/** Lazily-constructed [${apiCls}] accessor for this [WorkOS] client. */`);
    accessorLines.push(`val WorkOS.${prop}: ${apiCls}`);
    accessorLines.push(`  get() = service(${apiCls}::class) { ${apiCls}(this) }`);
  }

  const lines: string[] = [];
  lines.push('package com.workos');
  lines.push('');
  for (const imp of [...imports].sort()) lines.push(`import ${imp}`);
  lines.push('');
  lines.push('// Generated service accessors. One extension property per mount group.');
  for (const line of accessorLines) lines.push(line);
  lines.push('');

  return [
    {
      path: `${KOTLIN_SRC_PREFIX}com/workos/WorkOS.Generated.kt`,
      content: lines.join('\n'),
      overwriteExisting: true,
    },
  ];
}

function deduplicateByMount(services: Service[], ctx: EmitterContext): string[] {
  const targets = new Set<string>();
  for (const s of services) targets.add(getMountTarget(s, ctx));
  return [...targets].sort();
}
