import type { Model, TypeRef, Enum, EmitterContext } from '@workos/oagen';
import { wireFieldName, fileName, serviceDirName, resolveServiceName } from './naming.js';
import { createServiceDirResolver, assignModelsToServices, isListMetadataModel, isListWrapperModel } from './utils.js';

/**
 * Prefix mapping for generating realistic ID fixture values.
 * When a field named "id" belongs to a model whose name matches a key here,
 * the generated ID will be prefixed accordingly (e.g. "conn_01234").
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
 * Each model that appears as a response gets a fixture in wire format (snake_case).
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

  const { modelToService, resolveDir } = ctx
    ? createServiceDirResolver(spec.models, ctx.spec.services, ctx)
    : {
        modelToService: assignModelsToServices(spec.models, spec.services),
        resolveDir: (irService: string | undefined) => (irService ? serviceDirName(irService) : 'common'),
      };
  const modelMap = new Map(spec.models.map((m) => [m.name, m]));
  const enumMap = new Map(spec.enums.map((e) => [e.name, e]));
  const files: { path: string; content: string }[] = [];

  for (const model of spec.models) {
    // Skip redundant list-metadata and list-wrapper models (handled by shared types)
    if (isListMetadataModel(model)) continue;
    if (isListWrapperModel(model)) continue;

    const service = modelToService.get(model.name);
    const dirName = resolveDir(service);
    const fixture = generateModelFixture(model, modelMap, enumMap);

    files.push({
      path: `src/${dirName}/fixtures/${fileName(model.name)}.fixture.json`,
      content: JSON.stringify(fixture, null, 2),
    });
  }

  // Generate list fixtures for models that appear in paginated responses
  for (const service of spec.services) {
    const resolvedName = ctx ? resolveServiceName(service, ctx) : service.name;
    const serviceDir = serviceDirName(resolvedName);
    for (const op of service.operations) {
      if (op.pagination) {
        let itemModel = op.pagination.itemType.kind === 'model' ? modelMap.get(op.pagination.itemType.name) : null;
        if (itemModel) {
          // Detect if the "item" model is actually a list wrapper (has `data` array + `list_metadata`).
          // If so, unwrap to the actual item type to avoid double-nesting in fixtures.
          const unwrapped = unwrapListModel(itemModel, modelMap);
          if (unwrapped) {
            itemModel = unwrapped;
          }
          const fixture = generateModelFixture(itemModel, modelMap, enumMap);
          const listFixture = {
            data: [fixture],
            list_metadata: {
              before: null,
              after: null,
            },
          };
          files.push({
            path: `src/${serviceDir}/fixtures/list-${fileName(itemModel.name)}.fixture.json`,
            content: JSON.stringify(listFixture, null, 2),
          });
        }
      }
    }
  }

  return files;
}

/**
 * Detect if a model is a list wrapper (has a `data` array field and a `list_metadata` field).
 * If so, return the inner item model from the `data` array. Otherwise return null.
 * This prevents double-nesting when the pagination itemType points to a list wrapper
 * instead of the actual item model.
 */
export function unwrapListModel(model: Model, modelMap: Map<string, Model>): Model | null {
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

function generateModelFixture(
  model: Model,
  modelMap: Map<string, Model>,
  enumMap: Map<string, Enum>,
): Record<string, any> {
  const fixture: Record<string, any> = {};

  for (const field of model.fields) {
    const wireName = wireFieldName(field.name);
    // Prefer the OpenAPI example value when available on the field
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
      // For array<enum>, use actual enum values instead of a single generated item
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
      return { key: generateFieldValue(ref.valueType, 'value', modelName, modelMap, enumMap) };
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
