import type { ApiSpec, GeneratedFile, Model, Enum, TypeRef, EmitterContext } from '@workos/oagen';
import { walkTypeRef } from '@workos/oagen';
import { moduleName } from './naming.js';
import { isModelInScope } from '../shared/resolved-ops.js';

/**
 * Generate JSON test fixture files under `tests/fixtures/`. The Rust tests
 * pull these in via `include_str!` so no I/O is required at test time.
 *
 * A fixture is a per-model FILE, so under a scoped (`--services`) run it is
 * gated to the SELECTED set alone ({@link isModelInScope}) — exactly like the
 * per-model `.rs` file writer in models.ts. Out-of-scope models' fixtures are
 * left byte-for-byte untouched on disk (a scoped run must regenerate ONLY the
 * selected services' files). We deliberately do NOT retain prior-on-disk
 * fixtures via `fileExistsAfterRun`: unlike a barrel/`mod.rs` there is no
 * aggregate that must reference every fixture, and scoped test files only
 * `include_str!` fixtures for in-scope models, so re-emitting an out-of-scope
 * fixture would only rewrite another service's file. A full run (scoping
 * inert) still emits every fixture.
 */
export function generateFixtures(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const modelMap = new Map(spec.models.map((m) => [m.name, m]));
  const enumMap = new Map(spec.enums.map((e) => [e.name, e]));
  const seen = new Set<string>();

  for (const model of spec.models) {
    if (seen.has(model.name)) continue;
    if (model.fields.length === 0) continue;
    seen.add(model.name);

    const path = `tests/fixtures/${moduleName(model.name)}.json`;
    if (!isModelInScope(model.name, ctx)) continue;

    const fixture = generateModelFixture(model, modelMap, enumMap, new Set());
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
    // Prefer the spec `example` value when it is shape-compatible with the
    // declared type. Falls back to the placeholder generator when no example
    // is provided or when the example would not deserialize cleanly.
    const fromExample = exampleFromSpec(field.example, field.type, enumMap);
    result[field.name] =
      fromExample !== undefined ? fromExample : exampleFor(field.type, modelMap, enumMap, visiting, field.name);
  }

  if (model.discriminator) {
    const [firstValue, variantName] = Object.entries(model.discriminator.mapping)[0];
    result[model.discriminator.property] = firstValue;
    const variantModel = modelMap.get(variantName);
    if (variantModel) {
      for (const field of variantModel.fields) {
        if (!(field.name in result)) {
          if (!field.required) continue;
          const fromExample = exampleFromSpec(field.example, field.type, enumMap);
          result[field.name] =
            fromExample !== undefined ? fromExample : exampleFor(field.type, modelMap, enumMap, visiting, field.name);
        }
      }
    }
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

/**
 * Resolve a spec-provided `example` against a TypeRef and return the value to
 * embed in the fixture, or `undefined` when the example cannot be used safely.
 *
 * "Safely" means the value would round-trip through serde to the generated
 * Rust type. We deliberately only accept primitives, enum string/number
 * values, and homogenous arrays of those; nested object examples (which the
 * spec sometimes supplies as illustrative metadata blobs) are skipped because
 * they rarely match the strict struct shape Rust expects.
 */
export function exampleFromSpec(example: unknown, type: TypeRef, enumMap: Map<string, Enum>): unknown {
  if (example === undefined) return undefined;
  // Spec authors sometimes use `null` as a sentinel; let placeholder gen
  // handle nullable types so we don't emit `null` for required fields.
  if (example === null) return undefined;
  return matchExampleToType(example, type, enumMap);
}

function matchExampleToType(value: unknown, type: TypeRef, enumMap: Map<string, Enum>): unknown {
  switch (type.kind) {
    case 'primitive':
      return matchPrimitive(value, type.type);
    case 'literal':
      return value === type.value ? value : undefined;
    case 'enum': {
      const e = enumMap.get(type.name);
      if (!e) return undefined;
      const ok = e.values.some((v) => v.value === value);
      return ok ? value : undefined;
    }
    case 'array': {
      if (!Array.isArray(value)) return undefined;
      const out: unknown[] = [];
      for (const item of value) {
        const matched = matchExampleToType(item, type.items, enumMap);
        if (matched === undefined) return undefined;
        out.push(matched);
      }
      // Empty arrays are valid but unhelpful in fixtures — fall back so the
      // placeholder generator can produce a one-element example.
      if (out.length === 0) return undefined;
      return out;
    }
    case 'nullable':
      return matchExampleToType(value, type.inner, enumMap);
    case 'map':
      // Map examples are usually free-form metadata blobs that match
      // `HashMap<String, _>`; only accept plain objects with string-keyed values.
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
      return value;
    case 'union': {
      for (const variant of type.variants) {
        const matched = matchExampleToType(value, variant, enumMap);
        if (matched !== undefined) return matched;
      }
      return undefined;
    }
    case 'model':
      // Model-shaped examples are too risky to copy verbatim: they rarely
      // supply every required field and may use wire names that don't align
      // with the generated struct. Let the recursive generator handle them.
      return undefined;
  }
}

function matchPrimitive(value: unknown, primitive: 'string' | 'integer' | 'number' | 'boolean' | 'unknown'): unknown {
  switch (primitive) {
    case 'string':
      return typeof value === 'string' ? value : undefined;
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
    case 'number':
      return typeof value === 'number' ? value : undefined;
    case 'boolean':
      return typeof value === 'boolean' ? value : undefined;
    case 'unknown':
      // `unknown` deserialises to `serde_json::Value`, so any JSON value works.
      return value;
  }
}
