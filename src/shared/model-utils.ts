import type { Model, Field, TypeRef } from '@workos/oagen';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-ignore -- js-yaml has no type declarations in this project
import { load as yamlLoad } from 'js-yaml';

/**
 * Detect whether a model is a list wrapper -- the standard paginated
 * list envelope with `data` (array), `list_metadata`, and optionally `object: 'list'`.
 *
 * These models are redundant because each language SDK already has its own
 * pagination wrapper, and the runtime handles deserialization.
 */
export function isListWrapperModel(model: Model): boolean {
  const fieldsByName = new Map(model.fields.map((f) => [f.name, f]));

  // Must have a `data` field that is an array type
  const dataField = fieldsByName.get('data');
  if (!dataField) return false;
  if (dataField.type.kind !== 'array') return false;

  // Must have a `list_metadata` field (IR may use snake_case or camelCase)
  const listMetadataField = fieldsByName.get('list_metadata') ?? fieldsByName.get('listMetadata');
  if (!listMetadataField) return false;

  // Optionally has an `object` field with literal value 'list'
  const objectField = fieldsByName.get('object');
  if (objectField) {
    if (objectField.type.kind !== 'literal' || objectField.type.value !== 'list') {
      return false;
    }
  }

  return true;
}

/**
 * Detect whether a model is a list metadata model (e.g., ListMetadata).
 * These models typically have exactly `before` and `after` nullable string fields.
 */
export function isListMetadataModel(model: Model): boolean {
  if (model.fields.length !== 2) return false;

  const fieldsByName = new Map(model.fields.map((f) => [f.name, f]));
  const before = fieldsByName.get('before');
  const after = fieldsByName.get('after');

  if (!before || !after) return false;

  return isNullableString(before) && isNullableString(after);
}

/** Check if a field type is nullable string (nullable<string> or just string). */
function isNullableString(field: Field): boolean {
  if (field.type.kind === 'primitive' && field.type.type === 'string') return true;
  if (field.type.kind === 'nullable' && field.type.inner.kind === 'primitive' && field.type.inner.type === 'string')
    return true;
  return false;
}

// ---------------------------------------------------------------------------
// oneOf / allOf+oneOf flattening
// ---------------------------------------------------------------------------

/**
 * Discover the OpenAPI spec path from CLI args or environment.
 * Returns null if not found.
 */
function discoverSpecPath(): string | null {
  // Check --spec CLI arg
  const args = process.argv;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--spec' && args[i + 1]) return resolve(args[i + 1]);
    if (args[i]?.startsWith('--spec=')) return resolve(args[i].slice('--spec='.length));
  }
  // Check OPENAPI_SPEC_PATH env
  if (process.env.OPENAPI_SPEC_PATH) return resolve(process.env.OPENAPI_SPEC_PATH);
  return null;
}

/** Cached raw spec to avoid re-reading on multiple calls. */
let _rawSpecCache: Record<string, any> | null = null;
let _rawSpecLoaded = false;

function loadRawSpec(): Record<string, any> | null {
  if (_rawSpecLoaded) return _rawSpecCache;
  _rawSpecLoaded = true;
  const specPath = discoverSpecPath();
  if (!specPath || !existsSync(specPath)) return null;
  try {
    const content = readFileSync(specPath, 'utf-8');
    _rawSpecCache = yamlLoad(content) as Record<string, any>;
    return _rawSpecCache;
  } catch {
    return null;
  }
}

/** Look up a schema by name in the raw spec's components/schemas. */
function lookupRawSchema(name: string): Record<string, any> | null {
  const spec = loadRawSpec();
  if (!spec) return null;
  return spec?.components?.schemas?.[name] ?? null;
}

