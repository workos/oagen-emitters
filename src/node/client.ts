import fs from 'node:fs';
import path from 'node:path';
import type { ApiSpec, AuthScheme, EmitterContext, GeneratedFile } from '@workos/oagen';

import {
  fileName,
  servicePropertyName,
  resolveInterfaceName,
  wireInterfaceName,
  resolveServiceName,
} from './naming.js';
import { isInlineEnum } from './type-map.js';
import {
  docComment,
  createServiceDirResolver,
  isServiceCoveredByExisting,
  isListMetadataModel,
  isListWrapperModel,
  computeNonEventReachable,
} from './utils.js';
import { isNodeOwnedService, nodeOptions } from './options.js';
import { resolveResourceClassName, resolveResourceDir } from './resources.js';
import { generatedResourceInterfaceModelNames } from './models.js';
import { assignEnumsToServices } from './enums.js';
import { liveSurfaceInterfacePath } from './live-surface.js';

export function generateClient(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  files.push(generateWorkOSClient(spec, ctx));
  files.push(...generateServiceBarrels(spec, ctx));
  files.push(generateBarrel(spec, ctx));
  // worker barrel, package.json, tsconfig.json are now hand-maintained in the target SDK

  return files;
}

function generateWorkOSClient(spec: ApiSpec, ctx: EmitterContext): GeneratedFile {
  const lines: string[] = [];

  // Only import WorkOSBase for fresh generation (no existing WorkOS class).
  // When integrating into an existing SDK, the existing WorkOS already has its
  // own base class and the WorkOSBase file may not exist.
  const hasExistingWorkOS = !!ctx.apiSurface?.classes?.['WorkOS'];
  if (!hasExistingWorkOS) {
    lines.push("import { WorkOSBase } from './common/workos-base';");
  }

  // Filter out services whose endpoints are already covered by existing
  // hand-written service classes (e.g., Connections covered by SSO).
  const coveredServices = new Set<string>();
  for (const service of spec.services) {
    if (isServiceCoveredByExisting(service, ctx)) {
      coveredServices.add(service.name);
    }
  }

  // Service imports — skip covered services
  for (const service of spec.services) {
    if (coveredServices.has(service.name)) continue;
    const resolvedName = resolveResourceClassName(service, ctx);
    const serviceDir = resolveResourceDir(service, ctx);
    lines.push(`import { ${resolvedName} } from './${serviceDir}/${fileName(resolvedName)}';`);
  }

  lines.push('');
  if (spec.description) {
    lines.push(...docComment(spec.description));
  }
  const extendsClause = hasExistingWorkOS ? '' : ' extends WorkOSBase';
  lines.push(`export class WorkOS${extendsClause} {`);

  // Server URL constants from spec.servers
  if (spec.servers && spec.servers.length > 0) {
    for (const server of spec.servers) {
      const constName = serverConstName(server.description ?? server.url);
      if (server.description) {
        lines.push(...docComment(server.description, 2));
      }
      lines.push(`  static readonly ${constName} = '${server.url}';`);
    }
    lines.push('');
  }

  // Resource accessors — skip services whose property already exists
  // in the baseline WorkOS class (e.g., `portal` covers AdminPortal,
  // `mfa` covers MultiFactorAuth).
  const existingProps = new Set<string>();
  const baselineWorkOS = ctx.apiSurface?.classes?.['WorkOS'] ?? ctx.apiSurface?.classes?.['WorkOSNode'];
  if (baselineWorkOS?.properties) {
    for (const name of Object.keys(baselineWorkOS.properties)) {
      existingProps.add(name);
    }
  }
  // Resource accessors — skip services whose endpoints are fully covered
  // by existing hand-written services.
  for (const service of spec.services) {
    if (coveredServices.has(service.name)) continue;
    const resolvedName = resolveResourceClassName(service, ctx);
    // Accessor name uses the un-suffixed service name so that the public API
    // stays `client.organizationMembership` even when the class itself was
    // renamed to `OrganizationMembershipService` to avoid a model collision.
    const propName = servicePropertyName(resolveServiceName(service, ctx));
    if (existingProps.has(propName)) continue;
    // Propagate `@deprecated` from the service class to the property so
    // IDEs surface the strikethrough at `workos.xyz` access sites, not
    // just when users `new Xyz()` directly.  TS's deprecation-lint reads
    // the property JSDoc, not the underlying type declaration.
    const classDeprecation = ctx.apiSurface?.classes?.[resolvedName]?.deprecationMessage;
    if (classDeprecation !== undefined) {
      const body = classDeprecation ? ` ${classDeprecation}` : '';
      lines.push(`  /** @deprecated${body} */`);
    }
    lines.push(`  readonly ${propName} = new ${resolvedName}(this);`);
  }

  // Auth override — only emit when auth is non-default (not bearer)
  if (needsAuthOverride(spec.auth)) {
    lines.push('');
    lines.push('  protected override setAuthHeaders(headers: Record<string, string>): void {');
    renderAuthOverride(lines, spec.auth!);
    lines.push('  }');
  }

  lines.push('}');

  return {
    path: 'src/workos.ts',
    content: lines.join('\n'),
    skipIfExists: true,
  };
}

