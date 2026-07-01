import type {
  Emitter,
  EmitterContext,
  FormatCommand,
  GeneratedFile,
  ApiSpec,
  Model,
  Enum,
  Service,
} from '@workos/oagen';
import { toPascalCase } from '@workos/oagen';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { generateModelsAndSerializers } from './models.js';
import { generateEnums as generateEnumFiles } from './enums.js';
import { generateResources, resolveResourceClassName, resolveResourceDir } from './resources.js';
import { generateClient } from './client.js';
import { generateTests as generateTestFiles } from './tests.js';
import { enrichModelsFromSpec, getSyntheticEnums } from '../shared/model-utils.js';
import { flattenDiscriminatedUnionFields } from '../shared/union-flatten.js';
import { planDiscriminatedModels, generateDiscriminatedFiles } from './discriminated-models.js';
import {
  buildLiveSurface,
  emptyLiveSurface,
  mergeGeneratedClassMethodsIntoExisting,
  setActiveLiveSurface,
  type LiveSurface,
} from './live-surface.js';
import {
  setBaselineSerializedNames,
  setBaselineInterfaceNames,
  setBaselineDeclaredNames,
  setAdoptedModelNames,
  setDiscriminatedModelNames,
  setStructurallyRenamedDomainNames,
  resolveInterfaceName,
} from './naming.js';
import { withNodeOperationOverrides } from './node-overrides.js';
import { isNodeOwnedService, nodeOptions } from './options.js';
import { setInlineEnumUnions, setDomainNameResolver } from './type-map.js';
import { groupByMount } from '../shared/resolved-ops.js';
import { AUTOGEN_NOTICE } from '../shared/file-header.js';
import { assignModelsToServices, createServiceDirResolver, relativeImport } from './utils.js';
import { fileName } from './naming.js';

/**
 * Cache live-surface per ctx — every emitter method receives the same ctx in
 * one oagen run, so we walk the target SDK once and reuse it.
 */
const surfaceCache = new WeakMap<EmitterContext, LiveSurface>();

/**
 * Paths the node emitter has produced so far in this ctx, accumulated across
 * `applyLiveSurface` calls. Drives `carryForwardManagedFiles` so files in the
 * prior manifest that we did not re-emit this run still land in the new
 * manifest as "still managed" — without that, the orchestrator's prune diff
 * treats every untouched autogen file as stale.
 */
const emittedPathsCache = new WeakMap<EmitterContext, Set<string>>();

function getEmittedPaths(ctx: EmitterContext): Set<string> {
  let set = emittedPathsCache.get(ctx);
  if (!set) {
    set = new Set();
    emittedPathsCache.set(ctx, set);
  }
  return set;
}

/**
 * Every `GeneratedFile` the node emitter has produced so far in this ctx,
 * keyed by path. All emitter hooks share one ctx (and the engine only reads
 * file contents after the last hook returns), so the final hook can run a
 * whole-run pass over files emitted by earlier hooks — see
 * `enforceEmittedImportInvariant`.
 */
const emittedFilesCache = new WeakMap<EmitterContext, Map<string, GeneratedFile>>();

function getEmittedFiles(ctx: EmitterContext): Map<string, GeneratedFile> {
  let map = emittedFilesCache.get(ctx);
  if (!map) {
    map = new Map();
    emittedFilesCache.set(ctx, map);
  }
  return map;
}

