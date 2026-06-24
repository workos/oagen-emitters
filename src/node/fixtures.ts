import type { Model, TypeRef, Enum, EmitterContext } from '@workos/oagen';
import { wireFieldName, fileName, resolveServiceDir, getDiscriminatedFixtureBranches } from './naming.js';
import { resolveResourceClassName, resolveResourceDir } from './resources.js';
import {
  createServiceDirResolver,
  assignModelsToServices,
  isListMetadataModel,
  isListWrapperModel,
  collectNonPaginatedResponseModelNames,
  collectReferencedListMetadataModels,
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

export function generateModelFixture(
  model: Model,
  modelMap: Map<string, Model>,
  enumMap: Map<string, Enum>,
): Record<string, any> {
  const fixture: Record<string, any> = {};

  // A top-level discriminated union (e.g. the token response) reaches the
  // fixture pass as a flattened all-optional model. Emitting every field would
  // produce an impossible instance carrying mutually-exclusive branch fields
  // (`access_token` AND `error`). When the model is a known union, keep only
  // the first branch's wire fields and pin the discriminator to its value.
  const branch = getDiscriminatedFixtureBranches().get(model.name);

  for (const field of model.fields) {
    const wireName = wireFieldName(field.name);
    if (branch && !branch.keepWire.has(wireName)) continue;
    if (field.example !== undefined) {
      fixture[wireName] = normalizeExample(field.example, field.type);
    } else {
      fixture[wireName] = generateFieldValue(field.type, field.name, model.name, modelMap, enumMap);
    }
  }

  if (branch) {
    fixture[branch.discriminatorWire] = branch.discriminatorValue;
    return fixture;
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
              ? normalizeExample(field.example, field.type)
              : generateFieldValue(field.type, field.name, model.name, modelMap, enumMap);
        }
      }
    }
  }

  return fixture;
}

/**
 * Build the wire-shape fixture for ONE branch of a discriminated union, used by
 * the test generator to mock each arm of the response. Mirrors the first-branch
 * path in {@link generateModelFixture}: keep only this branch's wire fields and
 * pin the discriminator to its value, so the result is a valid single-branch
 * instance rather than a merge of mutually-exclusive variants.
 */
export function buildBranchFixture(
  model: Model,
  branch: { keepWire: Set<string>; discriminatorWire: string; discriminatorValue: string | number | boolean },
  modelMap: Map<string, Model>,
  enumMap: Map<string, Enum>,
): Record<string, any> {
  const fixture: Record<string, any> = {};
  for (const field of model.fields) {
    const wireName = wireFieldName(field.name);
    if (!branch.keepWire.has(wireName)) continue;
    fixture[wireName] =
      field.example !== undefined
        ? normalizeExample(field.example, field.type)
        : generateFieldValue(field.type, field.name, model.name, modelMap, enumMap);
  }
  fixture[branch.discriminatorWire] = branch.discriminatorValue;
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

/** True when a type is (or nullable-wraps) a `format: date-time` string. */
function isDateTimeType(ref: TypeRef): boolean {
  if (ref.kind === 'nullable') return isDateTimeType(ref.inner);
  return ref.kind === 'primitive' && ref.type === 'string' && ref.format === 'date-time';
}

/** Normalize a field's spec `example` before placing it in a fixture.
 *  `format: date-time` examples in specs are frequently non-canonical (e.g.
 *  `2024-06-15T10:30:00Z`), but the generated serializer round-trips date-time
 *  fields through `Date`, so a generated test asserting
 *  `deserialized.x.toISOString()` against the raw wire value only matches when
 *  the fixture is canonical ISO. Coerce date-time string examples accordingly;
 *  leave everything else untouched. */
function normalizeExample(example: unknown, type: TypeRef): unknown {
  if (typeof example === 'string' && isDateTimeType(type)) {
    const ms = Date.parse(example);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  return example;
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
