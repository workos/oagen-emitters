import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ApiSpec, EmitterContext, GeneratedFile, Service, Model, Enum } from '@workos/oagen';
import { assignModelsToServices } from '@workos/oagen';
import {
  servicePropertyName,
  resolveClassName,
  className,
  fileName,
  buildMountDirMap,
  buildExportedClassNameSet,
  resolveServiceTarget,
} from './naming.js';
import { classifyUnassignedModel } from './models.js';
import { getMountTarget, isScopedRun } from '../shared/resolved-ops.js';
import { isListWrapperModel, isListMetadataModel } from '../shared/model-utils.js';
import { NON_SPEC_SERVICES } from '../shared/non-spec-services.js';

/**
 * Ruby `Client#accessor` wiring for each non-spec service id.
 *
 * Entries omitted from this map (e.g. `webhook_verification`) extend an
 * already-generated service class via `@oagen-ignore` blocks and need no
 * dedicated accessor.
 *
 * `ctorArg = 'self'` means the helper takes the client (`Foo.new(self)`).
 * `ctorArg = ''` means the accessor returns the constant directly (modules
 * with module-level functions, e.g. `WorkOS::PKCE`).
 */
const NON_SPEC_ACCESSORS: Record<string, { prop: string; className: string; ctorArg: 'self' | '' }> = {
  passwordless: { prop: 'passwordless', className: 'Passwordless', ctorArg: 'self' },
  actions: { prop: 'actions', className: 'Actions', ctorArg: 'self' },
  session_manager: { prop: 'session_manager', className: 'SessionManager', ctorArg: 'self' },
  pkce: { prop: 'pkce', className: 'PKCE', ctorArg: '' },
};

/**
 * Hand-maintained class names whose file basename does NOT camelCase to the
 * expected Ruby class name under Zeitwerk's default inflector. Each entry
 * adds an `inflect("file" => "Class")` override so the autoloader can
 * resolve `WorkOS::PKCE` (rather than the default `WorkOS::Pkce`).
 */
const NON_SPEC_INFLECTIONS: ReadonlyArray<readonly [string, string]> = [['pkce', 'PKCE']];

/**
 * Generate:
 *  - lib/workos.rb         — sets up a Zeitwerk loader for the gem
 *  - lib/workos/client.rb  — client class with service accessors
 *
 * The HTTP runtime (request execution, retries, error mapping, pagination)
 * lives in hand-maintained files flagged with `@oagen-ignore-file`:
 *  - lib/workos/base_client.rb
 *  - lib/workos/errors.rb
 *  - lib/workos/configuration.rb
 *  - lib/workos/hash_provider.rb
 *  - lib/workos/types/list_struct.rb
 */
export function generateClient(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  files.push(generateInflectionsFile(spec, ctx));
  files.push(generateMainEntryFile(spec, ctx));
  files.push(generateClientClass(spec, ctx));
  return files;
}

/** Build map: top-level service -> resolved class name (deduplicated by mount target). */
export function buildTopLevelServices(spec: ApiSpec, ctx: EmitterContext): Service[] {
  const seen = new Set<string>();
  const out: Service[] = [];
  for (const service of spec.services) {
    const target = getMountTarget(service, ctx) || resolveClassName(service, ctx);
    if (seen.has(target)) continue;
    seen.add(target);
    const canonical =
      spec.services.find((s) => (getMountTarget(s, ctx) || resolveClassName(s, ctx)) === target && s.name === target) ??
      service;
    out.push(canonical);
  }
  return out;
}

/**
 * Simulate Zeitwerk::Inflector's default inflection so we can emit the minimal
 * set of overrides. Zeitwerk camelizes `foo_bar` -> `FooBar`; we only add
 * inflector entries when the emitter's canonical className disagrees.
 */