function getSurface(ctx: EmitterContext): LiveSurface {
  let surface = surfaceCache.get(ctx);
  if (surface) return surface;
  // Prefer --output (where we are writing) over --target (rare for node).
  // The literal command `--output <SDK>` makes outputDir the SDK root.
  const root = ctx.outputDir ?? ctx.targetDir;
  surface = root ? buildLiveSurface(root) : emptyLiveSurface();
  if (root) markPriorManifestAutogen(surface, root, ctx.priorTargetManifestPaths);
  surfaceCache.set(ctx, surface);
  setActiveLiveSurface(surface);

  // Wire the type-map's resolver so field-type references (`schema: X`) and
  // import statements (`import type { X }`) agree on the same name. The
  // structural baseline match in `resolveInterfaceName` can map an IR name
  // to a different live-SDK name (e.g. `AuditLogSchemaJson` → baseline
  // `AuditLogSchemaResponse` via `overlayLookup.modelNameByIR`).
  setDomainNameResolver((irName: string) => resolveInterfaceName(irName, ctx));

  // Tell `naming.wireInterfaceName` which `Serialized*` interfaces exist in
  // the live SDK so generated imports use the legacy name where applicable.
  // Source from the api-surface JSON (richer) when present, else fall back
  // to the disk walk.
  const serialized = new Set<string>();
  const ifaces = ctx.apiSurface?.interfaces;
  if (ifaces) {
    for (const name of Object.keys(ifaces)) {
      if (name.startsWith('Serialized')) serialized.add(name);
    }
  }
  for (const name of surface.interfaces.keys()) {
    if (name.startsWith('Serialized')) serialized.add(name);
  }
  setBaselineSerializedNames(serialized);

  // Full set of baseline interface names — used by `wireInterfaceName` to
  // detect when a `Response`-suffixed name has no `*Wire` companion in
  // the live SDK and is therefore the single-form wire interface.
  const allInterfaces = new Set<string>();
  if (ifaces) {
    for (const name of Object.keys(ifaces)) allInterfaces.add(name);
  }
  for (const name of surface.interfaces.keys()) allInterfaces.add(name);
  setBaselineInterfaceNames(allInterfaces);

  // Every DECLARED baseline name — interfaces and type aliases, from both
  // the api-surface JSON and the disk walk (whose `interfaces` map already
  // includes `export type` aliases). `resolveInterfaceName` uses this to
  // let exact-name declarations preempt structural renames: an alias-form
  // file (`export type X = Y;`) carries no fields, so the engine's
  // structural matcher would otherwise re-point IR model X at a similarly
  // shaped interface and emit renamed duplicates that flip the file's form
  // on every regeneration.
  const declaredNames = new Set<string>(allInterfaces);
  for (const name of Object.keys(ctx.apiSurface?.typeAliases ?? {})) declaredNames.add(name);
  setBaselineDeclaredNames(declaredNames);

  // Inline-enum optimization is intentionally disabled. workos-node emits the
  // dual `const X = {...} as const; type X = ...` pattern so callers can use
  // members at runtime (e.g. `GenerateLinkIntent.SSO`). Inlining the type
  // would drop the enum's file but leave value references in hand-written
  // test files dangling — see admin-portal.spec.ts referencing `.SSO`.
  // Pass an empty map; type-map will fall back to emitting the symbol name.
  setInlineEnumUnions(new Map());
  setAdoptedModelNames(computeAdoptedModelNames(ctx, surface));

  // Pre-compute which domain names the resolver reaches via structural
  // rename so `wireInterfaceName` can tell `AuditLogSchemaJson` →
  // `AuditLogSchemaResponse` (real single-form case) apart from
  // `CreateDataKeyResponse` → `CreateDataKeyResponse` (fresh IR model whose
  // own name already ends in `Response`).
  const renamed = new Set<string>();
  for (const model of ctx.spec.models) {
    const resolved = resolveInterfaceName(model.name, ctx);
    if (resolved !== model.name) renamed.add(resolved);
  }
  setStructurallyRenamedDomainNames(renamed);

  return surface;
}

/**
 * Apply the live-surface filter to a batch of generated files.
 *
 * Three signals decide what happens to each `GeneratedFile`:
 *
 *   1. `@oagen-ignore-file` marker (`surface.protectedFiles`) — the user has
 *      taken ownership of the file, never write on top of it.
 *   2. `auto-generated by oagen` header (`surface.autogenFiles`) — the file
 *      was produced by a prior generation. Spec changes (e.g. parameter
 *      renames) must propagate, so we leave the file in the output and let
 *      the engine's AST merger update it. No skip flags.
 *   3. File on disk without either marker — treat as hand-written; drop from
 *      the output to avoid the engine prepending a header on `skipIfExists`
 *      files (see writeFiles:~4360 in @workos/oagen) or merging unrequested
 *      changes into it.
 *   4. Brand-new path in an existing SDK — drop it. For a live SDK we treat
 *      the git-tracked baseline as the managed surface; generating new files
 *      is what caused the workos-node file explosion.
 *
 * `integrateTarget: false` files (smoke-manifest.json etc.) are also dropped:
 * with no `--target` step they would otherwise land as untracked cruft.
 *
 * Note: the carry-forward step in `generateTests` re-declares prior-manifest
 * paths we didn't touch this run, so the orchestrator's prune diff stays
 * accurate without needing `--no-prune` at the call site. See
 * `carryForwardManagedFiles` below.
 */
/**
 * `*.spec.ts`, `*.test.ts`, and JSON fixtures under `fixtures/` are owned by
 * the test author after first emission. The emitter scaffolds them on a
 * brand-new resource, but subsequent regenerations must leave them alone —
 * assertions get hand-tuned, fixture data gets stabilized, and re-emission
 * would point them at sibling serializers/interfaces that may have shape-
 * shifted under the user's feet.
 */
function isUserOwnedAfterFirstEmit(relPath: string): boolean {
  if (relPath.endsWith('.spec.ts') || relPath.endsWith('.test.ts')) return true;
  if (/\/fixtures\/[^/]+\.json$/.test(relPath)) return true;
  return false;
}

interface LiveSurfacePolicy {
  managedPaths: Set<string>;
  hasExistingSdk: boolean;
  adoptedServiceDirs: Set<string>;
  ownedServiceDirs: Set<string>;
  oagenOwnedDirs: Set<string>;
  regenerateOwnedTests: boolean;
}

