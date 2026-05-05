import type { Model, EmitterContext, Service, Operation, TypeRef } from '@workos/oagen';
import { toPascalCase } from '@workos/oagen';
export {
  collectModelRefs,
  collectEnumRefs,
  assignModelsToServices,
  collectFieldDependencies,
  collectRequestBodyModels,
} from '@workos/oagen';
import { mapTypeRef } from './type-map.js';
import {
  resolveInterfaceName,
  fieldName,
  resolveServiceDir,
  resolveMethodName,
  buildServiceNameMap,
} from './naming.js';
import { getMountTarget } from '../shared/resolved-ops.js';
import { assignModelsToServices } from '@workos/oagen';

/**
 * Compute a relative import path between two files within the generated SDK.
 */
export function relativeImport(fromFile: string, toFile: string): string {
  const fromDir = fromFile.split('/').slice(0, -1);
  const toFileParts = toFile.split('/');
  const toDir = toFileParts.slice(0, -1);
  const toFileName = toFileParts[toFileParts.length - 1];

  let common = 0;
  while (common < fromDir.length && common < toDir.length && fromDir[common] === toDir[common]) {
    common++;
  }

  const ups = fromDir.length - common;
  const downs = toDir.slice(common);
  const parts = [...Array(ups).fill('..'), ...downs, toFileName];
  let result = parts.join('/');
  result = result.replace(/\.ts$/, '');
  if (!result.startsWith('.')) result = './' + result;
  return result;
}

/**
 * Render a JSDoc comment block from a description string.
 */
export function docComment(description: string, indent = 0): string[] {
  const pad = ' '.repeat(indent);
  const descLines = description.split('\n');
  if (descLines.length === 1) {
    return [`${pad}/** ${descLines[0]} */`];
  }
  const lines: string[] = [`${pad}/**`];
  for (const line of descLines) {
    lines.push(line === '' ? `${pad} *` : `${pad} * ${line}`);
  }
  lines.push(`${pad} */`);
  return lines;
}

/**
 * Build a map from model name -> default type args string for generic models.
 */
export function buildGenericModelDefaults(models: Model[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const model of models) {
    if (!model.typeParams?.length) continue;
    const defaults = model.typeParams.map((tp) => (tp.default ? mapTypeRef(tp.default) : 'unknown'));
    result.set(model.name, `<${defaults.join(', ')}>`);
  }
  return result;
}

/**
 * Remove unused imports from generated source code.
 */
export function pruneUnusedImports(lines: string[]): string[] {
  const importLines: string[] = [];
  const bodyLines: string[] = [];
  let inBody = false;
  for (const line of lines) {
    if (!inBody && (line.startsWith('import ') || line === '')) {
      importLines.push(line);
    } else {
      inBody = true;
      bodyLines.push(line);
    }
  }

  const body = bodyLines.join('\n');
  const kept: string[] = [];

  for (const line of importLines) {
    if (line === '') {
      kept.push(line);
      continue;
    }
    const match = line.match(/\{([^}]+)\}/);
    if (!match) {
      kept.push(line);
      continue;
    }
    const names = match[1]
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean);
    const usedNames = names.filter((name) => {
      const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      return re.test(body);
    });
    if (usedNames.length === 0) continue;
    if (usedNames.length === names.length) {
      kept.push(line);
    } else {
      const isTypeImport = line.startsWith('import type');
      const fromMatch = line.match(/from\s+['"]([^'"]+)['"]/);
      if (fromMatch) {
        const prefix = isTypeImport ? 'import type' : 'import';
        kept.push(`${prefix} { ${usedNames.join(', ')} } from '${fromMatch[1]}';`);
      } else {
        kept.push(line);
      }
    }
  }

  return [...kept, ...bodyLines];
}

/** Built-in TypeScript types that are always available. */
export const TS_BUILTINS = new Set([
  'Record',
  'Promise',
  'Array',
  'Map',
  'Set',
  'Date',
  'string',
  'number',
  'boolean',
  'void',
  'null',
  'undefined',
  'any',
  'never',
  'unknown',
  'true',
  'false',
]);

/**
 * Detect whether the existing SDK uses string representation for date-time fields.
 */
