import type { Model, TypeRef, Enum, EmitterContext } from '@workos/oagen';

import { fileName, domainFieldName } from './naming.js';
import { isListMetadataModel, isListWrapperModel } from './models.js';
import {
  collectNonPaginatedResponseModelNames,
  collectReferencedListMetadataModels,
  unwrapListModel,
} from '../shared/model-utils.js';
import { isModelInScope } from '../shared/resolved-ops.js';

/**
 * Prefix mapping for generating realistic ID fixture values.
 */
export const ID_PREFIXES: Record<string, string> = {
  Connection: 'conn_',
  Organization: 'org_',
  OrganizationMembership: 'om_',
  User: 'user_',
  Directory: 'directory_',
  DirectoryGroup: 'dir_grp_',
  DirectoryUser: 'dir_usr_',
  Invitation: 'inv_',
  Session: 'session_',
  AuthenticationFactor: 'auth_factor_',
  EmailVerification: 'email_verification_',
  MagicAuth: 'magic_auth_',
  PasswordReset: 'password_reset_',
};

/**
 * Generate JSON fixture files for test data.
 *
 * `ctx` is optional so unit tests can call with a bare spec; when supplied, a
 * scoped (`--services`) run only emits a fixture for a SELECTED (in-scope)
 * model — `isModelInScope` alone, NOT `fileExistsAfterRun`. Minimal scoped
 * generation regenerates ONLY the selected service's files: every other
 * on-disk service's fixtures must be left BYTE-FOR-BYTE untouched, so we must
 * not re-emit a fixture just because the model already sits on disk (from the
 * prior manifest). The monolithic round-trip test that consumed the wider set
 * of fixtures is skipped entirely on a scoped run, and the per-service tests
 * only reference fixtures for their (in-scope) models.
 */
export function generateFixtures(
  spec: {
    models: Model[];
    enums: Enum[];
    services: any[];
  },
  ctx?: EmitterContext,
): { path: string; content: string }[] {
  if (spec.models.length === 0) return [];

  const modelMap = new Map(spec.models.map((m) => [m.name, m]));
  const enumMap = new Map(spec.enums.map((e) => [e.name, e]));
  const files: { path: string; content: string }[] = [];

  // A fixture is emitted only for a SELECTED (in-scope) model. `isModelInScope`
  // is selected-only under a scoped run and true for everything on a full run,
  // so this leaves every out-of-scope service's fixtures untouched on disk.
  // The `path` arg is retained for call-site symmetry (base vs. `list_*`) but
  // scoping keys purely off the owning model. When ctx is absent (unit tests)
  // every fixture is in scope.
  const fixtureEmitted = (_path: string, modelName: string): boolean => {
    if (!ctx) return true;
    return isModelInScope(modelName, ctx);
  };

  const nonPaginatedRefs = collectNonPaginatedResponseModelNames(spec.services);
  const listMetadataNeeded = collectReferencedListMetadataModels(spec.models, nonPaginatedRefs);

  for (const model of spec.models) {
    if (isListMetadataModel(model) && !listMetadataNeeded.has(model.name)) continue;
    if (isListWrapperModel(model) && !nonPaginatedRefs.has(model.name)) continue;
    // Skip models with no fields — these are typically discriminated unions
    // with hand-maintained @oagen-ignore overrides; generated empty fixtures
    // would not match the override's required fields.
    if (model.fields.length === 0) continue;
    // Scoped run: skip a fixture for a brand-new out-of-scope model.
    if (!fixtureEmitted(`tests/fixtures/${fileName(model.name)}.json`, model.name)) continue;

    const fixture = generateModelFixture(model, modelMap, enumMap);

    files.push({
      path: `tests/fixtures/${fileName(model.name)}.json`,
      content: JSON.stringify(fixture, null, 2),
    });
  }

  // Generate list fixtures for paginated responses
  for (const service of spec.services) {
    for (const op of service.operations) {
      if (op.pagination) {
        let itemModel = op.pagination.itemType.kind === 'model' ? modelMap.get(op.pagination.itemType.name) : null;
        if (itemModel) {
          const unwrapped = unwrapListModel(itemModel, modelMap);
          if (unwrapped) itemModel = unwrapped;
          if (itemModel.fields.length === 0) continue;
          // Scoped run: a list fixture for a brand-new out-of-scope item model
          // would be referenced by no emitted test; gate it on the LIST
          // fixture's own path (not the base model fixture's).
          if (!fixtureEmitted(`tests/fixtures/list_${fileName(itemModel.name)}.json`, itemModel.name)) continue;
          const fixture = generateModelFixture(itemModel, modelMap, enumMap);
          const listFixture = {
            data: [fixture],
            list_metadata: {
              before: null,
              after: null,
            },
          };
          files.push({
            path: `tests/fixtures/list_${fileName(itemModel.name)}.json`,
            content: JSON.stringify(listFixture, null, 2),
          });
        }
      }
    }
  }

  return files;
}

