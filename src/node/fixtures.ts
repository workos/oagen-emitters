import type { Model, TypeRef, Enum, EmitterContext } from '@workos/oagen';
import { wireFieldName, fileName, serviceDirName, buildServiceNameMap, resolveServiceName } from './naming.js';
import { assignModelsToServices } from './utils.js';

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

  const modelToService = assignModelsToServices(spec.models, spec.services);
  const serviceNameMap = ctx ? buildServiceNameMap(ctx.spec.services, ctx) : new Map<string, string>();
  const resolveDir = (irService: string | undefined) =>
    irService ? serviceDirName(serviceNameMap.get(irService) ?? irService) : 'common';
  const modelMap = new Map(spec.models.map((m) => [m.name, m]));
  const enumMap = new Map(spec.enums.map((e) => [e.name, e]));
  const files: { path: string; content: string }[] = [];

  for (const model of spec.models) {
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
        const itemModel = op.pagination.itemType.kind === 'model' ? modelMap.get(op.pagination.itemType.name) : null;
        if (itemModel) {
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

function generateModelFixture(
  model: Model,
  modelMap: Map<string, Model>,
  enumMap: Map<string, Enum>,
): Record<string, any> {
  const fixture: Record<string, any> = {};

  for (const field of model.fields) {
    const wireName = wireFieldName(field.name);
    fixture[wireName] = generateFieldValue(field.type, field.name, modelMap, enumMap);
  }

  return fixture;
}

function generateFieldValue(
  ref: TypeRef,
  fieldName: string,
  modelMap: Map<string, Model>,
  enumMap: Map<string, Enum>,
): any {
  switch (ref.kind) {
    case 'primitive':
      return generatePrimitiveValue(ref.type, ref.format, fieldName);
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
      const item = generateFieldValue(ref.items, fieldName, modelMap, enumMap);
      return [item];
    }
    case 'nullable':
      return generateFieldValue(ref.inner, fieldName, modelMap, enumMap);
    case 'union':
      if (ref.variants.length > 0) {
        return generateFieldValue(ref.variants[0], fieldName, modelMap, enumMap);
      }
      return null;
    case 'map':
      return { key: generateFieldValue(ref.valueType, 'value', modelMap, enumMap) };
  }
}

function generatePrimitiveValue(type: string, format: string | undefined, name: string): any {
  switch (type) {
    case 'string':
      if (format === 'date-time') return '2023-01-01T00:00:00.000Z';
      if (format === 'date') return '2023-01-01';
      if (format === 'uuid') return '00000000-0000-0000-0000-000000000000';
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
