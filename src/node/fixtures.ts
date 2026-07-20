import type { Model, TypeRef, Enum, EmitterContext } from '@workos/oagen';
import { wireFieldName, fileName, resolveServiceDir } from './naming.js';
import { resolveResourceClassName, resolveResourceDir } from './resources.js';
import {
  createServiceDirResolver,
  assignModelsToServices,
  isListMetadataModel,
  isListWrapperModel,
  collectNonPaginatedResponseModelNames,
  collectReferencedListMetadataModels,
  unwrapListModel,
} from './utils.js';

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
        resolveDir: (irService: string | undefined) => (irService ? resolveServiceDir(irService) : 'common'),
      };
  const modelMap = new Map(spec.models.map((m) => [m.name, m]));
  const enumMap = new Map(spec.enums.map((e) => [e.name, e]));
  const files: { path: string; content: string }[] = [];

  const fixtureSeeds = new Set<string>();
  for (const svc of spec.services) {
    if (svc.name.toLowerCase() === 'events') continue;
    for (const op of svc.operations) {
      const collectFromRef = (t: TypeRef | undefined): void => {
        if (!t) return;
        if (t.kind === 'model') fixtureSeeds.add(t.name);
        if (t.kind === 'array') collectFromRef(t.items);
        if (t.kind === 'nullable') collectFromRef(t.inner);
        if (t.kind === 'union') t.variants.forEach(collectFromRef);
      };
      collectFromRef(op.response);
      collectFromRef(op.requestBody);
      if (op.pagination?.itemType) collectFromRef(op.pagination.itemType);
    }
  }
  const fixtureModelMap = new Map(spec.models.map((m: Model) => [m.name, m]));
  const fixtureReachable = new Set<string>();
  const fixtureQueue = [...fixtureSeeds];
  while (fixtureQueue.length > 0) {
    const name = fixtureQueue.pop()!;
    if (fixtureReachable.has(name)) continue;
    fixtureReachable.add(name);
    const m = fixtureModelMap.get(name);
    if (!m) continue;
    for (const field of m.fields) {
      const walk = (t: TypeRef): void => {
        if (t.kind === 'model' && !fixtureReachable.has(t.name)) fixtureQueue.push(t.name);
        if (t.kind === 'array') walk(t.items);
        if (t.kind === 'nullable') walk(t.inner);
        if (t.kind === 'union') t.variants.forEach(walk);
      };
      walk(field.type);
    }
  }

  const nonPaginatedRefs = collectNonPaginatedResponseModelNames(spec.services);
  const listMetadataNeeded = collectReferencedListMetadataModels(spec.models, nonPaginatedRefs);

  const seenFixturePaths = new Set<string>();
  for (const model of spec.models) {
    if (!fixtureReachable.has(model.name)) continue;
    if (isListMetadataModel(model) && !listMetadataNeeded.has(model.name)) continue;
    if (isListWrapperModel(model) && !nonPaginatedRefs.has(model.name)) continue;

    const service = modelToService.get(model.name);
    const dirName = resolveDir(service);
    const fixturePath = `src/${dirName}/fixtures/${fileName(model.name)}.json`;

    if (seenFixturePaths.has(fixturePath)) continue;
    seenFixturePaths.add(fixturePath);

    const fixture = generateModelFixture(model, modelMap, enumMap);

    files.push({
      path: fixturePath,
      content: JSON.stringify(fixture, null, 2),
    });
  }

  for (const service of spec.services) {
    const resolvedName = ctx ? resolveResourceClassName(service, ctx) : service.name;
    const serviceDir = ctx ? resolveResourceDir(service, ctx) : resolveServiceDir(resolvedName);
    for (const op of service.operations) {
      if (op.pagination) {
        let itemModel = op.pagination.itemType.kind === 'model' ? modelMap.get(op.pagination.itemType.name) : null;
        if (itemModel) {
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
            path: `src/${serviceDir}/fixtures/list-${fileName(itemModel.name)}.json`,
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
    const wireName = wireFieldName(field.name);
    if (field.example !== undefined) {
      fixture[wireName] = field.example;
    } else {
      fixture[wireName] = generateFieldValue(field.type, field.name, model.name, modelMap, enumMap);
    }
  }

  if (model.discriminator) {
    const [firstValue, variantName] = Object.entries(model.discriminator.mapping)[0];
    fixture[wireFieldName(model.discriminator.property)] = firstValue;
    const variantModel = modelMap.get(variantName);
    if (variantModel) {
      for (const field of variantModel.fields) {
        const wireName = wireFieldName(field.name);
        if (!(wireName in fixture)) {
          fixture[wireName] =
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