function managedPathsFor(ctx: EmitterContext, surface: LiveSurface): Set<string> {
  const managedPaths = new Set(surface.trackedFiles.size > 0 ? surface.trackedFiles : surface.files);
  for (const relPath of ctx.priorTargetManifestPaths ?? []) {
    if (relPath.startsWith('src/')) managedPaths.add(relPath);
  }
  return managedPaths;
}

function markPriorManifestAutogen(
  surface: LiveSurface,
  root: string,
  priorManifestPaths: Set<string> | undefined,
): void {
  if (!priorManifestPaths) return;

  for (const relPath of priorManifestPaths) {
    if (!relPath.startsWith('src/')) continue;
    if (!surface.files.has(relPath)) continue;
    if (surface.protectedFiles.has(relPath)) continue;

    if (/\/fixtures\/[^/]+\.json$/.test(relPath)) {
      surface.autogenFiles.add(relPath);
      continue;
    }

    try {
      const text = fs.readFileSync(path.join(root, relPath), 'utf8');
      if (/auto-generated by oagen/i.test(text.slice(0, 400))) {
        surface.autogenFiles.add(relPath);
        extractManifestFunctions(text, relPath, surface);
      }
    } catch {
      // File disappeared between surface walk and read; ignore it.
    }
  }
}