function sourceFileForExportedType(ctx: EmitterContext, typeName: string): string | undefined {
  return (
    (ctx.apiSurface?.interfaces?.[typeName] as { sourceFile?: string } | undefined)?.sourceFile ??
    (ctx.apiSurface?.typeAliases?.[typeName] as { sourceFile?: string } | undefined)?.sourceFile ??
    (ctx.apiSurface?.enums?.[typeName] as { sourceFile?: string } | undefined)?.sourceFile ??
    liveSurfaceInterfacePath(typeName)
  );
}

function exportedNamesForSource(ctx: EmitterContext, sourceFile: string): string[] {
  const names = new Set<string>();
  const addNamesFromSurface = (items: Record<string, unknown> | undefined) => {
    if (!items) return;
    for (const [name, item] of Object.entries(items)) {
      if ((item as { sourceFile?: string }).sourceFile === sourceFile) {
        names.add(name);
      }
    }
  };

  addNamesFromSurface(ctx.apiSurface?.interfaces);
  addNamesFromSurface(ctx.apiSurface?.typeAliases);
  addNamesFromSurface(ctx.apiSurface?.enums);

  const rootDir = ctx.targetDir ?? ctx.outputDir;
  if (rootDir) {
    try {
      const content = fs.readFileSync(path.join(rootDir, sourceFile), 'utf-8');
      for (const match of content.matchAll(/export\s+(?:interface|type|enum|class|const|function)\s+(\w+)/g)) {
        names.add(match[1]);
      }
    } catch {
      // The live source map is best-effort; apiSurface/livesurface names above
      // are enough when the file is not readable.
    }
  }

  return [...names];
}

/**
 * Generate per-service barrel files (interfaces/index.ts) that re-export
 * all interface and enum files for each service directory. This reduces
 * the root barrel from ~200+ individual type exports to one wildcard
 * re-export per service.
 */
