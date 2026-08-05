import type { EmitterContext, GeneratedFile, Model, Enum, TypeRef, Operation } from '@workos/oagen';
import { toSnakeCase, planOperation } from '@workos/oagen';
import { functionName } from './naming.js';
import { scopedMountGroups } from '../shared/resolved-ops.js';
import { getSyntheticEnums, resolvePaginationItemType } from '../shared/model-utils.js';

const MAX_DEPTH = 4;

export interface FixtureEntry {
  /** Fixture name relative to the fixtures dir, without extension (e.g. "organizations/list"). */
  name: string;
  data: unknown;
}

/** Fixture name for an operation on a mount target. */
export function fixtureName(mountOn: string, methodName: string): string {
  return `${toSnakeCase(mountOn)}/${methodName}`;
}

/**
 * Build deterministic response-sample fixtures for every operation that returns
 * a JSON-shaped response. Returns a map from fixture name to sample data; ops
 * without an entry have no fixture (tests stub an empty 204 instead).
 */
export function buildFixtureEntries(ctx: EmitterContext): Map<string, unknown> {
  const models = new Map(ctx.spec.models.map((m) => [m.name, m]));
  const enums = new Map([...ctx.spec.enums, ...getSyntheticEnums()].map((e) => [e.name, e]));
  const entries = new Map<string, unknown>();

  for (const group of scopedMountGroups(ctx).values()) {
    const seen = new Set<string>();
    for (const resolved of group.resolvedOps) {
      if (!(resolved as { urlBuilder?: boolean }).urlBuilder) {
        const methodName = functionName(resolved.methodName);
        if (!seen.has(methodName)) {
          seen.add(methodName);
          const sample = responseSample(resolved.operation, models, enums);
          if (sample !== undefined) entries.set(fixtureName(group.name, methodName), sample);
        }
      }
      for (const wrapper of resolved.wrappers ?? []) {
        const wname = functionName(wrapper.name);
        if (seen.has(wname)) continue;
        seen.add(wname);
        const ref: TypeRef =
          wrapper.responseModelName && models.has(wrapper.responseModelName)
            ? { kind: 'model', name: wrapper.responseModelName }
            : resolved.operation.response;
        if (!isJsonShaped(ref)) continue;
        entries.set(fixtureName(group.name, wname), sampleForType(ref, models, enums, 'response', 0, new Set()));
      }
    }
  }
  return entries;
}

/** Render fixture entries as JSON files under test/support/fixtures/. */
export function generateFixtureFiles(ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  for (const [name, data] of buildFixtureEntries(ctx)) {
    files.push({
      path: `test/support/fixtures/${name}.json`,
      content: `${JSON.stringify(data, null, 2)}\n`,
      headerPlacement: 'skip',
      integrateTarget: true,
      overwriteExisting: true,
    });
  }
  return files;
}

/** Sample response body for an operation, or undefined when no fixture applies. */
export function responseSample(
  op: Operation,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
): unknown | undefined {
  const plan = planOperation(op);
  if (plan.isPaginated && op.pagination) {
    // The fixture must mirror the wire: `data` holds elements, not envelopes.
    const itemType = resolvePaginationItemType(op.pagination.itemType, models);
    const item = sampleForType(itemType, models, enums, 'item', 0, new Set());
    return {
      [op.pagination.dataPath ?? 'data']: [item],
      list_metadata: { before: null, after: null },
    };
  }
  if (isJsonShaped(op.response)) {
    return sampleForType(op.response, models, enums, 'response', 0, new Set());
  }
  return undefined;
}

function isJsonShaped(ref: TypeRef): boolean {
  switch (ref.kind) {
    case 'model':
    case 'map':
    case 'union':
      return true;
    case 'array':
      return true;
    case 'nullable':
      return isJsonShaped(ref.inner);
    default:
      return false;
  }
}