const MANIFEST_FUNCTION_RE = /^\s*export\s+(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)/gm;
const MANIFEST_CONST_FN_RE =
  /^\s*export\s+const\s+([a-zA-Z_$][\w$]*)\s*(?::\s*[^=]+)?=\s*(?:async\s+)?(?:<[^>]*>\s*)?\(/gm;

function extractManifestFunctions(text: string, relPath: string, surface: LiveSurface): void {
  for (const match of text.matchAll(MANIFEST_FUNCTION_RE)) {
    surface.functions.set(match[1], relPath);
  }
  for (const match of text.matchAll(MANIFEST_CONST_FN_RE)) {
    surface.functions.set(match[1], relPath);
  }
}

function buildLiveSurfacePolicy(ctx: EmitterContext, surface: LiveSurface): LiveSurfacePolicy {
  const managedPaths = managedPathsFor(ctx, surface);
  const hasExistingSdk = managedPaths.size > 0;
  const adoptedServiceDirs = nodeOptions(ctx).adoptMissingServices
    ? computeAdoptedServiceDirs(ctx, surface)
    : new Set<string>();
  const ownedServiceDirs = computeOwnedServiceDirs(ctx);
  for (const dir of ownedServiceDirs) {
    for (const relPath of surface.files) {
      if (topLevelDir(relPath) === dir) managedPaths.add(relPath);
    }
  }

  return {
    managedPaths,
    hasExistingSdk,
    adoptedServiceDirs,
    ownedServiceDirs,
    oagenOwnedDirs: topLevelDirs(surface.autogenFiles),
    regenerateOwnedTests: nodeOptions(ctx).regenerateOwnedTests === true,
  };
}

function computeOwnedServiceDirs(ctx: EmitterContext): Set<string> {
  const dirs = new Set<string>();
  if ((nodeOptions(ctx).ownedServices ?? []).length === 0) return dirs;

  const mountGroups = groupByMount(ctx);
  const services =
    mountGroups.size > 0
      ? [...mountGroups].map(([name, group]) => ({
          name,
          operations: group.operations,
        }))
      : ctx.spec.services;
  const { resolveDir } = createServiceDirResolver(ctx.spec.models, ctx.spec.services, ctx);

  for (const service of services) {
    const resourceName = resolveResourceClassName(service, ctx);
    if (!isNodeOwnedService(ctx, service.name, resourceName)) continue;
    dirs.add(resolveResourceDir(service, ctx));
    dirs.add(resolveDir(service.name));
  }

  return dirs;
}

function computeAdoptedServiceDirs(ctx: EmitterContext, surface: LiveSurface): Set<string> {
  const dirs = new Set<string>();
  const mountGroups = groupByMount(ctx);
  const services =
    mountGroups.size > 0
      ? [...mountGroups].map(([name, group]) => ({
          name,
          operations: group.operations,
        }))
      : ctx.spec.services;
  const { resolveDir } = createServiceDirResolver(ctx.spec.models, ctx.spec.services, ctx);

  for (const service of services) {
    if (service.operations.length === 0) continue;

    const resourceName = resolveResourceClassName(service, ctx);
    if (surface.classes.has(resourceName) || ctx.apiSurface?.classes?.[resourceName]) continue;

    const resourceDir = resolveResourceDir(service, ctx);
    const resourcePath = `src/${resourceDir}/${fileName(resourceName)}.ts`;
    if (surface.protectedFiles.has(resourcePath)) continue;

    dirs.add(resourceDir);
    dirs.add(resolveDir(service.name));
  }

  return dirs;
}

function computeAdoptedModelNames(ctx: EmitterContext, surface: LiveSurface): Set<string> {
  if (!nodeOptions(ctx).adoptMissingServices) return new Set();

  const adoptedServiceDirs = computeAdoptedServiceDirs(ctx, surface);
  if (adoptedServiceDirs.size === 0) return new Set();

  const modelToService = assignModelsToServices(ctx.spec.models, ctx.spec.services, ctx.modelHints);
  const { resolveDir } = createServiceDirResolver(ctx.spec.models, ctx.spec.services, ctx);
  const names = new Set<string>();
  for (const model of ctx.spec.models) {
    const dirName = resolveDir(modelToService.get(model.name));
    if (adoptedServiceDirs.has(dirName)) names.add(model.name);
  }
  return names;
}

function topLevelDirs(paths: Set<string>): Set<string> {
  const dirs = new Set<string>();
  for (const relPath of paths) {
    const dir = topLevelDir(relPath);
    if (dir) dirs.add(dir);
  }
  return dirs;
}

function topLevelDir(relPath: string): string | undefined {
  return relPath.match(/^src\/([^/]+)\//)?.[1];
}

function canCreateNewPath(relPath: string, policy: LiveSurfacePolicy): boolean {
  const dir = topLevelDir(relPath);
  if (!dir) return false;
  return policy.adoptedServiceDirs.has(dir) || policy.ownedServiceDirs.has(dir) || policy.oagenOwnedDirs.has(dir);
}

function isOwnedPath(relPath: string, policy: LiveSurfacePolicy): boolean {
  const dir = topLevelDir(relPath);
  return dir !== undefined && policy.ownedServiceDirs.has(dir);
}

/** Read the current on-disk content of a live-surface file, if present. */
function readExistingSurfaceFile(surface: LiveSurface, relPath: string): string | null {
  if (!surface.rootDir) return null;
  try {
    return fs.readFileSync(path.join(surface.rootDir, relPath), 'utf8');
  } catch {
    return null;
  }
}

function extractRelativeImportPaths(content: string, fromPath: string): string[] {
  const dir = path.dirname(fromPath);
  const paths: string[] = [];
  const re = /from\s+['"](\.[^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    paths.push(path.normalize(path.join(dir, match[1])) + '.ts');
  }
  return paths;
}

function applyLiveSurface(files: GeneratedFile[], ctx: EmitterContext, surface: LiveSurface): GeneratedFile[] {
  const out: GeneratedFile[] = [];
  const policy = buildLiveSurfacePolicy(ctx, surface);
  const filesByPath = new Map(files.map((f) => [f.path, f]));
  const dependencyAllowedPaths = new Set<string>();
  const queue: string[] = [];

  for (const f of files) {
    if (f.integrateTarget === false) continue;
    if (!canCreateNewPath(f.path, policy)) continue;
    for (const importPath of extractRelativeImportPaths(f.content, f.path)) {
      if (
        filesByPath.has(importPath) &&
        !canCreateNewPath(importPath, policy) &&
        !dependencyAllowedPaths.has(importPath)
      ) {
        dependencyAllowedPaths.add(importPath);
        queue.push(importPath);
      }
    }
  }

  while (queue.length > 0) {
    const relPath = queue.pop()!;
    const file = filesByPath.get(relPath);
    if (!file) continue;
    for (const importPath of extractRelativeImportPaths(file.content, relPath)) {
      if (
        filesByPath.has(importPath) &&
        !canCreateNewPath(importPath, policy) &&
        !dependencyAllowedPaths.has(importPath)
      ) {
        dependencyAllowedPaths.add(importPath);
        queue.push(importPath);
      }
    }
  }

  for (const f of files) {
    const ownedPath = isOwnedPath(f.path, policy);
    if (f.integrateTarget === false) continue;
    if (surface.protectedFiles.has(f.path)) continue;
    if (
      policy.hasExistingSdk &&
      !policy.managedPaths.has(f.path) &&
      !canCreateNewPath(f.path, policy) &&
      !dependencyAllowedPaths.has(f.path)
    )
      continue;

    // Hand-written files (on disk, no `auto-generated by oagen` header) →
    // drop. The engine would otherwise prepend the header on
    // `skipIfExists: true` files (writeFiles:~4360), and the merger may
    // try to splice generated symbols into hand-written ones.
    if (surface.files.has(f.path) && !surface.autogenFiles.has(f.path) && !ownedPath) continue;

    // Test specs and fixtures: author-owned after first emission. Once a
    // test file or fixture exists on disk, the user owns it — the emitter
    // re-emitting against new IR would either replace assertions/data the
    // user has hand-tuned, or leave it pointing at sibling files that no
    // longer have the same shape. Treat existing test/fixture files as
    // frozen even when they carry the auto-gen header.
    //
    // Adopted-service directories are treated like owned dirs for this
    // purpose: adoption means oagen created the directory from scratch, so
    // by construction there is no hand-written content to preserve and
    // emitting tests/fixtures is safe. Rule (a) still drops files that
    // somehow exist hand-written.
    if (isUserOwnedAfterFirstEmit(f.path)) {
      const dir = topLevelDir(f.path);
      const isAdoptedDir = dir !== undefined && policy.adoptedServiceDirs.has(dir);
      const isManagedDir = ownedPath || isAdoptedDir;
      if (surface.files.has(f.path) && !surface.autogenFiles.has(f.path) && !(ownedPath && policy.regenerateOwnedTests))
        continue;
      if (!isManagedDir && !surface.autogenFiles.has(f.path)) continue;
      if (isManagedDir && !policy.regenerateOwnedTests) continue;
    }

    // Previously auto-generated files → fully overwrite so spec changes
    // (e.g. parameter renames like `admin_emails` → `it_contact_emails`)
    // propagate. The engine's default AST merger is additive and would
    // leave the old name on existing methods. Files marked
    // `@oagen-ignore-start`/`@oagen-ignore-end` regions inside the file
    // are still preserved by `overwriteWithPreservedRegions` in the
    // engine.
    //
    // Exception: a NOT-owned, NOT-adopted service can receive a PARTIAL
    // resource emission — resources.ts filters out operations already
    // covered by the baseline class, leaving only the new methods (see
    // generateResourceClass). Forcing a full overwrite with that partial
    // class deletes the existing public methods (workos-node's
    // api-keys.ts lost four methods when the spec gained one operation).
    // When the generated class would drop methods that the on-disk class
    // declares, merge instead: keep the existing file text verbatim and
    // append only the new methods plus the imports they need.
    if (surface.autogenFiles.has(f.path) || ownedPath) {
      const dir = topLevelDir(f.path);
      const isAdoptedDirPath = dir !== undefined && policy.adoptedServiceDirs.has(dir);
      if (!ownedPath && !isAdoptedDirPath && surface.autogenFiles.has(f.path)) {
        const existingText = readExistingSurfaceFile(surface, f.path);
        if (existingText !== null) {
          const merged = mergeGeneratedClassMethodsIntoExisting(existingText, f.content);
          if (merged !== null) f.content = merged;
        }
      }
      f.overwriteExisting = true;
      f.skipIfExists = false;
    }

    if (f.content && !f.content.endsWith('\n')) {
      f.content += '\n';
    }
    out.push(f);
  }
  const emitted = getEmittedPaths(ctx);
  const emittedFiles = getEmittedFiles(ctx);
  for (const f of out) {
    emitted.add(f.path);
    emittedFiles.set(f.path, f);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Import-resolution invariant
// ---------------------------------------------------------------------------

/**
 * Matches single-line `import`/`export … from './relative'` statements — the
 * only form the node emitter produces. Captures: keyword, optional ` type`
 * modifier, the binding clause (`* [as ns]` or `{ … }`), and the module path.
 */
const RELATIVE_FROM_STMT_RE =
  /^(import|export)(\s+type)?\s+(\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s+['"](\.[^'"]+)['"];?\s*$/;

const EXPORTED_DECL_RE =
  /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:interface|class|enum|function|const|let|var|type)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORTED_CLAUSE_RE = /^export\s+(?:type\s+)?\{([^}]*)\}/gm;

/** Repo-relative paths a relative import specifier may resolve to. */
function importTargetCandidates(fromPath: string, spec: string): string[] {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), spec));
  return [base, `${base}.ts`, `${base}/index.ts`];
}