function generateServiceBarrels(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const { modelToService, resolveDir } = createServiceDirResolver(spec.models, spec.services, ctx);
  const enumToService = assignEnumsToServices(spec.enums, spec.services, spec.models, ctx);

  // Group interface files by directory, tracking exported symbol names
  // to prevent TS2308 duplicate export errors when two files in the same
  // directory export the same symbol (e.g., FooResponse as a wire type
  // from one file and a domain type from another).
  const dirExports = new Map<string, string[]>();
  const dirSymbols = new Map<string, Set<string>>();
  const ownedDirNames = new Set<string>();
  for (const service of spec.services) {
    if (isNodeOwnedService(ctx, service.name)) {
      ownedDirNames.add(resolveDir(service.name));
    }
  }

  // Pre-seed dirSymbols with names already exported by existing interface files.
  // When the existing SDK has an interface file in a directory that already
  // exports a name (e.g., AuditLogSchema from create-audit-log-schema-options),
  // the generated model with the same name must be skipped to prevent the
  // merger from adding a duplicate `export *` that causes TS2308.
  //
  // Also track baseline file stems per directory so we can detect when the
  // barrel needs updating with new export lines (see hasNewExports below).
  const dirSymbolsFromBaseline = new Map<string, Set<string>>();
  const seedFromBaseline = (sourceFile: string, name: string) => {
    const match = sourceFile.match(/^src\/([^/]+)\/interfaces\/(.+)\.ts$/);
    if (!match) return;
    const dirName = match[1];
    if (ownedDirNames.has(dirName)) return;
    const fileStem = match[2];
    if (!dirSymbols.has(dirName)) dirSymbols.set(dirName, new Set());
    dirSymbols.get(dirName)!.add(name);
    if (!dirSymbolsFromBaseline.has(dirName)) dirSymbolsFromBaseline.set(dirName, new Set());
    dirSymbolsFromBaseline.get(dirName)!.add(fileStem);
  };
  if (ctx.apiSurface?.interfaces) {
    for (const [name, iface] of Object.entries(ctx.apiSurface.interfaces)) {
      const sourceFile = (iface as any).sourceFile as string | undefined;
      if (sourceFile) seedFromBaseline(sourceFile, name);
    }
  }
  if (ctx.apiSurface?.enums) {
    for (const [name, enumDef] of Object.entries(ctx.apiSurface.enums)) {
      const sourceFile = (enumDef as any).sourceFile as string | undefined;
      if (sourceFile) seedFromBaseline(sourceFile, name);
    }
  }
  if (ctx.apiSurface?.typeAliases) {
    for (const [name, alias] of Object.entries(ctx.apiSurface.typeAliases)) {
      const sourceFile = (alias as any).sourceFile as string | undefined;
      if (sourceFile) seedFromBaseline(sourceFile, name);
    }
  }

  // Build a global set of all symbols across all directories for
  // cross-directory deduplication.  This prevents adding a model to one
  // directory's barrel when the same symbol already exists in another
  // directory's barrel (e.g., Event in common vs events, DirectoryState
  // in directory-sync vs common).
  const globalExistingSymbols = new Set<string>();
  for (const symbols of dirSymbols.values()) {
    for (const sym of symbols) {
      globalExistingSymbols.add(sym);
    }
  }

  // Models -> service directories
  // Skip list wrapper and list metadata models — they use shared List<T>/ListMetadata
  // from common utils, so no per-resource interface file is generated.
  // Also skip unreachable models — use the same non-event reachability as model
  // generation so every barrel entry has a corresponding generated file.
  const barrelReachable =
    generatedResourceInterfaceModelNames(spec.models, ctx) ?? computeNonEventReachable(spec.services, spec.models);
  for (const model of spec.models) {
    if (isListMetadataModel(model) || isListWrapperModel(model)) continue;
    if (!barrelReachable.has(model.name)) continue;
    const service = modelToService.get(model.name);
    const dirName = resolveDir(service);
    if (!dirExports.has(dirName)) {
      dirExports.set(dirName, []);
      // Only initialize dirSymbols if not already pre-seeded from baseline
      if (!dirSymbols.has(dirName)) {
        dirSymbols.set(dirName, new Set());
      }
    }

    // Each model file exports a domain interface and a wire interface.
    // Track these symbols to detect cross-file collisions.
    const domainName = resolveInterfaceName(model.name, ctx);
    const wireName = wireInterfaceName(domainName);
    const symbols = dirSymbols.get(dirName)!;

    if (globalExistingSymbols.has(domainName) || globalExistingSymbols.has(wireName)) {
      // Skip this model's export to avoid duplicate symbol in the barrel
      // (checks across ALL directories, not just the target one)
      continue;
    }

    symbols.add(domainName);
    symbols.add(wireName);
    // Also track in the global set so subsequent models in other directories
    // don't re-export the same symbol (intra-generation cross-directory dedup).
    globalExistingSymbols.add(domainName);
    globalExistingSymbols.add(wireName);
    dirExports.get(dirName)!.push(`export * from './${fileName(model.name)}.interface';`);
  }

  // Enums -> service directories
  for (const enumDef of spec.enums) {
    // Inlined enums have no file to re-export.
    if (isInlineEnum(enumDef.name)) continue;

    const enumService = enumToService.get(enumDef.name);
    const dirName = resolveDir(enumService);
    if (!dirExports.has(dirName)) {
      dirExports.set(dirName, []);
      if (!dirSymbols.has(dirName)) {
        dirSymbols.set(dirName, new Set());
      }
    }

    const symbols = dirSymbols.get(dirName)!;
    if (globalExistingSymbols.has(enumDef.name)) continue;

    symbols.add(enumDef.name);
    globalExistingSymbols.add(enumDef.name);
    dirExports.get(dirName)!.push(`export * from './${fileName(enumDef.name)}.interface';`);
  }

  const overrideWildcardSources = new Set<string>();
  const overrideNamedExports = new Set<string>();
  const addOverrideTypeExport = (typeName: string | undefined) => {
    if (!typeName) return;
    const sourceFile = sourceFileForExportedType(ctx, typeName);
    if (!sourceFile) return;
    const match = sourceFile?.match(/^src\/([^/]+)\/interfaces\/(.+)\.ts$/);
    if (!match) return;
    const dirName = match[1];
    const stem = match[2].replace(/\.ts$/, '');
    if (!dirExports.has(dirName)) {
      dirExports.set(dirName, []);
      if (!dirSymbols.has(dirName)) {
        dirSymbols.set(dirName, new Set());
      }
    }
    const symbols = dirSymbols.get(dirName)!;
    const sourceKey = `${dirName}/${stem}`;
    if (overrideWildcardSources.has(sourceKey)) return;

    const sourceNames = exportedNamesForSource(ctx, sourceFile);
    const hasConflictingNeighbor = sourceNames.some((name) => name !== typeName && globalExistingSymbols.has(name));
    if (hasConflictingNeighbor) {
      const exportKey = `${sourceKey}:${typeName}`;
      if (overrideNamedExports.has(exportKey)) return;
      dirExports.get(dirName)!.push(`export type { ${typeName} } from './${stem}';`);
      overrideNamedExports.add(exportKey);
      symbols.add(typeName);
      globalExistingSymbols.add(typeName);
      return;
    }

    dirExports.get(dirName)!.push(`export * from './${stem}';`);
    overrideWildcardSources.add(sourceKey);
    const namesToRegister = sourceNames.length > 0 ? sourceNames : [typeName];
    for (const name of namesToRegister) {
      symbols.add(name);
      globalExistingSymbols.add(name);
    }
  };

  for (const override of Object.values(nodeOptions(ctx).operationOverrides ?? {})) {
    addOverrideTypeExport(override.optionsType);
    for (const typeName of override.returnTypeImports ?? []) {
      addOverrideTypeExport(typeName);
    }
  }

  const generatedOptionExports = (ctx as any)._nodeGeneratedOptionInterfaceExports as
    | Map<string, Array<{ stem: string; typeName: string }>>
    | undefined;
  for (const [dirName, options] of generatedOptionExports ?? []) {
    if (!dirExports.has(dirName)) {
      dirExports.set(dirName, []);
      if (!dirSymbols.has(dirName)) {
        dirSymbols.set(dirName, new Set());
      }
    }
    const symbols = dirSymbols.get(dirName)!;
    for (const { stem, typeName } of options) {
      if (globalExistingSymbols.has(typeName)) continue;
      symbols.add(typeName);
      globalExistingSymbols.add(typeName);
      dirExports.get(dirName)!.push(`export * from './${stem}';`);
    }
  }

  for (const [dirName, exports] of dirExports) {
    const exportSet = new Set(exports);
    const isDirOwned = ownedDirNames.has(dirName);

    // When integrating into an existing SDK, include baseline exports from
    // the api-surface so the barrel is comprehensive.  This ensures stale
    // entries (e.g., renamed files from previous generations) are removed
    // when overwriteExisting replaces the barrel.
    if (ctx.apiSurface && !isDirOwned) {
      const addBaselineExports = (items: Record<string, any> | undefined) => {
        if (!items) return;
        for (const item of Object.values(items)) {
          const sourceFile = (item as any).sourceFile as string | undefined;
          if (!sourceFile) continue;
          const match = sourceFile.match(/^src\/([^/]+)\/interfaces\/(.+)\.ts$/);
          if (match && match[1] === dirName) {
            exportSet.add(`export * from './${match[2].replace(/\.ts$/, '')}';`);
          }
        }
      };
      addBaselineExports(ctx.apiSurface.interfaces);
      addBaselineExports(ctx.apiSurface.typeAliases);
      addBaselineExports(ctx.apiSurface.enums);

      // Preserve existing barrel entries: read the current barrel from the
      // target directory and keep every `export * from './<stem>'` whose
      // corresponding file still exists on disk.  This prevents dropping
      // hand-written types (e.g., Factor in multi-factor-auth) when a
      // generated model in the same file causes a symbol collision.
      if (ctx.targetDir && !isDirOwned) {
        const interfacesDir = path.join(ctx.targetDir, 'src', dirName, 'interfaces');
        try {
          const barrelPath = path.join(interfacesDir, 'index.ts');
          const barrelContent = fs.readFileSync(barrelPath, 'utf-8');
          for (const line of barrelContent.split('\n')) {
            const match = line.match(/^export \* from '\.\/(.*?)';?$/);
            if (!match) continue;
            const stem = match[1];
            const exportLine = `export * from './${stem}';`;
            if (exportSet.has(exportLine)) continue;
            // Verify the referenced file still exists
            const filePath = path.join(interfacesDir, `${stem}.ts`);
            try {
              fs.accessSync(filePath);
              exportSet.add(exportLine);
            } catch {
              // File no longer exists — don't preserve stale entry
            }
          }
        } catch {
          // No existing barrel — nothing to preserve
        }

        // Also scan for NEW interface files not in the existing barrel or
        // apiSurface (e.g., list wrappers, hand-written types added after
        // the last generation).
        const symbols = dirSymbols.get(dirName) ?? new Set<string>();
        try {
          for (const entry of fs.readdirSync(interfacesDir)) {
            if (entry === 'index.ts') continue;
            if (!entry.endsWith('.ts')) continue;
            const stem = entry.replace(/\.ts$/, '');
            const exportLine = `export * from './${stem}';`;
            if (exportSet.has(exportLine)) continue;

            // Extract exported symbol names from the file to check for conflicts
            const content = fs.readFileSync(path.join(interfacesDir, entry), 'utf-8');
            const exportedNames: string[] = [];
            for (const m of content.matchAll(/export\s+(?:interface|type|enum|class|const|function)\s+(\w+)/g)) {
              exportedNames.push(m[1]);
            }

            // Skip if any exported name collides with a symbol already
            // claimed by any file (same or different directory)
            const hasCollision = exportedNames.some((name) => globalExistingSymbols.has(name));
            if (hasCollision) continue;

            // Safe to add — register symbols and include in barrel
            for (const name of exportedNames) {
              symbols.add(name);
              globalExistingSymbols.add(name);
            }
            exportSet.add(exportLine);
          }
        } catch {
          // Directory doesn't exist in target — nothing to scan
        }
      }
    }

    // Deduplicate and sort
    const uniqueExports = [...exportSet];
    uniqueExports.sort();

    if (ctx.apiSurface) {
      // Integration mode: overwrite the barrel so stale entries are removed.
      files.push({
        path: `src/${dirName}/interfaces/index.ts`,
        content: uniqueExports.join('\n'),
        overwriteExisting: true,
      });
    } else {
      // Standalone generation: only update if there are new exports.
      const baselineSymbols = dirSymbolsFromBaseline.get(dirName);
      const hasNewExports = baselineSymbols
        ? uniqueExports.some((exp) => {
            const match = exp.match(/from '\.\/(.*?)'/);
            if (!match) return false;
            return !baselineSymbols.has(match[1]);
          })
        : false;

      files.push({
        path: `src/${dirName}/interfaces/index.ts`,
        content: uniqueExports.join('\n'),
        skipIfExists: !hasNewExports,
      });
    }
  }

  return files;
}