export function generateModelFixture(
  model: Model,
  modelMap: Map<string, Model>,
  enumMap: Map<string, Enum>,
): Record<string, any> {
  // A discriminated union is one variant on the wire, never the merged
  // superset its own `fields` describe (oagen 0.32 folds every variant's
  // fields onto the union model). Build the payload from the first mapped
  // variant alone: a field another variant declares (`metadata`, declared only
  // for `client_credentials`) beside `auth_method: oauth` is dropped by the
  // dispatched variant on the way back out, so the round-trip could never match.
  const variantFixture = discriminatedVariantFixture(model, modelMap, enumMap);
  if (variantFixture) return variantFixture;

  const fixture: Record<string, any> = {};

  // Deduplicate fields by DOMAIN identifier (matching model generation in
  // models.ts, which honors `domainName`); the wire key below stays `field.name`.
  const seenFieldNames = new Set<string>();
  const deduplicatedFields = model.fields.filter((f) => {
    const pyName = domainFieldName(f);
    if (seenFieldNames.has(pyName)) return false;
    seenFieldNames.add(pyName);
    return true;
  });

  for (const field of deduplicatedFields) {
    // Use the original field name as the wire key (matches from_dict access patterns)
    const wireName = field.name;
    if (field.example !== undefined) {
      fixture[wireName] = normalizeDateTimeExample(field, conformExample(field.type, field.example, modelMap, enumMap));
    } else {
      fixture[wireName] = generateFieldValue(field.type, field.name, model.name, modelMap, enumMap);
    }
  }

  // A union whose first variant the IR never materialized: keep the
  // discriminator value so dispatch still has something to read.
  const firstDiscriminatorValue = firstMappedVariant(model)?.[0];
  if (model.discriminator && firstDiscriminatorValue !== undefined) {
    fixture[model.discriminator.property] = firstDiscriminatorValue;
  }

  return fixture;
}

/**
 * Fit a spec example to the shape the generated model can round-trip.
 *
 * A scalar example is copied as-is, but a whole-object example is hand-written
 * in the spec and drifts from the schema it illustrates: the data-integrations
 * list response carried camelCase duplicates (`createdAt` beside `created_at`)
 * that the model collapses into one field, and the finish-connection example
 * omitted nullable fields the serializer always emits, so `from_dict` →
 * `to_dict` could never reproduce the fixture. For a model-typed value, build
 * the object the way a field without an example is built, then overlay the
 * example's values for the fields that object declares: unknown keys are
 * dropped, missing fields keep their generated value, nested objects and array
 * items recurse. Anything else is left to the example.
 */
function conformExample(
  ref: TypeRef,
  example: unknown,
  modelMap: Map<string, Model>,
  enumMap: Map<string, Enum>,
): unknown {
  switch (ref.kind) {
    case 'nullable':
      return example === null ? null : conformExample(ref.inner, example, modelMap, enumMap);
    case 'model': {
      const nested = modelMap.get(ref.name);
      if (!nested || !isPlainObject(example)) return example;
      return overlayExample(nested, example, modelMap, enumMap);
    }
    case 'array':
      return Array.isArray(example)
        ? example.map((item) => conformExample(ref.items, item, modelMap, enumMap))
        : example;
    case 'map':
      return isPlainObject(example)
        ? Object.fromEntries(
            Object.entries(example).map(([key, value]) => [
              key,
              conformExample(ref.valueType, value, modelMap, enumMap),
            ]),
          )
        : example;
    default:
      return example;
  }
}