/** Index exported symbol → file path across this run's emitted contents. */
function indexEmittedExports(files: GeneratedFile[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const f of files) {
    if (!f.path.endsWith('.ts') || !f.content) continue;
    for (const m of f.content.matchAll(EXPORTED_DECL_RE)) {
      if (!index.has(m[1])) index.set(m[1], f.path);
    }
    for (const m of f.content.matchAll(EXPORTED_CLAUSE_RE)) {
      for (const raw of m[1].split(',')) {
        const entry = raw.trim();
        if (!entry) continue;
        const parts = entry.split(/\s+as\s+/);
        const exported = (parts[1] ?? parts[0]).replace(/^type\s+/, '').trim();
        if (exported && !index.has(exported)) index.set(exported, f.path);
      }
    }
  }
  return index;
}

/**
 * Enforce: every relative import/re-export path in emitted code resolves to
 * either (i) a file emitted in the same run, or (ii) a file that already
 * exists on disk in the target SDK.
 *
 * Violations observed in real generations (all TS2307 in otherwise-valid
 * output): serializer imports pointing at canonical paths while the function
 * lives in a legacy hand serializer under a different filename; barrels
 * re-exporting a module-local enum file whose declaration lives under
 * `src/common/interfaces`; barrels exporting interface files that no run
 * emits at all.
 *
 * Repair strategy, per statement whose target is neither emitted nor on
 * disk:
 *  1. Locate each imported symbol (this run's emissions first, then the
 *     live-surface declaration maps) and rewrite the path to where the
 *     symbol actually lives — splitting into one statement per location
 *     when symbols are spread across files.
 *  2. `export * from` / namespace imports carry no symbol list, so derive
 *     the expected symbol from the file stem (`foo-bar.interface` →
 *     `FooBar`, `foo.serializer` → `deserializeFoo`/`serializeFoo`).
 *  3. When a symbol exists nowhere, drop the statement and warn — a missing
 *     named export fails loudly at the usage site instead of as a phantom
 *     module, and a barrel line for a never-emitted file is pure noise.
 *
 * Mutates `f.content` in place and returns the warnings issued.
 */
