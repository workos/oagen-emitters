import type { ApiSpec, EmitterContext, GeneratedFile, Service, Model, Enum } from '@workos/oagen';
import { assignModelsToServices } from '@workos/oagen';
import { servicePropertyName, resolveClassName, className, fileName, buildMountDirMap } from './naming.js';
import { classifyUnassignedModel } from './models.js';
import { getMountTarget } from '../shared/resolved-ops.js';
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
  vault: { prop: 'vault', className: 'Vault', ctorArg: 'self' },
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

/** Generate lib/workos.rb — Zeitwerk bootstrap for the gem. */
function generateMainEntryFile(spec: ApiSpec, ctx: EmitterContext): GeneratedFile {
  // Collect every (file basename -> class name) pair the loader must resolve.
  // We include:
  //   - the top-level module ("workos" -> "WorkOS")
  //   - every model / enum / service emitted below lib/workos/
  //   - hand-maintained runtime constants whose filenames also need casing help
  const inflections = new Map<string, string>();

  // Top-level module
  inflections.set('workos', 'WorkOS');

  // Services
  for (const service of buildTopLevelServices(spec, ctx)) {
    const target = getMountTarget(service, ctx) || resolveClassName(service, ctx);
    const cls = className(target);
    const file = fileName(target);
    if (rubyCamelize(file) !== cls) inflections.set(file, cls);
  }

  // Models
  const seenClasses = new Set<string>();
  for (const model of spec.models as Model[]) {
    if (isListWrapperModel(model) || isListMetadataModel(model)) continue;
    const cls = className(model.name);
    if (seenClasses.has(cls)) continue;
    seenClasses.add(cls);
    const file = fileName(model.name);
    if (rubyCamelize(file) !== cls) inflections.set(file, cls);
  }

  // Enums (live under Types; still use flat basename since Zeitwerk inflects
  // by basename regardless of directory).
  const seenEnums = new Set<string>();
  for (const enumDef of spec.enums as Enum[]) {
    const cls = className(enumDef.name);
    if (seenEnums.has(cls)) continue;
    seenEnums.add(cls);
    const file = fileName(enumDef.name);
    if (rubyCamelize(file) !== cls) inflections.set(file, cls);
  }

  // Hand-maintained class names that need a Zeitwerk inflection override.
  for (const [file, cls] of NON_SPEC_INFLECTIONS) inflections.set(file, cls);

  const inflectEntries = [...inflections.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([fileBase, cls]) => `  "${fileBase}" => "${cls}"`)
    .join(',\n');

  // Collect model subfolders so Zeitwerk can `collapse` them. Models are grouped
  // under lib/workos/{mount_target}/ for readability, but the namespace stays
  // flat (WorkOS::Organization, not WorkOS::Organizations::Organization).
  const modelSubdirs = collectModelSubdirs(spec, ctx);

  // lib/workos/errors.rb defines several classes in one file (Error, APIError,
  // AuthenticationError, ...). Zeitwerk's strict one-constant-per-file rule
  // would reject that, so we tell the loader to ignore the path and eager-
  // require it ourselves right after setup.
  const lines: string[] = [];
  lines.push(`require 'zeitwerk'`);
  lines.push('');
  lines.push('module WorkOS');
  lines.push('end');
  lines.push('');
  lines.push('loader = Zeitwerk::Loader.for_gem');
  lines.push('loader.inflector.inflect(');
  lines.push(inflectEntries);
  lines.push(')');
  for (const dir of modelSubdirs) {
    lines.push(`loader.collapse("#{__dir__}/workos/${dir}")`);
  }
  lines.push(`loader.ignore("#{__dir__}/workos/errors.rb")`);
  lines.push('loader.setup');
  lines.push('');
  lines.push(`require 'workos/errors'`);

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
  const modelToService = assignModelsToServices(spec.models as Model[], spec.services);
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
  for (const service of topLevelServices) {
    const target = getMountTarget(service, ctx) || resolveClassName(service, ctx);
    const cls = className(target);
    const prop = servicePropertyName(target);
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