/** `model`'s generated fixture with `example`'s values laid over the fields it keeps. */
function overlayExample(
  model: Model,
  example: Record<string, unknown>,
  modelMap: Map<string, Model>,
  enumMap: Map<string, Enum>,
): Record<string, unknown> {
  const base = generateModelFixture(model, modelMap, enumMap);
  // A discriminated union's fixture is its first mapped variant's, so the
  // fields to overlay are that variant's, and the pinned discriminator stays.
  const variantName = firstMappedVariant(model)?.[1];
  const variant = variantName ? modelMap.get(variantName) : undefined;
  const source = variant && variant !== model ? variant : model;
  for (const field of source.fields) {
    const key = field.name;
    if (!(key in base) || !(key in example)) continue;
    if (model.discriminator && key === model.discriminator.property) continue;
    base[key] = normalizeDateTimeExample(field, conformExample(field.type, example[key], modelMap, enumMap));
  }
  return base;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The first `[value, variantModelName]` of a discriminated union's mapping, if any. */
function firstMappedVariant(model: Model): [string, string] | undefined {
  const entry = model.discriminator ? Object.entries(model.discriminator.mapping)[0] : undefined;
  return entry as [string, string] | undefined;
}

/**
 * The fixture of a discriminated union, built from its first mapped variant's
 * own fields with the discriminator pinned to that variant's value — or
 * undefined when the model is not a union or the variant has no model.
 */
function discriminatedVariantFixture(
  model: Model,
  modelMap: Map<string, Model>,
  enumMap: Map<string, Enum>,
): Record<string, any> | undefined {
  if (!model.discriminator) return undefined;
  const entry = firstMappedVariant(model);
  if (!entry) return undefined;
  const [value, variantName] = entry;
  const variantModel = modelMap.get(variantName);
  if (!variantModel || variantModel === model) return undefined;
  const fixture = generateModelFixture(variantModel, modelMap, enumMap);
  fixture[model.discriminator.property] = value;
  return fixture;
}

function generateFieldValue(
  ref: TypeRef,
  fieldName: string,
  modelName: string,
  modelMap: Map<string, Model>,
  enumMap: Map<string, Enum>,
): any {
  switch (ref.kind) {
    case 'primitive':
      return generatePrimitiveValue(ref.type, ref.format, fieldName, modelName);
    case 'literal':
      return ref.value;
    case 'enum': {
      const e = enumMap.get(ref.name);
      return e?.values[0]?.value ?? 'unknown';
    }
    case 'model': {
      const nested = modelMap.get(ref.name);
      if (nested) return generateModelFixture(nested, modelMap, enumMap);
      return {};
    }
    case 'array': {
      if (ref.items.kind === 'enum') {
        const e = enumMap.get(ref.items.name);
        if (e && e.values.length > 0) {
          return e.values.map((v) => v.value);
        }
      }
      const item = generateFieldValue(ref.items, fieldName, modelName, modelMap, enumMap);
      return [item];
    }
    case 'nullable':
      return generateFieldValue(ref.inner, fieldName, modelName, modelMap, enumMap);
    case 'union':
      if (ref.variants.length > 0) {
        return generateFieldValue(ref.variants[0], fieldName, modelName, modelMap, enumMap);
      }
      return null;
    case 'map':
      return {
        key: generateFieldValue(ref.valueType, 'value', modelName, modelMap, enumMap),
      };
  }
}

/**
 * Normalize date-time example values to millisecond precision so that
 * round-trip tests (from_dict → to_dict) produce identical output.
 * Python's _format_datetime always serializes with milliseconds.
 */
function normalizeDateTimeExample(
  field: { type: { kind: string; format?: string; type?: string; inner?: any } },
  value: any,
): any {
  if (typeof value !== 'string') return value;
  const ref = field.type.kind === 'nullable' ? field.type.inner : field.type;
  if (ref?.kind !== 'primitive' || ref?.type !== 'string' || ref?.format !== 'date-time') return value;
  const match = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);
  if (!match) return value;
  const [, prefix, , suffix] = match;
  return `${prefix}.000${suffix}`;
}

function generatePrimitiveValue(type: string, format: string | undefined, name: string, modelName: string): any {
  switch (type) {
    case 'string':
      if (format === 'date-time') return '2023-01-01T00:00:00.000Z';
      if (format === 'date') return '2023-01-01';
      if (format === 'uuid') return '00000000-0000-0000-0000-000000000000';
      if (name === 'id') {
        const prefix = ID_PREFIXES[modelName] ?? '';
        return `${prefix}01234`;
      }
      if (name.includes('id')) return `${name}_01234`;
      if (name.includes('email')) return 'test@example.com';
      if (name.includes('url') || name.includes('uri')) return 'https://example.com';
      if (name.includes('name')) return 'Test';
      return `test_${name}`;
    case 'integer':
      return 1;
    case 'number':
      return 1.0;
    case 'boolean':
      return true;
    case 'unknown':
      return {};
    default:
      return null;
  }
}