function generateBarrel(spec: ApiSpec, ctx: EmitterContext): GeneratedFile {
  const lines: string[] = [];
  const { modelToService, resolveDir } = createServiceDirResolver(spec.models, spec.services, ctx);
  const enumToService = assignEnumsToServices(spec.enums, spec.services, spec.models, ctx);

  // Track all exported names to prevent duplicates.
  // Pre-seed with names already exported by the existing SDK to avoid generating
  // duplicate exports that would conflict with existing `export *` statements.
  const exportedNames = new Set<string>();
  if (ctx.apiSurface?.interfaces) {
    for (const name of Object.keys(ctx.apiSurface.interfaces)) {
      exportedNames.add(name);
    }
  }
  if (ctx.apiSurface?.classes) {
    for (const name of Object.keys(ctx.apiSurface.classes)) {
      exportedNames.add(name);
    }
  }

  // Collect names already exported by the existing SDK (via export * or named exports).
  // When an explicit `export type { Foo }` would shadow a wildcard re-export that
  // already provides a hand-written version of Foo (e.g., a discriminated union),
  // we must skip the explicit export so the wildcard wins.
  const existingSdkExports = new Set<string>();
  if (ctx.apiSurface?.exports) {
    for (const names of Object.values(ctx.apiSurface.exports)) {
      for (const name of names) {
        existingSdkExports.add(name);
      }
    }
  }

  // Common exports
  lines.push("export * from './common/exceptions';");
  lines.push("export { AutoPaginatable } from './common/utils/pagination';");
  lines.push("export type { List, ListMetadata, ListResponse } from './common/utils/pagination';");
  lines.push("export type { PaginationOptions } from './common/interfaces/pagination-options.interface';");
  lines.push("export type { WorkOSOptions } from './common/interfaces/workos-options.interface';");
  lines.push("export type { PostOptions } from './common/interfaces/post-options.interface';");
  lines.push("export type { GetOptions } from './common/interfaces/get-options.interface';");
  lines.push('');
  for (const name of [
    'AutoPaginatable',
    'List',
    'ListMetadata',
    'ListResponse',
    'PaginationOptions',
    'WorkOSOptions',
    'PostOptions',
    'GetOptions',
  ]) {
    exportedNames.add(name);
  }

  // Identify services whose endpoints are fully covered by existing hand-written
  // classes — their resource class should not be re-exported from the barrel.
  const coveredServicesBarrel = new Set<string>();
  for (const service of spec.services) {
    if (isServiceCoveredByExisting(service, ctx)) {
      coveredServicesBarrel.add(service.name);
    }
  }

  // Track directories that have already been wildcard-exported
  const exportedDirs = new Set<string>();

  // Pre-compute all names per interfaces directory (generated + baseline) to detect
  // cross-directory conflicts before emitting any star exports.  A star export is
  // unsafe when two different directories export the same name (e.g., Factor in
  // both mfa/interfaces and user-management/interfaces).
  const dirAllNames = new Map<string, Set<string>>();
  for (const service of spec.services) {
    const iDir = resolveDir(service.name);
    if (!dirAllNames.has(iDir)) dirAllNames.set(iDir, new Set());
    const names = dirAllNames.get(iDir)!;
    for (const model of spec.models) {
      if (modelToService.get(model.name) !== service.name) continue;
      if (isListMetadataModel(model) || isListWrapperModel(model)) continue;
      names.add(resolveInterfaceName(model.name, ctx));
      names.add(wireInterfaceName(resolveInterfaceName(model.name, ctx)));
    }
  }
  // Add baseline names per directory
  if (ctx.apiSurface?.interfaces) {
    for (const [name, iface] of Object.entries(ctx.apiSurface.interfaces)) {
      const sourceFile = (iface as any).sourceFile as string | undefined;
      if (!sourceFile) continue;
      const match = sourceFile.match(/^src\/([^/]+)\/interfaces\//);
      if (match) {
        const dirName = match[1];
        if (!dirAllNames.has(dirName)) dirAllNames.set(dirName, new Set());
        dirAllNames.get(dirName)!.add(name);
      }
    }
  }
  if (ctx.apiSurface?.typeAliases) {
    for (const [name, alias] of Object.entries(ctx.apiSurface.typeAliases)) {
      const sourceFile = (alias as any).sourceFile as string | undefined;
      if (!sourceFile) continue;
      const match = sourceFile.match(/^src\/([^/]+)\/interfaces\//);
      if (match) {
        const dirName = match[1];
        if (!dirAllNames.has(dirName)) dirAllNames.set(dirName, new Set());
        dirAllNames.get(dirName)!.add(name);
      }
    }
  }
  // Detect directories with cross-directory name conflicts
  const unsafeStarDirs = new Set<string>();
  const allDirEntries = [...dirAllNames.entries()];
  for (let i = 0; i < allDirEntries.length; i++) {
    for (let j = i + 1; j < allDirEntries.length; j++) {
      const [dirA, namesA] = allDirEntries[i];
      const [dirB, namesB] = allDirEntries[j];
      for (const name of namesA) {
        if (namesB.has(name)) {
          unsafeStarDirs.add(dirA);
          unsafeStarDirs.add(dirB);
          break;
        }
      }
    }
  }

  // Per-service exports: service barrel + resource class
  for (const service of spec.services) {
    const resolvedName = resolveResourceClassName(service, ctx);
    const serviceDir = resolveResourceDir(service, ctx);
    // The interfaces directory may differ from the resource class directory when
    // a service's class name is remapped (e.g., WebhooksEndpoints class lives in
    // webhooks-endpoints/ but its model interfaces live in webhooks/).
    const interfacesDir = resolveDir(service.name);

    // Check if this service has any models or enums (i.e., a barrel was generated).
    // Exclude list wrapper and list metadata models — these are skipped during
    // interface generation (they use shared List<T>/ListMetadata), so they don't
    // have corresponding .interface.ts files in the output.
    const serviceModels = spec.models.filter((m) => {
      if (modelToService.get(m.name) !== service.name) return false;
      if (isListMetadataModel(m) || isListWrapperModel(m)) return false;
      return true;
    });
    const serviceEnums = spec.enums.filter((e) => {
      const enumService = enumToService.get(e.name);
      return enumService === service.name;
    });

    // Check whether any model or enum in this service conflicts with names already
    // exported (from earlier star exports or the existing SDK baseline).  If so, fall
    // back to individual named exports to avoid duplicate-export TS2308 errors.
    const hasConflict =
      serviceModels.some((m) => {
        const name = resolveInterfaceName(m.name, ctx);
        return existingSdkExports.has(name) || exportedNames.has(name) || exportedNames.has(wireInterfaceName(name));
      }) || serviceEnums.some((e) => existingSdkExports.has(e.name) || exportedNames.has(e.name));

    // Skip star export for covered services — their directory may have hand-written types
    // (e.g., Factor in mfa/) that conflict with types in the covering service's directory.
    const isCovered = coveredServicesBarrel.has(service.name);
    if (
      (serviceModels.length > 0 || serviceEnums.length > 0) &&
      !exportedDirs.has(interfacesDir) &&
      !hasConflict &&
      !unsafeStarDirs.has(interfacesDir) &&
      !isCovered
    ) {
      exportedDirs.add(interfacesDir);
      lines.push(`export * from './${interfacesDir}/interfaces';`);
      // Track the individual names so they don't get re-exported below
      for (const model of serviceModels) {
        exportedNames.add(resolveInterfaceName(model.name, ctx));
        exportedNames.add(wireInterfaceName(resolveInterfaceName(model.name, ctx)));
      }
      for (const enumDef of serviceEnums) {
        exportedNames.add(enumDef.name);
      }
    } else if (!hasConflict) {
      // Fallback: emit individual model exports (e.g., when no models/enums exist)
      for (const model of serviceModels) {
        const name = resolveInterfaceName(model.name, ctx);
        const wireName = wireInterfaceName(name);
        if (exportedNames.has(name) || exportedNames.has(wireName)) continue;
        if (existingSdkExports.has(name)) continue;
        exportedNames.add(name);
        exportedNames.add(wireName);
        lines.push(
          `export type { ${name}, ${wireName} } from './${interfacesDir}/interfaces/${fileName(model.name)}.interface';`,
        );
      }
    }

    // Resource class — skip if already exported or if service is fully covered
    // by existing hand-written classes
    if (coveredServicesBarrel.has(service.name)) {
      // Emit a comment indicating this service is covered by an existing class
      lines.push(`// ${resolvedName} is covered by an existing hand-written class — not re-exported.`);
    } else if (!exportedNames.has(resolvedName)) {
      exportedNames.add(resolvedName);
      lines.push(`export { ${resolvedName} } from './${serviceDir}/${fileName(resolvedName)}';`);
    }
    lines.push('');
  }

  // Unassigned models (common) — use barrel if any exist
  // Filter to reachable models only: oagen's generateAllFiles passes only
  // service-referenced models to generateModels, so unreachable models
  // never get interface files.  Exporting them here would create broken imports.
  const reachable = computeNonEventReachable(spec.services, spec.models);
  const unassignedModels = spec.models.filter((m) => !modelToService.has(m.name) && reachable.has(m.name));
  const commonEnums = spec.enums.filter((e) => {
    const enumService = enumToService.get(e.name);
    return !enumService;
  });

  const commonHasConflict =
    unassignedModels.some((m) => existingSdkExports.has(resolveInterfaceName(m.name, ctx))) ||
    commonEnums.some((e) => existingSdkExports.has(e.name));

  if ((unassignedModels.length > 0 || commonEnums.length > 0) && !exportedDirs.has('common') && !commonHasConflict) {
    exportedDirs.add('common');
    lines.push("export * from './common/interfaces';");
    for (const model of unassignedModels) {
      exportedNames.add(resolveInterfaceName(model.name, ctx));
      exportedNames.add(wireInterfaceName(resolveInterfaceName(model.name, ctx)));
    }
    for (const enumDef of commonEnums) {
      exportedNames.add(enumDef.name);
    }
  } else {
    // Fallback: individual model exports
    for (const model of unassignedModels) {
      const name = resolveInterfaceName(model.name, ctx);
      const wireName = wireInterfaceName(name);
      if (exportedNames.has(name) || exportedNames.has(wireName)) continue;
      if (existingSdkExports.has(name)) continue;
      exportedNames.add(name);
      exportedNames.add(wireName);
      lines.push(`export type { ${name}, ${wireName} } from './common/interfaces/${fileName(model.name)}.interface';`);
    }
  }

  // Enum exports — only for enums not already covered by a service/common barrel.
  // Skip duplicates and names already covered by existing SDK wildcards.
  // Use value export (`export { ... }`) for actual TS enums so consumers
  // can use them as runtime values (e.g., ConnectionType.GoogleOAuth).
  // Use type-only export (`export type { ... }`) for string literal unions.
  for (const enumDef of spec.enums) {
    if (exportedNames.has(enumDef.name)) continue;
    if (existingSdkExports.has(enumDef.name)) continue;
    exportedNames.add(enumDef.name);
    const enumService = enumToService.get(enumDef.name);
    const dir = resolveDir(enumService);
    if (!exportedDirs.has(dir)) {
      const baselineEnum = ctx.apiSurface?.enums?.[enumDef.name];
      const exportKeyword = baselineEnum?.members ? 'export' : 'export type';
      lines.push(
        `${exportKeyword} { ${enumDef.name} } from './${dir}/interfaces/${fileName(enumDef.name)}.interface';`,
      );
    }
  }

  lines.push('');
  // Only emit the WorkOS re-export for standalone generation (no existing SDK).
  // When integrating into an existing SDK, the existing barrel already exports
  // WorkOS (often as a subclass alias like `export { WorkOSNode as WorkOS }`),
  // and adding a second export with the same name causes a duplicate identifier error.
  if (!ctx.apiSurface && !exportedNames.has('WorkOS')) {
    exportedNames.add('WorkOS');
    lines.push("export { WorkOS } from './workos';");
  }

  return {
    path: 'src/index.ts',
    content: lines.join('\n'),
    skipIfExists: true,
  };
}

/**
 * Determine whether the spec's auth scheme requires overriding the
 * default bearer auth in WorkOSBase.setAuthHeaders().
 */
function needsAuthOverride(auth?: AuthScheme[]): boolean {
  if (!auth || auth.length === 0) return false;
  const scheme = auth[0];
  // bearer and oauth2 match the base class default — no override needed
  return scheme.kind === 'apiKey';
}

/**
 * Render the body of a setAuthHeaders override for non-default auth schemes.
 * Only called when needsAuthOverride() returns true.
 */
function renderAuthOverride(lines: string[], auth: AuthScheme[]): void {
  const scheme = auth[0];
  if (scheme.kind !== 'apiKey') return;
  switch (scheme.in) {
    case 'header':
      lines.push(`    headers['${scheme.name}'] = this.key;`);
      break;
    case 'query':
      lines.push(`    // Auth key sent as query parameter '${scheme.name}' (see buildUrl)`);
      break;
    case 'cookie':
      lines.push(`    headers['Cookie'] = \`${scheme.name}=\${this.key}\`;`);
      break;
  }
}

/**
 * Convert a server description or URL into a SCREAMING_SNAKE_CASE constant name.
 */
function serverConstName(description: string): string {
  return (
    'SERVER_' +
    description
      .replace(/https?:\/\//g, '')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .toUpperCase()
  );
}