function rubyCamelize(basename: string): string {
  return basename
    .split('_')
    .filter((p) => p.length > 0)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

/** Build the inflection map: file basename -> class name for all generated constants. */
function buildInflectionMap(spec: ApiSpec, ctx: EmitterContext): Map<string, string> {
  const inflections = new Map<string, string>();

  inflections.set('workos', 'WorkOS');

  const exportedClasses = buildExportedClassNameSet(ctx);
  for (const service of buildTopLevelServices(spec, ctx)) {
    const target = resolveServiceTarget(
      getMountTarget(service, ctx) || resolveClassName(service, ctx),
      exportedClasses,
    );
    const cls = className(target);
    const file = fileName(target);
    if (rubyCamelize(file) !== cls) inflections.set(file, cls);
  }

  const seenClasses = new Set<string>();
  for (const model of spec.models as Model[]) {
    if (isListWrapperModel(model) || isListMetadataModel(model)) continue;
    const cls = className(model.name);
    if (seenClasses.has(cls)) continue;
    seenClasses.add(cls);
    const file = fileName(model.name);
    if (rubyCamelize(file) !== cls) inflections.set(file, cls);
  }

  const seenEnums = new Set<string>();
  for (const enumDef of spec.enums as Enum[]) {
    const cls = className(enumDef.name);
    if (seenEnums.has(cls)) continue;
    seenEnums.add(cls);
    const file = fileName(enumDef.name);
    if (rubyCamelize(file) !== cls) inflections.set(file, cls);
  }

  for (const [file, cls] of NON_SPEC_INFLECTIONS) inflections.set(file, cls);

  preserveOnDiskInflections(inflections, ctx);

  return inflections;
}

/**
 * Keep Zeitwerk acronym overrides for model files that survive on disk but are
 * no longer in the spec the emitter was handed.
 *
 * A scoped (`--services`) run rebuilds `inflections.rb` from the narrowed spec,
 * so an override for a model the spec has since REMOVED gets dropped — yet a
 * scoped run never prunes another service's `.rb` files, so e.g.
 * `admin_portal/sso_intent_options.rb` remains. Without its
 * `"sso_intent_options" => "SSOIntentOptions"` override Zeitwerk infers
 * `SsoIntentOptions` and every reference to `WorkOS::SSOIntentOptions` raises
 * `uninitialized constant` at load time. Re-derive the override from the prior
 * on-disk file (its real class name) rather than guessing casing from the path.
 *
 * Scoped-only: a full run prunes stale files, so there is nothing on disk to
 * keep an override alive for.
 */
function preserveOnDiskInflections(inflections: Map<string, string>, ctx: EmitterContext): void {
  if (!isScopedRun(ctx)) return;
  const rootDir = ctx.targetDir ?? ctx.outputDir;
  const onDisk = ctx.priorTargetManifestPaths;
  if (!rootDir || !onDisk || onDisk.size === 0) return;

  let prior: string;
  try {
    prior = fs.readFileSync(path.join(rootDir, 'lib/workos/inflections.rb'), 'utf8');
  } catch {
    return; // first run into this dir — no prior overrides to preserve
  }

  // Basenames (sans .rb) of every file still on disk after this run. Zeitwerk
  // inflects by basename, so the inflection map is basename-keyed too.
  const onDiskBasenames = new Set<string>();
  for (const p of onDisk) {
    if (p.endsWith('.rb')) onDiskBasenames.add(path.basename(p, '.rb'));
  }

  // Parse `  "key" => "Value"` rows from the prior WORKOS_INFLECTIONS hash and
  // restore any whose file survives on disk and the current spec no longer covers.
  const entryRe = /"([^"]+)"\s*=>\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(prior)) !== null) {
    const [, key, cls] = m;
    if (inflections.has(key)) continue; // current spec already emits this override
    if (onDiskBasenames.has(key)) inflections.set(key, cls);
  }
}

/** Generate lib/workos/inflections.rb — Zeitwerk inflection overrides (T40/C5). */
function generateInflectionsFile(spec: ApiSpec, ctx: EmitterContext): GeneratedFile {
  const inflections = buildInflectionMap(spec, ctx);
  const inflectEntries = [...inflections.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([fileBase, cls]) => `  "${fileBase}" => "${cls}"`)
    .join(',\n');

  const lines: string[] = [];
  lines.push('# Zeitwerk inflection overrides for the WorkOS gem.');
  lines.push('# Maps file basenames to class/module names where the default');
  lines.push('# CamelCase inference disagrees with the canonical class name.');
  lines.push('WORKOS_INFLECTIONS = {');
  lines.push(inflectEntries);
  lines.push('}.freeze');

  return {
    path: 'lib/workos/inflections.rb',
    content: lines.join('\n'),
    integrateTarget: true,
    overwriteExisting: true,
  };
}

