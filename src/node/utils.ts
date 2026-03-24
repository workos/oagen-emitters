import type { Model, EmitterContext, Service } from '@workos/oagen';
export {
  collectModelRefs,
  collectEnumRefs,
  assignModelsToServices,
  collectFieldDependencies,
  collectRequestBodyModels,
} from '@workos/oagen';
import { mapTypeRef } from './type-map.js';
import { resolveInterfaceName, fieldName, serviceDirName, buildServiceNameMap } from './naming.js';
import { assignModelsToServices } from '@workos/oagen';

/**
 * Compute a relative import path between two files within the generated SDK.
 * Strips .ts extension from the result.
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
 * Handles multiline descriptions by prefixing each line with ` * `.
 * Returns the lines with the given indent (default 0 spaces).
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
 * Build a map from model name → default type args string for generic models.
 * E.g., Profile<CustomAttributesType = Record<string, unknown>>
 *   → Map { 'Profile' → '<Record<string, unknown>>' }
 *
 * Non-generic models are not included in the map.
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
 * Scans the non-import body for each imported identifier and drops
 * individual names that are never referenced.  Removes entire import
 * statements when no names are used.
 */
export function pruneUnusedImports(lines: string[]): string[] {
  // Split lines into imports and body
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
    // Extract imported names from the import statement
    const match = line.match(/\{([^}]+)\}/);
    if (!match) {
      // Non-destructured import (e.g., import X from '...') — keep
      kept.push(line);
      continue;
    }
    const names = match[1]
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean);
    // Filter to only names that appear in the body
    const usedNames = names.filter((name) => {
      const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      return re.test(body);
    });
    if (usedNames.length === 0) {
      // No names used — drop entire import
      continue;
    }
    if (usedNames.length === names.length) {
      // All names used — keep original line
      kept.push(line);
    } else {
      // Some names unused — reconstruct import with only used names
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

/** Built-in TypeScript types that are always available (no import needed). */
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
 * Detect whether the existing SDK uses string (ISO 8601) representation for
 * date-time fields.  Checks if any baseline interface has a date-time IR field
 * typed as plain `string` (not `Date`).
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
 * Used to identify type parameters by elimination — any PascalCase name not in
 * this set is likely a generic type parameter.
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
 * Encapsulates the common pattern of mapping models to services and resolving
 * the output directory for a given IR service name.
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
  const resolveDir = (irService: string | undefined) =>
    irService ? serviceDirName(serviceNameMap.get(irService) ?? irService) : 'common';
  return { modelToService, serviceNameMap, resolveDir };
}

/**
 * Check if a set of baseline interface fields appears to contain generic type
 * parameters — PascalCase names that aren't known models, enums, or builtins.
 */
export function isBaselineGeneric(fields: Record<string, unknown>, knownNames: Set<string>): boolean {
  for (const [, bf] of Object.entries(fields)) {
    const fieldType = (bf as { type: string }).type;
    const typeNames = fieldType.match(/\b[A-Z][a-zA-Z0-9]*\b/g);
    if (!typeNames) continue;
    for (const tn of typeNames) {
      if (TS_BUILTINS.has(tn)) continue;
      if (knownNames.has(tn)) continue;
      return true;
    }
  }
  return false;
}
