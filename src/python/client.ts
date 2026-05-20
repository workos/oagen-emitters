import type { ApiSpec, EmitterContext, GeneratedFile, Service } from '@workos/oagen';
import { toPascalCase } from '@workos/oagen';
import {
  className,
  resolveServiceDir,
  servicePropertyName,
  buildMountDirMap,
  dirToModule,
  buildExportedClassNameSet,
  resolveServiceTarget,
} from './naming.js';
import { resolveResourceClassName, collectParameterGroupClassNames } from './resources.js';
import { getMountTarget, groupByMount } from '../shared/resolved-ops.js';
import { NON_SPEC_SERVICES } from '../shared/non-spec-services.js';

/** Python-specific wiring for each non-spec service. */
interface PythonNonSpecWiring {
  importLine: string;
  prop: string;
  syncClass: string;
  asyncClass: string | null;
  ctorArg: 'self' | '';
  docstring?: string;
}

const PYTHON_NON_SPEC_WIRING: Record<string, PythonNonSpecWiring> = {
  passwordless: {
    importLine: 'from .passwordless import AsyncPasswordless, Passwordless',
    prop: 'passwordless',
    syncClass: 'Passwordless',
    asyncClass: 'AsyncPasswordless',
    ctorArg: 'self',
    docstring: 'Passwordless authentication sessions.',
  },
  vault: {
    importLine: 'from .vault import AsyncVault, Vault',
    prop: 'vault',
    syncClass: 'Vault',
    asyncClass: 'AsyncVault',
    ctorArg: 'self',
    docstring: 'Vault encryption, key management, and secret storage.',
  },
  actions: {
    importLine: 'from .actions import Actions, AsyncActions',
    prop: 'actions',
    syncClass: 'Actions',
    asyncClass: 'AsyncActions',
    ctorArg: '',
    docstring: 'Actions logging and audit trail.',
  },
  pkce: {
    importLine: 'from .pkce import PKCE',
    prop: 'pkce',
    syncClass: 'PKCE',
    asyncClass: null,
    ctorArg: '',
    docstring: 'PKCE (Proof Key for Code Exchange) utilities.',
  },
};

/**
 * Generate the slim Python client class (service-wiring only),
 * service __init__.py files, and types barrels.
 *
 * Static HTTP infrastructure lives in _base_client.py (hand-maintained
 * in the target SDK, marked @oagen-ignore-file).
 */
export function generateClient(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  assertPublicClientReachability(spec, ctx);

  const files: GeneratedFile[] = [];

  files.push(...generateWorkOSClient(spec, ctx));
  files.push(...generateServiceInits(spec, ctx));
  files.push(...generateTypesBarrels(spec, ctx));

  return files;
}

/**
 * Deduplicate services by mount target. Multiple IR services may mount to the
 * same target (e.g., Applications + ApplicationClientSecrets -> Connect).
 * Returns one representative service per unique mount target, using the service
 * whose PascalCase name matches the target (if any), or the first one found.
 */
function deduplicateByMount(services: Service[], ctx: EmitterContext): Service[] {
  const byTarget = new Map<string, Service>();
  for (const s of services) {
    const target = getMountTarget(s, ctx);
    const existing = byTarget.get(target);
    if (!existing || toPascalCase(s.name) === target) {
      byTarget.set(target, s);
    }
  }
  return [...byTarget.values()];
}

export function buildServiceAccessPaths(services: Service[], ctx: EmitterContext): Map<string, string> {
  const topLevel = deduplicateByMount(services, ctx);
  const paths = new Map<string, string>();

  for (const service of topLevel) {
    const resolvedName = resolveResourceClassName(service, ctx);
    const prop = servicePropertyName(resolvedName);
    paths.set(service.name, prop);
  }

  // Build reverse map: mount target name -> access path
  const targetPaths = new Map<string, string>();
  for (const service of topLevel) {
    const target = getMountTarget(service, ctx);
    if (!targetPaths.has(target) && paths.has(service.name)) {
      targetPaths.set(target, paths.get(service.name)!);
    }
  }

  // Map mounted services to their mount target's access path
  for (const service of services) {
    if (paths.has(service.name)) continue;
    const mountTarget = getMountTarget(service, ctx);
    const targetPath = targetPaths.get(mountTarget) ?? paths.get(mountTarget);
    if (targetPath) paths.set(service.name, targetPath);
  }

  return paths;
}

function assertPublicClientReachability(spec: ApiSpec, ctx: EmitterContext): void {
  const topLevelServices = deduplicateByMount(spec.services, ctx);
  const accessPaths = buildServiceAccessPaths(spec.services, ctx);
  const unreachableServices = topLevelServices
    .filter((service) => service.operations.length > 0 && !accessPaths.has(service.name))
    .map((service) => service.name);

  if (unreachableServices.length > 0) {
    throw new Error(`Python emitter reachability audit failed for services: ${unreachableServices.join(', ')}`);
  }
}

