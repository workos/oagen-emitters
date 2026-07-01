import type { ApiSpec, EmitterContext, GeneratedFile } from '@workos/oagen';
import type { UnionRegistry } from './type-map.js';
import { moduleName } from './naming.js';
import { groupByMount, getMountTarget } from '../shared/resolved-ops.js';
import { mountStructName } from './resources.js';

/**
 * The Rust emitter only generates spec-derived endpoint logic. The HTTP
 * client (`src/client.rs`), crate root (`src/lib.rs`), error types
 * (`src/error.rs`), pagination helpers (`src/pagination.rs`), and
 * `Cargo.toml` are hand-maintained in the live SDK — analogous to a
 * `Gemfile` in Ruby.
 *
 * This pass runs last (after `generateModels` and `generateResources`) so
 * the shared {@link UnionRegistry} has collected every synthesised oneOf
 * union before being rendered into `src/models/_unions.rs`.
 *
 * It also emits `src/resources_api.rs`, an auxiliary `impl Client { ... }`
 * block that exposes one accessor method per mount target. Keeping the
 * accessors in a generated file lets `src/client.rs` remain hand-maintained
 * without drifting as services mount/unmount.
 */
export function generateClient(spec: ApiSpec, ctx: EmitterContext, registry: UnionRegistry): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  // _unions.rs — emitted unconditionally so the models barrel reference
  // keeps the same shape across runs.
  const unionsContent = registry.size() > 0 ? registry.render() : '// No oneOf-style unions registered.\n';
  files.push({ path: 'src/models/_unions.rs', content: unionsContent, overwriteExisting: true });

  // resources_api.rs — `impl Client { fn user_management() -> ... }`. Scoped to
  // the emit surface (`spec` is the core's surfaceSpec = selected ∪ on-disk), so
  // it never wires an accessor to a resource this run doesn't emit and isn't on
  // disk — the same orphan class as the resources barrel.
  files.push({ path: 'src/resources_api.rs', content: renderResourcesApi(spec, ctx), overwriteExisting: true });

  return files;
}

function renderResourcesApi(spec: ApiSpec, ctx: EmitterContext): string {
  const surfaceMounts = new Set(spec.services.map((s) => getMountTarget(s, ctx)));
  const groups = groupByMount(ctx);
  const targets: { accessor: string; struct: string }[] = [];
  for (const [mountName, group] of groups) {
    if (group.operations.length === 0) continue;
    if (!surfaceMounts.has(mountName)) continue;
    targets.push({ accessor: moduleName(mountName), struct: mountStructName(mountName) });
  }
  targets.sort((a, b) => a.accessor.localeCompare(b.accessor));

  const lines: string[] = [];
  lines.push('use crate::client::Client;');
  for (const { struct } of targets) {
    lines.push(`use crate::resources::${struct};`);
  }
  lines.push('');
  lines.push('impl Client {');
  targets.forEach(({ accessor, struct }, i) => {
    lines.push(`    /// Access the \`${accessor}\` resource.`);
    lines.push(`    pub fn ${accessor}(&self) -> ${struct}<'_> {`);
    lines.push(`        ${struct} { client: self }`);
    lines.push('    }');
    if (i < targets.length - 1) lines.push('');
  });
  lines.push('}');
  return lines.join('\n') + '\n';
}
