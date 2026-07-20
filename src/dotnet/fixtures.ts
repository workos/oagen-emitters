import type { Model, TypeRef, Enum, EmitterContext } from '@workos/oagen';
import { fixtureFileName, domainFieldName } from './naming.js';
import { isListMetadataModel, isListWrapperModel } from './models.js';
import { collectNonPaginatedResponseModelNames, unwrapListModel } from '../shared/model-utils.js';
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
 */
export function generateFixtures(
  spec: {
    models: Model[];
    enums: Enum[];
    services: any[];
  },
  ctx: EmitterContext,
): { path: string; content: string }[] {
  if (spec.models.length === 0) return [];

  const modelMap = new Map(spec.models.map((m) => [m.name, m]));
  const enumMap = new Map(spec.enums.map((e) => [e.name, e]));
  const files: { path: string; content: string }[] = [];

  // List-wrappers are normally represented only by the per-operation
  // `list_<item>.json` fixtures generated from paginated operations below. But
  // a wrapper returned by a NON-paginated operation (e.g.
  // `PUT /authorization/groups/{id}/role_assignments` -> GroupRoleAssignmentList)
  // is emitted as a real model (see models.ts) and its generated test references
  // `testdata/<type>.json` (tests.ts). Emit that envelope fixture too, mirroring
  // the non-wrapper `VersionListResponse` precedent — otherwise the test loads a
  // file that was never written.
  const nonPaginatedWrapperRefs = collectNonPaginatedResponseModelNames(spec.services);

  for (const model of spec.models) {
    if (isListMetadataModel(model)) continue;
    if (isListWrapperModel(model) && !nonPaginatedWrapperRefs.has(model.name)) continue;

    // Minimal-scoped-generation gate (FR: byte-for-byte untouched siblings):
    // emit a per-model fixture ONLY for a SELECTED (in-scope) model. Under a
    // scoped (`--services X`) run `isModelInScope` is true only for models
    // reachable from service X, so out-of-scope services' fixtures are never
    // (re)written and stay byte-for-byte identical on disk. This is
    // deliberately SELECTED-only, not the SURFACE `fileExistsAfterRun` gate:
    // re-emitting an already-on-disk out-of-scope fixture would rewrite a file
    // outside the requested scope (and drift it if that model's shape changed
    // upstream). Full runs (`ctx.scopedModelNames` unset) emit everything.
    const fixturePath = `testdata/${fixtureFileName(model.name)}.json`;
    if (!isModelInScope(model.name, ctx)) continue;

    const fixture = model.fields.length === 0 ? {} : generateModelFixture(model, modelMap, enumMap);

    files.push({
      path: fixturePath,
      content: JSON.stringify(fixture, null, 2),
    });

    // Generate null-field variant for models with nullable/optional fields
    const hasNullableFields = model.fields.some((f) => !f.required || f.type.kind === 'nullable');
    if (hasNullableFields && model.fields.length > 0) {
      const nullFixture: Record<string, any> = {};
      for (const field of model.fields) {
        if (!field.required || field.type.kind === 'nullable') {
          nullFixture[field.name] = null;
        } else {
          nullFixture[field.name] = fixture[field.name] ?? null;
        }
      }
      files.push({
        path: `testdata/${fixtureFileName(model.name)}_nulls.json`,
        content: JSON.stringify(nullFixture, null, 2),
      });
    }
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
          const fixture = generateModelFixture(itemModel, modelMap, enumMap);
          const listFixture = {
            data: [fixture],
            list_metadata: {
              before: null,
              after: null,
            },
          };
          files.push({
            path: `testdata/list_${fixtureFileName(itemModel.name)}.json`,
            content: JSON.stringify(listFixture, null, 2),
          });
        }
      }
    }
  }

  // Generate empty list fixtures for paginated responses
  for (const service of spec.services) {
    for (const op of service.operations) {
      if (op.pagination) {
        let itemModel = op.pagination.itemType.kind === 'model' ? modelMap.get(op.pagination.itemType.name) : null;
        if (itemModel) {
          const unwrapped = unwrapListModel(itemModel, modelMap);
          if (unwrapped) itemModel = unwrapped;
          const emptyFixture = {
            data: [],
            list_metadata: {
              before: null,
              after: null,
            },
          };
          files.push({
            path: `testdata/list_empty_${fixtureFileName(itemModel.name)}.json`,
            content: JSON.stringify(emptyFixture, null, 2),
          });
        }
      }
    }
  }

  // Deduplicate fixtures by path (keep last-written for each path)
  const byPath = new Map<string, { path: string; content: string }>();
  for (const f of files) {
    byPath.set(f.path, f);
  }

  return [...byPath.values()];
}

export function generateModelFixture(
  model: Model,
  modelMap: Map<string, Model>,
  enumMap: Map<string, Enum>,
): Record<string, any> {
  const fixture: Record<string, any> = {};

  const seenFieldNames = new Set<string>();
  const deduplicatedFields = model.fields.filter((f) => {
    // Dedup on the DOMAIN identifier (the C# property name, honoring a
    // `domainName` override) to mirror the dedup in models.ts. The fixture
    // payload below still keys on the wire name (`field.name`).
    const csName = domainFieldName(f);
    if (seenFieldNames.has(csName)) return false;
    seenFieldNames.add(csName);
    return true;
  });

  for (const field of deduplicatedFields) {
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
  fName: string,
  modelName: string,
  modelMap: Map<string, Model>,
  enumMap: Map<string, Enum>,
): any {
  switch (ref.kind) {
    case 'primitive':
      return generatePrimitiveValue(ref.type, ref.format, fName, modelName);
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
      const item = generateFieldValue(ref.items, fName, modelName, modelMap, enumMap);
      return [item];
    }
    case 'nullable':
      return generateFieldValue(ref.inner, fName, modelName, modelMap, enumMap);
    case 'union':
      if (ref.variants.length > 0) {
        return generateFieldValue(ref.variants[0], fName, modelName, modelMap, enumMap);
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
