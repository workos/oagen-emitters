import type { ApiSpec, GeneratedFile, Model, Enum, TypeRef } from '@workos/oagen';
import { walkTypeRef } from '@workos/oagen';
import { moduleName } from './naming.js';

/**
 * Generate JSON test fixture files under `tests/fixtures/`. The Rust tests
 * pull these in via `include_str!` so no I/O is required at test time.
 */
export function generateFixtures(spec: ApiSpec): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const modelMap = new Map(spec.models.map((m) => [m.name, m]));
  const enumMap = new Map(spec.enums.map((e) => [e.name, e]));
  const seen = new Set<string>();

  for (const model of spec.models) {
    if (seen.has(model.name)) continue;
    if (model.fields.length === 0) continue;
    seen.add(model.name);

    const fixture = generateModelFixture(model, modelMap, enumMap, new Set());
    const path = `tests/fixtures/${moduleName(model.name)}.json`;
    files.push({
      path,
      content: JSON.stringify(fixture, null, 2) + '\n',
      headerPlacement: 'skip',
    });
  }

  return files;
}

export function generateModelFixture(
  model: Model,
  modelMap: Map<string, Model>,
  enumMap: Map<string, Enum>,
  visiting: Set<string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (visiting.has(model.name)) return result; // Break recursion.
  visiting.add(model.name);

  for (const field of model.fields) {
    if (!field.required) continue;
    result[field.name] = exampleFor(field.type, modelMap, enumMap, visiting, field.name);
  }

  visiting.delete(model.name);
  return result;
}

export function exampleFor(
  type: TypeRef,
  modelMap: Map<string, Model>,
  enumMap: Map<string, Enum>,
  visiting: Set<string>,
  fieldName: string,
): unknown {
  switch (type.kind) {
    case 'primitive':
      switch (type.type) {
        case 'string':
          if (type.format === 'date-time') return '2023-01-01T00:00:00.000Z';
          if (type.format === 'date') return '2023-01-01';
          if (type.format === 'uuid') return '00000000-0000-0000-0000-000000000000';
          if (fieldName === 'id') return 'test_id';
          if (fieldName === 'email') return 'test@example.com';
          return `test_${fieldName}`;
        case 'integer':
          return 0;
        case 'number':
          return 0;
        case 'boolean':
          return false;
        case 'unknown':
          return {};
      }
      return null;
    case 'array':
      return [exampleFor(type.items, modelMap, enumMap, visiting, fieldName)];
    case 'map':
      return {};
    case 'nullable':
      return exampleFor(type.inner, modelMap, enumMap, visiting, fieldName);
    case 'literal':
      return type.value;
    case 'enum': {
      const e = enumMap.get(type.name);
      const v = e?.values?.[0]?.value;
      return v ?? '';
    }
    case 'model': {
      const m = modelMap.get(type.name);
      if (!m) return {};
      return generateModelFixture(m, modelMap, enumMap, visiting);
    }
    case 'union': {
      // Find first model variant; fall back to empty object.
      let result: unknown = null;
      walkTypeRef(type.variants[0]!, {
        primitive: () => {
          result = exampleFor(type.variants[0]!, modelMap, enumMap, visiting, fieldName);
        },
      });
      if (result === null) {
        result = exampleFor(type.variants[0]!, modelMap, enumMap, visiting, fieldName);
      }
      return result;
    }
  }
}