/** Generate lib/workos.rb — Zeitwerk bootstrap for the gem. */
function generateMainEntryFile(spec: ApiSpec, ctx: EmitterContext): GeneratedFile {
  const modelSubdirs = collectModelSubdirs(spec, ctx);

  const lines: string[] = [];
  lines.push(`require 'zeitwerk'`);
  lines.push('');
  lines.push('module WorkOS');
  lines.push('  # Sentinel default for nullable optional parameters. Distinguishes an');
  lines.push('  # omitted argument ("leave unchanged") from an explicit `nil`, which');
  lines.push('  # clears the field by sending JSON `null`.');
  lines.push('  OMIT = Object.new');
  lines.push('');
  lines.push('  def OMIT.inspect');
  lines.push('    "WorkOS::OMIT"');
  lines.push('  end');
  lines.push('');
  lines.push('  OMIT.freeze');
  lines.push('end');
  lines.push('');
  lines.push('loader = Zeitwerk::Loader.for_gem');
  lines.push(`require_relative 'workos/inflections'`);
  lines.push('loader.inflector.inflect(WORKOS_INFLECTIONS)');
  for (const dir of modelSubdirs) {
    lines.push(`loader.collapse("#{__dir__}/workos/${dir}")`);
  }
  lines.push(`loader.ignore("#{__dir__}/workos/errors.rb")`);
  lines.push(`loader.ignore("#{__dir__}/workos/inflections.rb")`);
  lines.push(`loader.ignore("#{__dir__}/workos/configuration.rb")`);
  lines.push('loader.setup');
  lines.push('');
  lines.push(`require 'workos/errors'`);
  lines.push(`require 'workos/configuration'`);

  return {
    path: 'lib/workos.rb',
    content: lines.join('\n'),
    integrateTarget: true,
    overwriteExisting: true,
  };
}

/**
 * Collect the set of mount-target subfolders that models.ts will populate.
 * Used by the Zeitwerk bootstrap to emit `loader.collapse` directives, which
 * keep the generated namespace flat while the filesystem is grouped.
 */
function collectModelSubdirs(spec: ApiSpec, ctx: EmitterContext): string[] {
  const modelToService = assignModelsToServices(spec.models as Model[], spec.services, ctx.modelHints);
  const mountDirMap = buildMountDirMap(ctx);
  const subdirs = new Set<string>();
  for (const model of spec.models as Model[]) {
    if (isListWrapperModel(model) || isListMetadataModel(model)) continue;
    const service = modelToService.get(model.name);
    const dir = service
      ? (mountDirMap.get(service) ?? classifyUnassignedModel(model.name))
      : classifyUnassignedModel(model.name);
    subdirs.add(dir);
  }
  return [...subdirs].sort();
}

/** Generate lib/workos/client.rb — thin service-wiring client. */
function generateClientClass(spec: ApiSpec, ctx: EmitterContext): GeneratedFile {
  const lines: string[] = [];
  lines.push('module WorkOS');
  lines.push('  class Client < BaseClient');

  const topLevelServices = buildTopLevelServices(spec, ctx);
  const exportedClasses = buildExportedClassNameSet(ctx);
  for (const service of topLevelServices) {
    const rawTarget = getMountTarget(service, ctx) || resolveClassName(service, ctx);
    const cls = className(resolveServiceTarget(rawTarget, exportedClasses));
    const prop = servicePropertyName(rawTarget);
    lines.push('');
    lines.push(`    def ${prop}`);
    lines.push(`      @${prop} ||= WorkOS::${cls}.new(self)`);
    lines.push('    end');
  }

  // Non-spec service accessors. Emitted inside @oagen-ignore so user edits
  // (added/removed accessors, renames) survive subsequent regenerations.
  lines.push('');
  lines.push('    # @oagen-ignore-start — non-spec service accessors (hand-maintained)');
  for (const { id } of NON_SPEC_SERVICES) {
    const wiring = NON_SPEC_ACCESSORS[id];
    if (!wiring) continue;
    const init = wiring.ctorArg ? `.new(${wiring.ctorArg})` : '';
    lines.push('');
    lines.push(`    def ${wiring.prop}`);
    lines.push(`      @${wiring.prop} ||= WorkOS::${wiring.className}${init}`);
    lines.push('    end');
  }
  lines.push('    # @oagen-ignore-end');

  lines.push('  end');
  lines.push('end');

  return {
    path: 'lib/workos/client.rb',
    content: lines.join('\n'),
    integrateTarget: true,
    overwriteExisting: true,
  };
}