export function sampleForType(
  ref: TypeRef,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  fieldName: string,
  depth: number,
  visited: Set<string>,
): unknown {
  switch (ref.kind) {
    case 'primitive':
      return samplePrimitive(ref.type, ref.format, fieldName);
    case 'literal':
      return ref.value;
    case 'nullable':
      return sampleForType(ref.inner, models, enums, fieldName, depth, visited);
    case 'array':
      if (depth >= MAX_DEPTH) return [];
      return [sampleForType(ref.items, models, enums, fieldName, depth + 1, visited)];
    case 'map':
      return {};
    case 'enum': {
      const enumDef = enums.get(ref.name);
      const first = enumDef?.values[0]?.value ?? ref.values?.[0];
      return first ?? 'value';
    }
    case 'model': {
      const model = models.get(ref.name);
      if (!model || visited.has(ref.name) || depth >= MAX_DEPTH) return {};
      return sampleForModel(model, models, enums, depth, new Set([...visited, ref.name]));
    }
    case 'union': {
      if (ref.compositionKind !== 'allOf' && ref.discriminator) {
        const [value, modelName] = Object.entries(ref.discriminator.mapping)[0] ?? [];
        if (value !== undefined && modelName !== undefined) {
          const model = models.get(modelName);
          if (model && !visited.has(modelName) && depth < MAX_DEPTH) {
            const sample = sampleForModel(model, models, enums, depth, new Set([...visited, modelName])) as Record<
              string,
              unknown
            >;
            sample[ref.discriminator.property] = value;
            return sample;
          }
        }
      }
      const first = ref.variants[0];
      return first ? sampleForType(first, models, enums, fieldName, depth, visited) : null;
    }
  }
}

/**
 * Sample for a model shaped so that `to_map(from_map(sample)) == sample` holds
 * exactly, which the round-trip tests assert. Two adjustments versus
 * {@link sampleForModel} are required:
 *
 *  - fields are deduplicated by their Elixir struct key, mirroring
 *    `orderedFields` in models.ts. The spec ships deprecated camelCase aliases
 *    (`createdAt` beside `created_at`) that collapse onto one struct key, so an
 *    undeduplicated sample carries a key `to_map` will never emit back.
 *  - null values are dropped recursively, because `Cast.drop_nils/1` strips them
 *    on the way out.
 *
 * Both apply at every nesting level, hence the dedicated recursion.
 */
export function roundTripSample(
  model: Model,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  depth = 0,
  visited: Set<string> = new Set([model.name]),
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const seen = new Set<string>();
  for (const field of model.fields) {
    if (field.writeOnly) continue;
    const key = toSnakeCase(field.name);
    if (seen.has(key)) continue;
    seen.add(key);
    const value = roundTripValue(field.type, models, enums, field.name, depth + 1, visited);
    if (value !== null && value !== undefined) out[field.name] = value;
  }
  return out;
}

function roundTripValue(
  ref: TypeRef,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  fieldName: string,
  depth: number,
  visited: Set<string>,
): unknown {
  switch (ref.kind) {
    case 'nullable':
      return roundTripValue(ref.inner, models, enums, fieldName, depth, visited);
    case 'array': {
      if (depth >= MAX_DEPTH) return [];
      const item = roundTripValue(ref.items, models, enums, fieldName, depth + 1, visited);
      return item === null || item === undefined ? [] : [item];
    }
    case 'model': {
      const nested = models.get(ref.name);
      if (!nested || visited.has(ref.name) || depth >= MAX_DEPTH) return {};
      return roundTripSample(nested, models, enums, depth, new Set([...visited, ref.name]));
    }
    case 'union': {
      // Unions deserialize through a variant-specific caster; keep them out of
      // the round-trip payload rather than guessing which variant wins.
      return undefined;
    }
    default:
      return sampleForType(ref, models, enums, fieldName, depth, visited);
  }
}

function sampleForModel(
  model: Model,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  depth: number,
  visited: Set<string>,
): unknown {
  const out: Record<string, unknown> = {};
  for (const field of model.fields) {
    if (field.writeOnly) continue;
    out[field.name] = sampleForType(field.type, models, enums, field.name, depth + 1, visited);
  }
  return out;
}

function samplePrimitive(type: string, format: string | undefined, fieldName: string): unknown {
  switch (format) {
    case 'date':
      return '2024-01-01';
    case 'date-time':
      return '2024-01-01T00:00:00.000Z';
    case 'uuid':
      return '00000000-0000-4000-8000-000000000000';
    case 'binary':
      return 'binary';
  }
  switch (type) {
    case 'string':
      return fieldName;
    case 'integer':
      return 1;
    case 'number':
      return 1;
    case 'boolean':
      return true;
    default:
      return null;
  }
}