export function enforceEmittedImportInvariant(
  files: Iterable<GeneratedFile>,
  emittedPaths: Set<string>,
  surface: LiveSurface,
): string[] {
  const fileList = [...files];
  const emittedSymbols = indexEmittedExports(fileList);
  const warnings: string[] = [];

  const targetExists = (fromPath: string, spec: string): boolean =>
    importTargetCandidates(fromPath, spec).some((p) => emittedPaths.has(p) || surface.files.has(p));

  const locateSymbol = (name: string): string | undefined =>
    emittedSymbols.get(name) ??
    surface.functions.get(name) ??
    surface.interfaces.get(name)?.filePath ??
    surface.classes.get(name)?.filePath;

  for (const f of fileList) {
    if (!f.path.endsWith('.ts') || !f.content) continue;
    let changed = false;
    const outLines: string[] = [];
    for (const line of f.content.split('\n')) {
      const m = line.match(RELATIVE_FROM_STMT_RE);
      if (!m || targetExists(f.path, m[4])) {
        outLines.push(line);
        continue;
      }
      const [, keyword, typeMod, clause, spec] = m;
      const repaired = repairUnresolvableStatement(f.path, keyword, typeMod ?? '', clause, spec, locateSymbol);
      changed = true;
      outLines.push(...repaired.lines);
      if (repaired.warning) warnings.push(repaired.warning);
    }
    if (changed) f.content = outLines.join('\n');
  }

  for (const w of warnings) console.warn(w);
  return warnings;
}

function repairUnresolvableStatement(
  fromPath: string,
  keyword: string,
  typeMod: string,
  clause: string,
  spec: string,
  locateSymbol: (name: string) => string | undefined,
): { lines: string[]; warning?: string } {
  if (clause.startsWith('{')) {
    const entries = clause
      .slice(1, -1)
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean);
    const byLocation = new Map<string, string[]>();
    const missing: string[] = [];
    for (const entry of entries) {
      const source = entry
        .split(/\s+as\s+/)[0]
        .replace(/^type\s+/, '')
        .trim();
      const location = locateSymbol(source);
      if (!location) {
        missing.push(source);
        continue;
      }
      if (location === fromPath) continue; // declared locally — no import needed
      const group = byLocation.get(location);
      if (group) {
        group.push(entry);
      } else {
        byLocation.set(location, [entry]);
      }
    }
    // Emit the symbols we *can* relocate; only the genuinely-missing ones are
    // dropped (and warned about). Returning [] for the whole clause when any
    // one symbol is missing would also discard the resolvable symbols, failing
    // them with TS2305 at their usage sites — the breakage this pass prevents.
    const lines = [...byLocation].map(
      ([location, group]) =>
        `${keyword}${typeMod} { ${group.join(', ')} } from '${relativeImport(fromPath, location)}';`,
    );
    const warning =
      missing.length > 0
        ? `oagen(node): dropped unresolvable symbol(s) from ${keyword} in ${fromPath}: '${spec}' — found neither in this run's output nor in the target SDK: ${missing.join(', ')}`
        : undefined;
    return { lines, warning };
  }

  // `* [as ns]` — no symbol list; derive the expected symbol from the stem.
  const stem = spec.split('/').pop() ?? '';
  let location: string | undefined;
  if (stem.endsWith('.interface')) {
    location = locateSymbol(toPascalCase(stem.slice(0, -'.interface'.length)));
  } else if (stem.endsWith('.serializer')) {
    const base = toPascalCase(stem.slice(0, -'.serializer'.length));
    location = locateSymbol(`deserialize${base}`) ?? locateSymbol(`serialize${base}`);
  }
  if (location && location !== fromPath) {
    return { lines: [`${keyword}${typeMod} ${clause} from '${relativeImport(fromPath, location)}';`] };
  }
  return {
    lines: [],
    warning: `oagen(node): dropped unresolvable ${keyword} in ${fromPath}: '${spec}' — module is neither emitted this run nor present in the target SDK`,
  };
}