/**
 * Generate the slim _client.py that subclasses the static _base_client.py
 * and wires spec-driven service accessors.
 */
function generateWorkOSClient(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const lines: string[] = [];
  const topLevelServices = deduplicateByMount(spec.services, ctx);

  // --- Imports ---
  lines.push('from __future__ import annotations');
  lines.push('');
  lines.push('import functools');
  lines.push('');
  lines.push('from ._base_client import (');
  lines.push('    WorkOSClient as _SyncBase,');
  lines.push('    AsyncWorkOSClient as _AsyncBase,');
  lines.push(')');

  // Import resource classes (both sync and async)
  const serviceDirMap = buildMountDirMap(ctx);
  const exportedClasses = buildExportedClassNameSet(ctx);
  for (const service of topLevelServices) {
    const resolvedName = resolveResourceClassName(service, ctx);
    const clsName = className(resolveServiceTarget(resolvedName, exportedClasses));
    const dirName = serviceDirMap.get(service.name) ?? resolveServiceDir(resolvedName);
    const importLine = `from .${dirToModule(dirName)}._resource import ${clsName}, Async${clsName}`;
    if (importLine.length > 88) {
      lines.push(`from .${dirToModule(dirName)}._resource import (`);
      lines.push(`    ${clsName},`);
      lines.push(`    Async${clsName},`);
      lines.push(')');
    } else {
      lines.push(importLine);
    }
  }
  // Non-spec service imports — emitted as plain imports (not wrapped in
  // ignore markers). The overwriteWithPreservedRegions() machinery in oagen
  // relocates top-level ignore blocks to EOF because they have no containing
  // class, stripping the markers from the imports while spliceExtraImports()
  // preserves the bare import lines. Emitting them directly avoids the
  // displacement entirely; spliceExtraImports() will preserve any additional
  // hand-added imports from the existing file on subsequent regenerations.
  for (const s of NON_SPEC_SERVICES) {
    const w = PYTHON_NON_SPEC_WIRING[s.id];
    if (w) lines.push(w.importLine);
  }
  lines.push('');
  lines.push('');

  // --- Sync client ---
  lines.push('class WorkOSClient(_SyncBase):');
  lines.push('    """Synchronous WorkOS API client with service accessors."""');

  // Collect all generated property names
  const generatedProps = new Set<string>();
  for (const service of topLevelServices) {
    const resolvedName = resolveResourceClassName(service, ctx);
    const clsName = className(resolveServiceTarget(resolvedName, exportedClasses));
    const prop = servicePropertyName(resolvedName);
    const readable = clsName.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
    lines.push('');
    lines.push('    @functools.cached_property');
    lines.push(`    def ${prop}(self) -> ${clsName}:`);
    lines.push(`        """${readable} API resources."""`);
    lines.push(`        return ${clsName}(self)`);
    generatedProps.add(prop);
  }
  emitCompatClientPropertyAliases(lines, generatedProps, false);
  emitNonSpecClientAccessors(lines, false);

  lines.push('');
  lines.push('');

  // --- Async client ---
  lines.push('class AsyncWorkOSClient(_AsyncBase):');
  lines.push('    """Asynchronous WorkOS API client with service accessors."""');

  const asyncGeneratedProps = new Set<string>();
  for (const service of topLevelServices) {
    const resolvedName = resolveResourceClassName(service, ctx);
    const clsName = className(resolveServiceTarget(resolvedName, exportedClasses));
    const prop = servicePropertyName(resolvedName);
    const readable = clsName.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
    lines.push('');
    lines.push('    @functools.cached_property');
    lines.push(`    def ${prop}(self) -> Async${clsName}:`);
    lines.push(`        """${readable} API resources."""`);
    lines.push(`        return Async${clsName}(self)`);
    asyncGeneratedProps.add(prop);
  }
  emitCompatClientPropertyAliases(lines, asyncGeneratedProps, true);
  emitNonSpecClientAccessors(lines, true);

  return [
    {
      path: `src/${ctx.namespace}/_client.py`,
      content: lines.join('\n'),
      overwriteExisting: true,
    },
  ];
}

