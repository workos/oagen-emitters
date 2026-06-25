import type { Model, TypeRef, Enum, EmitterContext } from '@workos/oagen';
import { fileName, domainFieldName } from './naming.js';
import { isListMetadataModel, isListWrapperModel } from './models.js';
import { collectNonPaginatedResponseModelNames, collectReferencedListMetadataModels } from '../shared/model-utils.js';
import { isModelInScope, fileExistsAfterRun } from '../shared/resolved-ops.js';

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
 * Scoped runs only emit a fixture for a model whose per-model fixture FILE will
 * exist on disk after the run (in-scope, or already present from a prior run —
 * the fixture path is per-model so the prior manifest records it directly).
 * This drops brand-new out-of-scope fixtures (the round-trip ADDITION case) and
 * keeps prior fixtures untouched, mirroring the Rust fixtures fix. `ctx` is
 * optional so unit tests that assert raw content can call it for a full run.
 */
export function generateFixtures(
  spec: { models: Model[]; enums: Enum[]; services: any[] },
  ctx?: EmitterContext,
): {
  files: { path: string; content: string }[];
  pathRewrites: Map<string, string>;
} {
  if (spec.models.length === 0) return { files: [], pathRewrites: new Map() };

  const modelMap = new Map(spec.models.map((m) => [m.name, m]));
  const enumMap = new Map(spec.enums.map((e) => [e.name, e]));
  const files: { path: string; content: string }[] = [];

  const nonPaginatedRefs = collectNonPaginatedResponseModelNames(spec.services);
  const listMetadataNeeded = collectReferencedListMetadataModels(spec.models, nonPaginatedRefs);

  // Full run (no ctx / no scoping): every fixture is in scope.
  const fixtureInScope = (relPath: string, modelName: string): boolean =>
    !ctx || fileExistsAfterRun(relPath, isModelInScope(modelName, ctx), ctx);

  for (const model of spec.models) {
    if (isListMetadataModel(model) && !listMetadataNeeded.has(model.name)) continue;
    if (isListWrapperModel(model) && !nonPaginatedRefs.has(model.name)) continue;

    const path = `testdata/${fileName(model.name)}.json`;
    if (!fixtureInScope(path, model.name)) continue;

    const fixture = model.fields.length === 0 ? {} : generateModelFixture(model, modelMap, enumMap);

    files.push({
      path,
      content: JSON.stringify(fixture, null, 2),
    });
  }

  // Generate list fixtures for paginated responses. Multiple operations may
  // share the same item model (e.g. several role-assignment list endpoints all
  // returning UserRoleAssignmentList) — emit each fixture path once so the
  // content-dedup pass below doesn't see N copies of the same path and drop
  // the file entirely.
  const seenListPaths = new Set<string>();
  for (const service of spec.services) {
    for (const op of service.operations) {
      if (op.pagination) {
        let itemModel = op.pagination.itemType.kind === 'model' ? modelMap.get(op.pagination.itemType.name) : null;
        if (itemModel) {
          const unwrapped = unwrapListModel(itemModel, modelMap);
          if (unwrapped) itemModel = unwrapped;
          if (itemModel.fields.length === 0) continue;
          const path = `testdata/list_${fileName(itemModel.name)}.json`;
          if (seenListPaths.has(path)) continue;
          seenListPaths.add(path);
          // Scoped run: only emit a list fixture whose file will exist after the
          // run (in-scope item model, or already on disk). Keyed on the item
          // model so an out-of-scope paginated endpoint doesn't add a new file.
          if (!fixtureInScope(path, itemModel.name)) continue;
          const fixture = generateModelFixture(itemModel, modelMap, enumMap);
          const listFixture = {
            data: [fixture],
            list_metadata: {
              before: null,
              after: null,
            },
          };
          files.push({
            path,
            content: JSON.stringify(listFixture, null, 2),
          });
        }
      }
    }
  }

  // Deduplicate fixtures with identical content.
  // When multiple fixtures have the same content, emit one shared file and
  // rewrite the others as references to the shared path.
  const contentGroups = new Map<string, string[]>();
  for (const f of files) {
    if (!contentGroups.has(f.content)) contentGroups.set(f.content, []);
    contentGroups.get(f.content)!.push(f.path);
  }

  const pathRewrites = new Map<string, string>();
  for (const [_content, paths] of contentGroups) {
    if (paths.length < 3) continue; // only dedup when 3+ files are identical
    // Use the shortest path as the canonical shared fixture
    const sorted = [...paths].sort((a, b) => a.length - b.length);
    const canonical = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      pathRewrites.set(sorted[i], canonical);
    }
  }

  // Remove duplicate files (they'll reference the canonical)
  const deduped = files.filter((f) => !pathRewrites.has(f.path));

  return { files: deduped, pathRewrites };
}

function unwrapListModel(model: Model, modelMap: Map<string, Model>): Model | null {
  const dataField = model.fields.find((f) => f.name === 'data');
  const hasListMetadata = model.fields.some((f) => f.name === 'list_metadata' || f.name === 'listMetadata');
  if (dataField && hasListMetadata && dataField.type.kind === 'array') {
    const itemType = dataField.type.items;
    if (itemType.kind === 'model') {
      return modelMap.get(itemType.name) ?? null;
    }
  }
  return null;
}

export function generateModelFixture(
  model: Model,
  modelMap: Map<string, Model>,
  enumMap: Map<string, Enum>,
): Record<string, any> {
  const fixture: Record<string, any> = {};

  const seenFieldNames = new Set<string>();
  const deduplicatedFields = model.fields.filter((f) => {
    // Dedup by the domain Go field name to mirror the struct in models.ts; the
    // fixture key itself (wireName below) still derives from field.name.
    const goName = domainFieldName(f);
    if (seenFieldNames.has(goName)) return false;
    seenFieldNames.add(goName);
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

  if (model.discriminator) {
    const [firstValue, variantName] = Object.entries(model.discriminator.mapping)[0];
    fixture[model.discriminator.property] = firstValue;
    const variantModel = modelMap.get(variantName);
    if (variantModel) {
      for (const field of variantModel.fields) {
        if (!(field.name in fixture)) {
          fixture[field.name] =
            field.example !== undefined
              ? field.example
              : generateFieldValue(field.type, field.name, model.name, modelMap, enumMap);
        }
      }
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