/**
 * Re-declare prior-manifest paths that we did not emit this run so manifest
 * pruning can tell "intentionally removed" from "untouched but still managed."
 *
 * The node emitter only outputs files it actually wants to write each run —
 * untouched-but-up-to-date autogen files don't come back through any
 * `generateXxx` method. Without this carry-forward, the orchestrator's
 * `prevManifest.files − currentEmission` diff treats every such file as stale
 * and prunes the whole tree on a regen. That's why `scripts/sdk-generate.sh`
 * historically paired the node emitter with `--no-prune` — at the cost of
 * never pruning legitimately-removed files (e.g. an enum file orphaned by a
 * `schemaNameTransform` rename like `RadarAction` → `RadarListAction`).
 *
 * The carry-forward entry uses `skipIfExists: true`, so writer.ts skips the
 * write and only ensures the header is present (no-op for files that already
 * have it). The path still lands in `outputEmittedPaths` and therefore in the
 * new manifest, which restores correct prune semantics.
 *
 * Files dropped from the carry-forward set:
 *  - Not on disk anymore (file was hand-deleted — let prune confirm absence).
 *  - `@oagen-ignore-file` protected (user has explicitly taken ownership).
 *  - `.ts` files that no longer carry the auto-gen header (user has taken
 *    ownership in-place; the next prune cycle will clear the manifest entry).
 */
function carryForwardManagedFiles(ctx: EmitterContext, surface: LiveSurface): GeneratedFile[] {
  const priorPaths = ctx.priorTargetManifestPaths;
  if (!priorPaths || priorPaths.size === 0) return [];

  const emitted = getEmittedPaths(ctx);
  const out: GeneratedFile[] = [];
  for (const relPath of priorPaths) {
    if (emitted.has(relPath)) continue;
    if (!surface.files.has(relPath)) continue;
    if (surface.protectedFiles.has(relPath)) continue;
    if (relPath.endsWith('.ts') && !surface.autogenFiles.has(relPath)) continue;

    out.push({
      path: relPath,
      content: '',
      skipIfExists: true,
      headerPlacement: 'skip',
    });
    emitted.add(relPath);
  }
  return out;
}

/**
 * Flatten oneOf / allOf+oneOf variant fields from the raw spec onto each
 * model. `enrichModelsFromSpec` produces (a) extra optional fields on models
 * whose schema is `allOf [base, oneOf [...]]`, and (b) synthetic models /
 * enums for inline objects encountered inside variants (e.g. the inline
 * `redirect_uris` item shape on `ConnectApplication`).
 *
 * Node, like Go / Kotlin / .NET, emits flat interfaces rather than a sum
 * type, so on `enrichModelsFromSpec`-marked discriminated bases we restore
 * the original IR fields — otherwise the base interface would be empty.
 * A future change can emit a real TS discriminated union; for now the goal
 * is parity with the other flat-emit languages so every variant field is
 * at least reachable.
 */
function enrichModelsForNode(models: Model[]): Model[] {
  const enriched = enrichModelsFromSpec(models);
  const originalByName = new Map(models.map((m) => [m.name, m]));
  const restored = enriched.map((m) => {
    if ((m as { discriminator?: unknown }).discriminator && m.fields.length === 0) {
      const original = originalByName.get(m.name);
      if (original && original.fields.length > 0) {
        return { ...m, fields: original.fields };
      }
    }
    return m;
  });
  // Field-level discriminated unions (e.g. ApiKey.owner) otherwise render as
  // `FirstVariant | SecondVariant`; collapse them to one flat superset
  // interface so callers see every variant field (organization_id on the user
  // owner) on a single type — parity with the other flat-emit languages.
  return flattenDiscriminatedUnionFields(restored);
}

