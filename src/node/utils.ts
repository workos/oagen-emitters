import type { Model, EmitterContext, Service, Operation, Field } from '@workos/oagen';
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
    irService ? resolveServiceDir(serviceNameMap.get(irService) ?? irService) : 'common';
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

/**
 * Detect whether a model matches the standard list-metadata shape:
 * exactly 2 fields named `before` and `after`, both nullable string.
 *
 * These models are redundant because the SDK already has a shared
 * `ListMetadata` type in `src/common/utils/pagination.ts`.
 */
export function isListMetadataModel(model: Model): boolean {
  if (model.fields.length !== 2) return false;

  const fieldsByName = new Map(model.fields.map((f) => [f.name, f]));
  const before = fieldsByName.get('before');
  const after = fieldsByName.get('after');

  if (!before || !after) return false;

  return isNullableString(before) && isNullableString(after);
}

/**
 * Detect whether a model is a list wrapper — the standard paginated
 * list envelope with `data` (array), `list_metadata`, and `object: 'list'`.
 *
 * These models are redundant because the SDK already has `List<T>` and
 * `ListResponse<T>` in `src/common/utils/pagination.ts`, and the shared
 * `deserializeList` handles deserialization.
 */
export function isListWrapperModel(model: Model): boolean {
  const fieldsByName = new Map(model.fields.map((f) => [f.name, f]));

  // Must have a `data` field that is an array type
  const dataField = fieldsByName.get('data');
  if (!dataField) return false;
  if (dataField.type.kind !== 'array') return false;

  // Must have a `list_metadata` field (the IR uses snake_case names)
  const listMetadataField = fieldsByName.get('list_metadata');
  if (!listMetadataField) return false;

  // Optionally has an `object` field with literal value 'list'
  const objectField = fieldsByName.get('object');
  if (objectField) {
    if (objectField.type.kind !== 'literal' || objectField.type.value !== 'list') {
      return false;
    }
  }

  return true;
}

/** Check if a field type is nullable string (nullable<string> or just string). */
function isNullableString(field: Field): boolean {
  const { type } = field;
  if (type.kind === 'nullable') {
    return type.inner.kind === 'primitive' && type.inner.type === 'string';
  }
  if (type.kind === 'primitive') {
    return type.type === 'string';
  }
  return false;
}

/**
 * Compute a structural fingerprint for a model based on its fields.
 * Two models with identical fingerprints are structurally equivalent.
 */
function modelFingerprint(model: Model): string {
  const fields = model.fields.map((f) => `${f.name}:${JSON.stringify(f.type)}:${f.required}`).sort();
  return fields.join('|');
}

/**
 * Find structurally identical models and build a deduplication map.
 * Also deduplicates models that resolve to the same interface name across
 * services — when a `$ref` schema is used by multiple tags, the IR may
 * produce per-tag copies that diverge slightly.  The version with the most
 * fields is chosen as canonical.
 *
 * Returns a Map from duplicate model name → canonical model name.
 */
export function buildDeduplicationMap(models: Model[], ctx?: EmitterContext): Map<string, string> {
  const dedup = new Map<string, string>();

  // Pass 1: structural fingerprint dedup (exact match)
  const fingerprints = new Map<string, string>();
  for (const model of models) {
    if (model.fields.length === 0) continue;
    const fp = modelFingerprint(model);
    const existing = fingerprints.get(fp);
    if (existing) {
      dedup.set(model.name, existing);
    } else {
      fingerprints.set(fp, model.name);
    }
  }

  // Pass 2: name-based dedup for models that resolve to the same interface
  // name across services.  Only applies when context with name resolution is
  // available.  Picks the model with the most fields as canonical.
  if (ctx) {
    const byDomainName = new Map<string, Model[]>();
    for (const model of models) {
      if (model.fields.length === 0) continue;
      if (dedup.has(model.name)) continue; // already deduped in pass 1
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
      // Choose canonical: most fields, then alphabetically by name
      group.sort((a, b) => b.fields.length - a.fields.length || a.name.localeCompare(b.name));
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
 *
 * A service is considered "covered" when:
 * 1. **Every** operation in it appears in `overlayLookup.methodByOperation`
 * 2. The overlay maps those operations to a class that exists in the baseline
 *    `apiSurface` (confirming the hand-written class is actually present)
 *
 * Services with zero operations are never considered covered (nothing to
 * deduplicate).  When no `apiSurface` is available, the overlay alone is
 * used as the coverage signal (the overlay is only built from existing code).
 *
 * This prevents the emitter from generating resource classes like `Connections`
 * that would duplicate hand-written modules like `SSO` for the same API
 * endpoints (e.g., `GET /connections`).
 */
export function isServiceCoveredByExisting(service: Service, ctx: EmitterContext): boolean {
  // A service is "covered" when its mountOn differs from its own name,
  // meaning its operations are mounted on a different (existing) class.
  const mountTarget = getMountTarget(service, ctx);
  if (mountTarget !== toPascalCase(service.name)) return true;

  const overlay = ctx.overlayLookup?.methodByOperation;
  if (!overlay || overlay.size === 0) return false;
  if (service.operations.length === 0) return false;

  // Collect the set of existing class names from the baseline surface.
  // When no apiSurface is available, the overlay alone cannot confirm that
  // a hand-written class exists — it may only carry naming hints.
  const baselineClasses = ctx.apiSurface?.classes;
  if (!baselineClasses) return false;
  const existingClassNames = new Set(Object.keys(baselineClasses));

  // Check that every operation is in the overlay AND the overlay's target class
  // exists in the baseline.
  return service.operations.every((op: Operation) => {
    const httpKey = `${op.httpMethod.toUpperCase()} ${op.path}`;
    const match = overlay.get(httpKey);
    if (!match) return false;
    return existingClassNames.has(match.className);
  });
}

/**
 * Check whether a fully-covered service has operations whose overlay-mapped
 * methods are missing from the baseline class.  Returns true when at least
 * one operation maps to a method name that the baseline class does not have,
 * meaning the merger needs to add new methods (skipIfExists must be removed).
 */
export function hasMethodsAbsentFromBaseline(service: Service, ctx: EmitterContext): boolean {
  const baselineClasses = ctx.apiSurface?.classes;
  if (!baselineClasses) return false;

  // When a service mounts on a different class (via mount rules), check
  // each operation's resolved method name against the target class directly.
  const mountTarget = getMountTarget(service, ctx);
  if (mountTarget !== toPascalCase(service.name)) {
    const cls = baselineClasses[mountTarget];
    if (!cls) return true; // Target class missing from baseline — treat as absent
    for (const op of service.operations) {
      const method = resolveMethodName(op, service, ctx);
      if (!cls.methods?.[method]) return true;
    }
    return false;
  }

  // Default overlay-based detection
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
 * Return operations in a service that are NOT covered by existing hand-written
 * service classes. For fully uncovered services, returns all operations.
 * For partially covered services, returns only the uncovered operations.
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
    if (!match) return true; // Not in overlay → uncovered
    return !existingClassNames.has(match.className); // Class doesn't exist → uncovered
  });
}
