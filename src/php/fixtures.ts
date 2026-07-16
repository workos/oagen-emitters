import type { Model, TypeRef, Enum, EmitterContext } from '@workos/oagen';
import { isListMetadataModel, isListWrapperModel } from './models.js';
import {
  collectNonPaginatedResponseModelNames,
  collectReferencedListMetadataModels,
  unwrapListModel,
} from '../shared/model-utils.js';
import { isModelInScope } from '../shared/resolved-ops.js';
import { snakeName } from './naming.js';

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
 * FR-1.4: fixtures are per-model standalone JSON files under `tests/Fixtures/`
 * with no barrel/index (they are loaded by name via TestHelper::loadFixture).
 * Under a scoped (`--services`) run we therefore emit a fixture ONLY for a model
 * that is in scope (SELECTED — reachable from the chosen services), gating on
 * {@link isModelInScope}. Out-of-scope fixtures are left untouched on disk so a
 * scoped run leaves every other service's fixtures BYTE-FOR-BYTE unchanged.
 * `isModelInScope` (selected-only) — NOT `fileExistsAfterRun` (surface) — is the
 * right gate here because a fixture is standalone: nothing references it that we
 * must keep declared, unlike a barrel entry.
 *
 * `ctx` is optional so callers without a context (older tests) keep the full
 * behavior; scoping is inert when `ctx` is absent or unscoped.
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

  const inScope = (modelName: string): boolean => (ctx ? isModelInScope(modelName, ctx) : true);

  const modelMap = new Map(spec.models.map((m) => [m.name, m]));
  const enumMap = new Map(spec.enums.map((e) => [e.name, e]));
  const files: { path: string; content: string }[] = [];
  const nonPaginatedRefs = collectNonPaginatedResponseModelNames(spec.services);
  const listMetadataNeeded = collectReferencedListMetadataModels(spec.models, nonPaginatedRefs);

  for (const model of spec.models) {
    if (isListMetadataModel(model) && !listMetadataNeeded.has(model.name)) continue;
    if (isListWrapperModel(model)) continue;
    // Scoped run: emit only the selected models' fixtures.
    if (!inScope(model.name)) continue;

    const fixture = generateModelFixture(model, modelMap, enumMap);

    files.push({
      path: `tests/Fixtures/${snakeName(model.name)}.json`,
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
          // Scoped run: emit the list fixture only when its item model is selected.
          if (!inScope(itemModel.name)) continue;
          const fixture = generateModelFixture(itemModel, modelMap, enumMap);
          const listFixture = {
            data: [fixture],
            list_metadata: {
              before: null,
              after: null,
            },
          };
          files.push({
            path: `tests/Fixtures/list_${snakeName(itemModel.name)}.json`,
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
  const fixture: Record<string, any> = {};

  for (const field of model.fields) {
    const wireName = field.name;
    if (field.example !== undefined) {
      fixture[wireName] = field.example;
    } else {
      fixture[wireName] = generateFieldValue(field.type, field.name, model.name, modelMap, enumMap);
    }
  }

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