export const nodeEmitter: Emitter = {
  language: 'node',

  generateModels(models: Model[], ctx: EmitterContext): GeneratedFile[] {
    const nodeCtx = withNodeOperationOverrides(ctx);
    const surface = getSurface(nodeCtx);
    const enriched = enrichModelsForNode(models);
    // Detect `allOf [base, oneOf [variant, …]]` schemas and hand them off
    // to the discriminated-models module. Leave the model in the standard
    // pipeline's input so its field-type deps stay reachable, but stash the
    // name set on ctx so models.ts skips emitting an interface/serializer —
    // the discriminated module owns those paths instead.
    const discPlans = planDiscriminatedModels(enriched, nodeCtx);
    const discriminatedNames = new Set(discPlans.keys());
    (nodeCtx as { _discriminatedModelNames?: Set<string> })._discriminatedModelNames = discriminatedNames;
    setDiscriminatedModelNames(discriminatedNames);
    const standardFiles = generateModelsAndSerializers(enriched, nodeCtx);
    const discFiles = generateDiscriminatedFiles(discPlans, nodeCtx);
    return applyLiveSurface([...standardFiles, ...discFiles], nodeCtx, surface);
  },

  generateEnums(enums: Enum[], ctx: EmitterContext): GeneratedFile[] {
    const nodeCtx = withNodeOperationOverrides(ctx);
    const surface = getSurface(nodeCtx);
    const syntheticEnums = getSyntheticEnums();
    return applyLiveSurface(generateEnumFiles([...enums, ...syntheticEnums], nodeCtx), nodeCtx, surface);
  },

  generateResources(services: Service[], ctx: EmitterContext): GeneratedFile[] {
    const nodeCtx = withNodeOperationOverrides(ctx);
    const surface = getSurface(nodeCtx);
    return applyLiveSurface(generateResources(services, nodeCtx), nodeCtx, surface);
  },

  generateClient(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
    const nodeCtx = withNodeOperationOverrides(ctx);
    const surface = getSurface(nodeCtx);
    // Use `nodeCtx.spec`'s enriched MODELS (synthetic inline-object item types
    // like `ConnectApplicationRedirectUri` that the engine's pre-enrichment
    // `spec` lacks), but restrict SERVICES to the emit surface the engine
    // resolved (`spec.services` = selected ∪ already-on-disk). Passing
    // nodeCtx.spec's FULL service list made workos.ts wire `readonly agents =
    // new Agents(this)` (and the barrel export it) for a spec service this SDK
    // never generated → dangling reference (TS2304); the import got scrubbed by
    // the emitted-import invariant but the accessor did not.
    const surfaceNames = new Set(spec.services.map((s) => s.name));
    const clientSpec: ApiSpec = {
      ...nodeCtx.spec,
      services: nodeCtx.spec.services.filter((s) => surfaceNames.has(s.name)),
    };
    return applyLiveSurface(generateClient(clientSpec, nodeCtx), nodeCtx, surface);
  },

  // workos-node ships its own exception hierarchy under src/common/exceptions/.
  // Re-emitting them would either skip (if files exist) or overwrite hand-edits.
  generateErrors(_ctx: EmitterContext): GeneratedFile[] {
    return [];
  },

  generateTypeSignatures(_spec: ApiSpec, _ctx: EmitterContext): GeneratedFile[] {
    return [];
  },

  // Test specs and fixtures are hand-maintained except for explicitly-owned
  // service directories.
  //
  // This is also the last `generateXxx` hook in `generateAllFiles`, so it's
  // where we tack on the carry-forward set — see `carryForwardManagedFiles`.
  generateTests(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
    const nodeCtx = withNodeOperationOverrides(ctx);
    const surface = getSurface(nodeCtx);
    const testFiles = nodeOptions(nodeCtx).regenerateOwnedTests
      ? applyLiveSurface(generateTestFiles(spec, nodeCtx), nodeCtx, surface)
      : [];
    const result = [...testFiles, ...carryForwardManagedFiles(nodeCtx, surface)];

    // Final whole-run pass: this is the last generate hook, every hook shares
    // `nodeCtx`, and the engine reads contents only after all hooks return —
    // so the emitted-files cache now covers the complete run and repairs here
    // reach files produced by earlier hooks. Greenfield runs are exempt: with
    // no SDK on disk, "resolves to an existing file" has no meaning and the
    // SDK core (workos.ts, common/) is intentionally not emitted.
    if (managedPathsFor(nodeCtx, surface).size > 0) {
      enforceEmittedImportInvariant(getEmittedFiles(nodeCtx).values(), getEmittedPaths(nodeCtx), surface);
    }
    return result;
  },

  // No operations map needed — the manifest belongs to the staging+target flow,
  // which the literal `--output <SDK>` command does not use.
  buildOperationsMap(): Record<string, never> {
    return {};
  },

  fileHeader(): string {
    return `// ${AUTOGEN_NOTICE}`;
  },

  formatCommand(targetDir: string): FormatCommand | null {
    const hasPrettier = fs.existsSync(path.join(targetDir, '.prettierrc'));
    const hasEslint =
      fs.existsSync(path.join(targetDir, 'eslint.config.mjs')) ||
      fs.existsSync(path.join(targetDir, 'eslint.config.js')) ||
      fs.existsSync(path.join(targetDir, '.eslintrc.json')) ||
      fs.existsSync(path.join(targetDir, '.eslintrc.js'));

    if (hasPrettier && hasEslint) {
      return {
        cmd: 'bash',
        args: [
          '-c',
          'npx eslint --fix --no-error-on-unmatched-pattern "$@" 2>/dev/null; npx prettier --write --log-level silent "$@"',
          '--',
        ],
      };
    }
    if (hasPrettier) {
      return {
        cmd: 'npx',
        args: ['prettier', '--write', '--log-level', 'silent'],
      };
    }
    if (hasEslint) {
      return {
        cmd: 'npx',
        args: ['eslint', '--fix', '--no-error-on-unmatched-pattern'],
      };
    }
    return null;
  },
};