/** Convert a raw OpenAPI type+format to an IR TypeRef. */
function rawSchemaToTypeRef(schema: Record<string, any>): TypeRef {
  if (schema.const !== undefined) {
    return { kind: 'literal', value: schema.const };
  }
  if (schema.enum) {
    // Simple string enum -- represent as primitive string
    return { kind: 'primitive', type: 'string' } as TypeRef;
  }
  if (schema.$ref) {
    const refName = schema.$ref.split('/').pop()!;
    return { kind: 'model', name: refName } as TypeRef;
  }

  // Handle nullable type arrays like [string, null]
  let baseType = schema.type;
  let isNullable = false;
  if (Array.isArray(baseType)) {
    const nonNull = baseType.filter((t: string) => t !== 'null');
    isNullable = baseType.includes('null');
    baseType = nonNull[0] ?? 'string';
  }

  let ref: TypeRef;
  if (baseType === 'object' && schema.properties) {
    // Inline object -- treat as unknown
    ref = { kind: 'primitive', type: 'unknown' } as TypeRef;
  } else if (baseType === 'array' && schema.items) {
    ref = { kind: 'array', items: rawSchemaToTypeRef(schema.items) } as TypeRef;
  } else if (baseType === 'boolean') {
    ref = { kind: 'primitive', type: 'boolean' } as TypeRef;
  } else if (baseType === 'integer' || baseType === 'number') {
    ref = { kind: 'primitive', type: baseType } as TypeRef;
  } else {
    ref = { kind: 'primitive', type: 'string' } as TypeRef;
  }

  if (isNullable) {
    return { kind: 'nullable', inner: ref } as TypeRef;
  }
  return ref;
}

/**
 * Extract fields from a raw OpenAPI object schema.
 * All fields are returned as optional (not required) since they come from
 * oneOf variants where only one variant is active at a time.
 */
function extractFieldsFromRawSchema(schema: Record<string, any>): Field[] {
  const fields: Field[] = [];
  const props = schema.properties ?? {};
  for (const [name, propSchema] of Object.entries(props) as [string, Record<string, any>][]) {
    fields.push({
      name,
      type: rawSchemaToTypeRef(propSchema),
      required: false, // All oneOf variant fields are optional
      description: propSchema.description,
      deprecated: propSchema.deprecated,
    });
  }
  return fields;
}

/**
 * Recursively collect all fields from a oneOf schema, flattening nested
 * allOf+oneOf compositions. All fields are marked optional.
 */
function collectOneOfFields(schema: Record<string, any>): Field[] {
  const allFields: Field[] = [];
  const seenFieldNames = new Set<string>();

  function walkSchema(s: Record<string, any>): void {
    // Direct properties
    if (s.properties) {
      for (const f of extractFieldsFromRawSchema(s)) {
        if (!seenFieldNames.has(f.name)) {
          seenFieldNames.add(f.name);
          allFields.push(f);
        }
      }
    }
    // allOf composition
    if (s.allOf) {
      for (const sub of s.allOf) {
        walkSchema(sub);
      }
    }
    // oneOf composition (flatten all variants)
    if (s.oneOf) {
      for (const variant of s.oneOf) {
        walkSchema(variant);
      }
    }
    // anyOf composition
    if (s.anyOf) {
      for (const variant of s.anyOf) {
        walkSchema(variant);
      }
    }
  }

  walkSchema(schema);
  return allFields;
}

/**
 * Enrich IR models by flattening oneOf/allOf+oneOf variant fields from the raw spec.
 *
 * For models with 0 fields whose raw spec schema is a pure oneOf:
 *   - Collect all variant fields and add them as optional fields.
 *
 * For models whose raw spec schema has allOf containing a oneOf:
 *   - Collect the missing variant fields and add them as optional.
 *
 * Returns a new array of enriched models (original models are not mutated).
 */
export function enrichModelsFromSpec(models: Model[]): Model[] {
  const spec = loadRawSpec();
  if (!spec) return models;

  return models.map((model) => {
    const rawSchema = lookupRawSchema(model.name);
    if (!rawSchema) return model;

    const hasOneOf = rawSchema.oneOf || rawSchema.allOf?.some((s: any) => s.oneOf);
    if (!hasOneOf) return model;

    // Skip schemas with discriminator -- those are intentional unions
    const hasDiscriminator =
      rawSchema.discriminator ||
      rawSchema.oneOf?.some((v: any) => v.discriminator) ||
      rawSchema.allOf?.some((s: any) => s.discriminator || s.oneOf?.some((v: any) => v.discriminator));
    if (hasDiscriminator) return model;

    // Collect all variant fields from the raw schema
    const variantFields = collectOneOfFields(rawSchema);
    if (variantFields.length === 0) return model;

    // Merge variant fields into the existing model, skipping duplicates
    const existingNames = new Set(model.fields.map((f) => f.name));
    const newFields = variantFields.filter((f) => !existingNames.has(f.name));

    if (newFields.length === 0) return model;

    return {
      ...model,
      fields: [...model.fields, ...newFields],
    };
  });
}