function emitNonSpecClientAccessors(lines: string[], isAsync: boolean): void {
  lines.push('');
  lines.push('    # @oagen-ignore-start — non-spec service accessors (hand-maintained)');
  for (const s of NON_SPEC_SERVICES) {
    const w = PYTHON_NON_SPEC_WIRING[s.id];
    if (!w) continue;
    const typeName = isAsync ? (w.asyncClass ?? w.syncClass) : w.syncClass;
    const arg = w.ctorArg === 'self' ? 'self' : '';

    lines.push('');
    lines.push('    @functools.cached_property');
    lines.push(`    def ${w.prop}(self) -> ${typeName}:`);
    if (w.docstring) {
      lines.push(`        """${w.docstring}"""`);
    }
    lines.push(`        return ${typeName}(${arg})`);
  }
  lines.push('');
  lines.push('    # @oagen-ignore-end');
}

function generateServiceInits(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const topLevel = deduplicateByMount(spec.services, ctx);
  const serviceDirMap = buildMountDirMap(ctx);
  const exportedClasses = buildExportedClassNameSet(ctx);

  // Build a map from mount target -> operations so we can discover parameter
  // group dataclasses that need re-exporting from __init__.py.
  const mountGroups = groupByMount(ctx);

  for (const service of topLevel) {
    const resolvedName = resolveResourceClassName(service, ctx);
    const clsName = className(resolveServiceTarget(resolvedName, exportedClasses));
    const dirName = serviceDirMap.get(service.name) ?? resolveServiceDir(resolvedName);
    const lines: string[] = [];

    // Collect parameter group class names from all operations in this mount group
    const mountTarget = getMountTarget(service, ctx);
    const ops = mountGroups.get(mountTarget)?.operations ?? service.operations;
    const groupClassNames = collectParameterGroupClassNames(ops);

    // Use `X as X` re-export form (PEP 484) so pyright recognizes these as
    // public re-exports. Otherwise consumers importing
    // `from workos.user_management import RoleSingle` get a private-import
    // warning under strict mode. Models barrel uses the same convention.
    const resourceImports = [clsName, `Async${clsName}`, ...groupClassNames];
    const aliasedImports = resourceImports.map((n) => `${n} as ${n}`);
    lines.push(`from ._resource import ${aliasedImports.join(', ')}`);
    lines.push('from .models import *');

    files.push({
      path: `src/${ctx.namespace}/${dirName}/__init__.py`,
      content: lines.join('\n'),
      integrateTarget: true,
      overwriteExisting: true,
    });

    // models/__init__.py is emitted unconditionally by `models.ts` — including
    // an empty barrel for services with no models — so we don't need a safety
    // net here. (A `skipIfExists` safety net previously caused stale imports
    // to survive when the underlying module was pruned.)
  }

  return files;
}

function emitCompatClientPropertyAliases(lines: string[], generatedProps: Set<string>, isAsync: boolean): void {
  const aliases: Array<{ alias: string; typeName: string; returnExpr: string; docstring: string }> = [];
  if (generatedProps.has('multi_factor_auth') && !generatedProps.has('mfa')) {
    const mfaType = isAsync ? 'AsyncMultiFactorAuth' : 'MultiFactorAuth';
    aliases.push({
      alias: 'mfa',
      typeName: mfaType,
      returnExpr: 'self.multi_factor_auth',
      docstring: '"""Alias for multi_factor_auth."""',
    });
  }
  for (const alias of aliases) {
    lines.push('');
    lines.push('    @functools.cached_property');
    lines.push(`    def ${alias.alias}(self) -> ${alias.typeName}:`);
    lines.push(`        ${alias.docstring}`);
    lines.push(`        return ${alias.returnExpr}`);
  }
}

/**
 * Generate types/<service>/__init__.py re-export barrels so that
 * `from workos.types.<service> import Model` continues to work.
 */
function generateTypesBarrels(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const serviceDirMap = buildMountDirMap(ctx);

  // Collect (types dir name -> set of service dirs whose models should be re-exported)
  const typesEntries = new Map<string, Set<string>>();

  for (const service of spec.services) {
    const resolvedName = resolveResourceClassName(service, ctx);
    const prop = servicePropertyName(resolvedName);
    const dir = serviceDirMap.get(service.name) ?? prop;
    const dirs = typesEntries.get(prop) ?? new Set();
    dirs.add(dir);
    typesEntries.set(prop, dirs);
  }

  for (const [typesDir, serviceDirs] of typesEntries) {
    const imports = [...serviceDirs]
      .sort()
      .map((dir) => `from ${ctx.namespace}.${dirToModule(dir)}.models import *  # noqa: F401,F403`);

    files.push({
      path: `src/${ctx.namespace}/types/${typesDir}/__init__.py`,
      content: imports.join('\n'),
      integrateTarget: true,
      overwriteExisting: true,
    });
  }

  // Root types/__init__.py
  files.push({
    path: `src/${ctx.namespace}/types/__init__.py`,
    content: '',
    integrateTarget: true,
    overwriteExisting: true,
  });

  return files;
}