export function detectStringDateConvention(models: Model[], ctx: EmitterContext): boolean {
  if (!ctx.apiSurface?.interfaces) return false;
  for (const model of models) {
    const domainName = resolveInterfaceName(model.name, ctx);
    const baseline = ctx.apiSurface.interfaces[domainName];
    if (!baseline?.fields) continue;
    for (const field of model.fields) {
      if (field.type.kind !== 'primitive' || field.type.format !== 'date-time') continue;
      const baselineField = baseline.fields[fieldName(field.name)];
      if (baselineField && !baselineField.type.includes('Date')) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Build a comprehensive set of all known type names from the IR and baseline.
 */
export function buildKnownTypeNames(models: Model[], ctx: EmitterContext): Set<string> {
  const knownNames = new Set<string>();
  for (const m of models) knownNames.add(resolveInterfaceName(m.name, ctx));
  for (const e of ctx.spec.enums) knownNames.add(e.name);
  if (ctx.apiSurface?.interfaces) {
    for (const name of Object.keys(ctx.apiSurface.interfaces)) knownNames.add(name);
  }
  if (ctx.apiSurface?.typeAliases) {
    for (const name of Object.keys(ctx.apiSurface.typeAliases)) knownNames.add(name);
  }
  if (ctx.apiSurface?.enums) {
    for (const name of Object.keys(ctx.apiSurface.enums)) knownNames.add(name);
  }
  return knownNames;
}

/**
 * Create a service directory resolver bundle.
 *
 * When `ctx.apiSurface` is populated, the baseline `sourceFile` of an
 * existing interface wins over the IR-derived first-reference assignment.
 * This keeps generated imports pointing at the existing live SDK location
 * instead of duplicating a model into a different service directory.
 */
export function createServiceDirResolver(
  models: Model[],
  services: Service[],
  ctx: EmitterContext,
): {
  modelToService: Map<string, string>;
  serviceNameMap: Map<string, string>;
  resolveDir: (irService: string | undefined) => string;
} {
  const modelToService = assignModelsToServices(models, services);
  const serviceNameMap = buildServiceNameMap(services, ctx);

  // Per-name → directory override, harvested from the live SDK surface.
  // Stored under a sentinel "" service key in modelToService so resolveDir
  // can dispatch on it without a separate map. Implementation: model name ->
  // baseline directory string (e.g., "user-management"). The override map is
  // attached by tagging the model name with a directory prefix that bypasses
  // the IR-service lookup. Concretely we keep a side map.
  const baselineDirByModel = new Map<string, string>();
  const recordSource = (name: string, info: { sourceFile?: string } | undefined) => {
    const sourceFile = info?.sourceFile;
    if (!sourceFile) return;
    const m = sourceFile.match(/^src\/([^/]+)\//);
    if (!m) return;
    baselineDirByModel.set(name, m[1]);
  };
  // Both interfaces and type aliases can shadow IR model names — e.g.
  // `type Role = EnvironmentRole | OrganizationRole;` is the live SDK's
  // canonical Role definition even though the IR represents Role as a model.
  for (const [name, info] of Object.entries(ctx.apiSurface?.interfaces ?? {})) {
    recordSource(name, info as { sourceFile?: string });
  }
  for (const [name, info] of Object.entries(ctx.apiSurface?.typeAliases ?? {})) {
    if (!baselineDirByModel.has(name)) {
      recordSource(name, info as { sourceFile?: string });
    }
  }

  // Override modelToService for any IR model that has a baseline sourceFile.
  // We invent a synthetic IR-service key that maps directly to the baseline
  // directory via serviceNameMap so resolveDir returns the correct dir.
  for (const [modelName] of modelToService) {
    const dir = baselineDirByModel.get(modelName);
    if (!dir) continue;
    const synthetic = `__baseline_dir__:${dir}`;
    modelToService.set(modelName, synthetic);
    if (!serviceNameMap.has(synthetic)) {
      // resolveServiceDir is identity on already-kebab-case names, so storing
      // the dir directly keeps round-tripping through the resolver clean.
      serviceNameMap.set(synthetic, dir);
    }
  }

  const resolveDir = (irService: string | undefined) => {
    if (!irService) return 'common';
    if (irService.startsWith('__baseline_dir__:')) return irService.slice('__baseline_dir__:'.length);
    return resolveServiceDir(serviceNameMap.get(irService) ?? irService);
  };
  return { modelToService, serviceNameMap, resolveDir };
}

/**
 * Check if baseline interface fields appear to contain generic type parameters.
 *
 * Heuristic: strip string literals first (so `'GoogleSAML'` is not mistaken
 * for a type name), then look for any PascalCase token that isn't a known
 * type — those indicate an unbound generic parameter like `TCustomAttributes`.
 */
export function isBaselineGeneric(fields: Record<string, unknown>, knownNames: Set<string>): boolean {
  for (const [, bf] of Object.entries(fields)) {
    const rawType = (bf as { type: string }).type;
    const stripped = rawType.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '');
    const typeNames = stripped.match(/\b[A-Z][a-zA-Z0-9]*\b/g);
    if (!typeNames) continue;
    for (const tn of typeNames) {
      if (TS_BUILTINS.has(tn)) continue;
      if (knownNames.has(tn)) continue;
      return true;
    }
  }
  return false;
}

export { isListMetadataModel, isListWrapperModel } from '../shared/model-utils.js';

function modelFingerprint(model: Model): string {
  const fields = model.fields.map((f) => `${f.name}:${JSON.stringify(f.type)}:${f.required}`).sort();
  return fields.join('|');
}

/**
 * Find structurally identical models and build a deduplication map.
 */
export function buildDeduplicationMap(
  models: Model[],
  ctx?: EmitterContext,
  reachable?: Set<string>,
): Map<string, string> {
  const dedup = new Map<string, string>();

  // Pass 1: structural fingerprint dedup
  const fingerprints = new Map<string, string>();
  for (const model of models) {
    if (model.fields.length === 0) continue;
    const fp = modelFingerprint(model);
    const existing = fingerprints.get(fp);
    if (existing) {
      if (reachable && !reachable.has(existing) && reachable.has(model.name)) {
        dedup.delete(existing);
        dedup.set(existing, model.name);
        fingerprints.set(fp, model.name);
      } else {
        dedup.set(model.name, existing);
      }
    } else {
      fingerprints.set(fp, model.name);
    }
  }

  // Pass 2: name-based dedup
  if (ctx) {
    const byDomainName = new Map<string, Model[]>();
    for (const model of models) {
      if (model.fields.length === 0) continue;
      if (dedup.has(model.name)) continue;
      const domainName = resolveInterfaceName(model.name, ctx);
      const group = byDomainName.get(domainName);
      if (group) {
        group.push(model);
      } else {
        byDomainName.set(domainName, [model]);
      }
    }
    for (const [, group] of byDomainName) {
      if (group.length < 2) continue;
      group.sort((a, b) => {
        if (reachable) {
          const aReach = reachable.has(a.name) ? 0 : 1;
          const bReach = reachable.has(b.name) ? 0 : 1;
          if (aReach !== bReach) return aReach - bReach;
        }
        return b.fields.length - a.fields.length || a.name.localeCompare(b.name);
      });
      const canonical = group[0];
      for (let i = 1; i < group.length; i++) {
        dedup.set(group[i].name, canonical.name);
      }
    }
  }

  return dedup;
}

/**
 * Check whether a service's endpoints are already fully covered by existing
 * hand-written service classes.
 */
export function isServiceCoveredByExisting(service: Service, ctx: EmitterContext): boolean {
  const mountTarget = getMountTarget(service, ctx);
  if (mountTarget !== toPascalCase(service.name)) return true;

  const overlay = ctx.overlayLookup?.methodByOperation;
  if (!overlay || overlay.size === 0) return false;
  if (service.operations.length === 0) return false;

  const baselineClasses = ctx.apiSurface?.classes;
  if (!baselineClasses) return false;
  const existingClassNames = new Set(Object.keys(baselineClasses));

  return service.operations.every((op: Operation) => {
    const httpKey = `${op.httpMethod.toUpperCase()} ${op.path}`;
    const match = overlay.get(httpKey);
    if (!match) return false;
    return existingClassNames.has(match.className);
  });
}

/**
 * Check whether a fully-covered service has operations whose overlay-mapped
 * methods are missing from the baseline class.
 */
export function hasMethodsAbsentFromBaseline(service: Service, ctx: EmitterContext): boolean {
  const baselineClasses = ctx.apiSurface?.classes;
  if (!baselineClasses) return false;

  const mountTarget = getMountTarget(service, ctx);
  if (mountTarget !== toPascalCase(service.name)) {
    const cls = baselineClasses[mountTarget];
    if (!cls) return true;
    for (const op of service.operations) {
      const method = resolveMethodName(op, service, ctx);
      if (!cls.methods?.[method]) return true;
    }
    return false;
  }

  const overlay = ctx.overlayLookup?.methodByOperation;
  if (!overlay) return false;

  for (const op of service.operations) {
    const httpKey = `${op.httpMethod.toUpperCase()} ${op.path}`;
    const match = overlay.get(httpKey);
    if (!match) continue;
    const cls = baselineClasses[match.className];
    if (!cls) continue;
    if (!cls.methods?.[match.methodName]) return true;
  }
  return false;
}

/**
 * Check whether an IR model has fields not present in the baseline interface.
 *
 * When the live SDK exposes the same name as a type alias (e.g.
 * `type Role = EnvironmentRole | OrganizationRole;`), treat it as already
 * fully covered — generating an interface against an existing alias would
 * collide. The alias's referenced types still get generated independently
 * and serve as the canonical implementation.
 */
export function modelHasNewFields(model: Model, ctx: EmitterContext): boolean {
  if (!ctx.apiSurface?.interfaces && !ctx.apiSurface?.typeAliases) return true;

  const domainName = resolveInterfaceName(model.name, ctx);

  if (ctx.apiSurface?.typeAliases?.[domainName]) {
    return false;
  }

  const baseline = ctx.apiSurface?.interfaces?.[domainName];
  if (!baseline?.fields) return true;

  for (const field of model.fields) {
    const camelName = fieldName(field.name);
    if (!baseline.fields[camelName]) return true;
  }

  return false;
}

/**
 * Return operations in a service that are NOT covered by existing hand-written
 * service classes.
 */
export function uncoveredOperations(service: Service, ctx: EmitterContext): Operation[] {
  const overlay = ctx.overlayLookup?.methodByOperation;
  if (!overlay || overlay.size === 0) return service.operations;

  const baselineClasses = ctx.apiSurface?.classes;
  if (!baselineClasses) return service.operations;
  const existingClassNames = new Set(Object.keys(baselineClasses));

  return service.operations.filter((op: Operation) => {
    const httpKey = `${op.httpMethod.toUpperCase()} ${op.path}`;
    const match = overlay.get(httpKey);
    if (!match) return true;
    return !existingClassNames.has(match.className);
  });
}

/**
 * Compute the set of model names reachable from non-event service operations.
 */
export function computeNonEventReachable(services: Service[], models: Model[]): Set<string> {
  const seeds = new Set<string>();
  for (const svc of services) {
    if (svc.name.toLowerCase() === 'events') continue;
    for (const op of svc.operations) {
      const collectFromRef = (t: TypeRef | undefined): void => {
        if (!t) return;
        if (t.kind === 'model') seeds.add(t.name);
        if (t.kind === 'array') collectFromRef(t.items);
        if (t.kind === 'nullable') collectFromRef(t.inner);
        if (t.kind === 'union') t.variants.forEach(collectFromRef);
      };
      collectFromRef(op.response);
      collectFromRef(op.requestBody);
      if (op.pagination?.itemType) collectFromRef(op.pagination.itemType);
    }
  }
  const modelMap = new Map(models.map((m) => [m.name, m]));
  const reachable = new Set<string>();
  const queue = [...seeds];
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (reachable.has(name)) continue;
    reachable.add(name);
    const m = modelMap.get(name);
    if (!m) continue;
    for (const field of m.fields) {
      const walk = (t: TypeRef): void => {
        if (t.kind === 'model' && !reachable.has(t.name)) queue.push(t.name);
        if (t.kind === 'array') walk(t.items);
        if (t.kind === 'nullable') walk(t.inner);
        if (t.kind === 'union') t.variants.forEach(walk);
      };
      walk(field.type);
    }
  }
  return reachable;
}
