import type { Model, Field, TypeRef, Enum, Service } from '@workos/oagen';
import { toSnakeCase, toUpperSnakeCase, walkTypeRef } from '@workos/oagen';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-ignore -- js-yaml has no type declarations in this project
import { load as yamlLoad } from 'js-yaml';

/**
 * Collect model names referenced as the return type of any non-paginated
 * operation. The list-wrapper skip rule below assumes a wrapper is always
 * replaced by the SDK's pagination machinery — but a few endpoints
 * (e.g. `GET /vault/v1/kv/{id}/versions`) have a list-envelope response
 * shape with no pagination params, so the parser leaves them as a plain
 * model reference. We must still emit those wrappers as regular models;
 * otherwise the generated resource code references an undefined name.
 */
export function collectNonPaginatedResponseModelNames(services: Service[]): Set<string> {
  const names = new Set<string>();
  for (const service of services) {
    for (const op of service.operations) {
      if (op.pagination) continue;
      walkTypeRef(op.response, { model: (r) => names.add(r.name) });
      for (const sr of op.successResponses ?? []) walkTypeRef(sr.type, { model: (r) => names.add(r.name) });
    }
  }
  return names;
}

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

export function loadRawSpec(): Record<string, any> | null {
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

// ---------------------------------------------------------------------------
// Synthetic model / enum collection
// ---------------------------------------------------------------------------

/**
 * Accumulator for synthetic models and enums generated from inline
 * definitions encountered during oneOf flattening.
 */
interface SyntheticCollector {
  models: Model[];
  enums: Array<{
    name: string;
    values: Array<{ value: string; description?: string }>;
  }>;
  /** Track names already used to avoid duplicates. */
  usedNames: Set<string>;
}

function createCollector(): SyntheticCollector {
  return { models: [], enums: [], usedNames: new Set() };
}

/**
 * Singularize a snake_case name for use as an array-item model name.
 * `redirect_uris` -> `redirect_uri`, `scopes` -> `scope`.
 */
function singularizeSnake(name: string): string {
  if (name.endsWith('ies') && name.length > 3) {
    return `${name.slice(0, -3)}y`;
  }
  if (name.endsWith('s') && !name.endsWith('ss')) {
    return name.slice(0, -1);
  }
  return name;
}

// ---------------------------------------------------------------------------
// rawSchemaToTypeRef  -- with synthetic model/enum generation
// ---------------------------------------------------------------------------

/**
 * Convert a raw OpenAPI type+format to an IR TypeRef.
 *
 * When `parentModelName` and `fieldName` are provided, inline objects and
 * enums generate synthetic models/enums instead of degrading to `unknown`
 * or `string`.
 */
function rawSchemaToTypeRef(
  schema: Record<string, any>,
  parentModelName?: string,
  fName?: string,
  collector?: SyntheticCollector,
): TypeRef {
  if (schema.const !== undefined) {
    return { kind: 'literal', value: schema.const };
  }
  if (schema.enum && collector && parentModelName && fName) {
    // Generate a synthetic enum
    const syntheticName = `${parentModelName}_${fName}`;
    if (!collector.usedNames.has(syntheticName) && !collector.usedNames.has(toSnakeCase(syntheticName))) {
      collector.usedNames.add(syntheticName);
      collector.enums.push({
        name: syntheticName,
        values: (schema.enum as string[]).map((v: string) => ({
          value: v,
          description: undefined,
        })),
      });
    }
    return {
      kind: 'enum',
      name: syntheticName,
      values: schema.enum as string[],
    } as TypeRef;
  }
  if (schema.enum) {
    // Simple string enum -- represent as primitive string (no collector)
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
  if (baseType === 'object' && schema.properties && collector && parentModelName && fName) {
    // Inline object -- generate a synthetic model
    const syntheticName = `${parentModelName}_${fName}`;
    if (!collector.usedNames.has(syntheticName) && !collector.usedNames.has(toSnakeCase(syntheticName))) {
      collector.usedNames.add(syntheticName);
      const fields: Field[] = [];
      const requiredSet = new Set<string>(schema.required ?? []);
      for (const [propName, propSchema] of Object.entries(schema.properties) as [string, Record<string, any>][]) {
        fields.push({
          name: propName,
          type: rawSchemaToTypeRef(propSchema, syntheticName, propName, collector),
          required: requiredSet.has(propName),
          description: propSchema.description,
          deprecated: propSchema.deprecated,
        });
      }
      collector.models.push({
        name: syntheticName,
        fields,
        description: schema.description,
      } as Model);
    }
    ref = { kind: 'model', name: syntheticName } as TypeRef;
  } else if (baseType === 'object' && schema.properties) {
    // Inline object -- treat as unknown (no collector)
    ref = { kind: 'primitive', type: 'unknown' } as TypeRef;
  } else if (baseType === 'array' && schema.items) {
    // For array items that are inline objects, use the singular field name
    const itemFieldName = fName ? singularizeSnake(fName) : undefined;
    ref = {
      kind: 'array',
      items: rawSchemaToTypeRef(schema.items, parentModelName, itemFieldName, collector),
    } as TypeRef;
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
function extractFieldsFromRawSchema(
  schema: Record<string, any>,
  parentModelName?: string,
  collector?: SyntheticCollector,
): Field[] {
  const fields: Field[] = [];
  const props = schema.properties ?? {};
  for (const [name, propSchema] of Object.entries(props) as [string, Record<string, any>][]) {
    fields.push({
      name,
      type: rawSchemaToTypeRef(propSchema, parentModelName, name, collector),
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
function collectOneOfFields(
  schema: Record<string, any>,
  parentModelName?: string,
  collector?: SyntheticCollector,
): Field[] {
  const allFields: Field[] = [];
  const seenFieldNames = new Set<string>();

  function walkSchema(s: Record<string, any>): void {
    // Direct properties
    if (s.properties) {
      for (const f of extractFieldsFromRawSchema(s, parentModelName, collector)) {
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

// ---------------------------------------------------------------------------
// Array-item type upgrade
// ---------------------------------------------------------------------------

/**
 * Check if a TypeRef is `unknown` (the degraded type for inline objects).
 */
function isUnknownType(ref: TypeRef): boolean {
  return ref.kind === 'primitive' && (ref as any).type === 'unknown';
}

/**
 * If a field is an `array<unknown>` (or `nullable<array<unknown>>`) and the
 * raw spec defines inline object/enum items, replace the item type with a
 * synthetic model/enum. Returns the original field unchanged when no upgrade
 * is needed.
 */
function upgradeArrayItemType(
  field: Field,
  rawSchema: Record<string, any>,
  parentModelName: string,
  collector: SyntheticCollector,
): Field {
  // Unwrap nullable to find the array
  let arrayRef: TypeRef | null = null;
  let isNullableWrapper = false;
  if (field.type.kind === 'array') {
    arrayRef = field.type;
  } else if (field.type.kind === 'nullable' && field.type.inner.kind === 'array') {
    arrayRef = field.type.inner;
    isNullableWrapper = true;
  }
  if (!arrayRef || arrayRef.kind !== 'array') return field;
  if (!isUnknownType(arrayRef.items)) return field;

  // Look up the raw spec for this field
  const rawProp = rawSchema.properties?.[field.name];
  if (!rawProp) return field;

  // Handle the case where the raw property is inside a nullable type array
  let rawArraySchema = rawProp;
  if (Array.isArray(rawProp.type)) {
    const nonNull = rawProp.type.filter((t: string) => t !== 'null');
    if (nonNull[0] === 'array') {
      rawArraySchema = rawProp;
    }
  }
  if (rawArraySchema.type !== 'array' && !(Array.isArray(rawArraySchema.type) && rawArraySchema.type.includes('array')))
    return field;
  if (!rawArraySchema.items) return field;

  // Generate a proper TypeRef from the raw items schema
  const itemFieldName = singularizeSnake(field.name);
  const newItemRef = rawSchemaToTypeRef(rawArraySchema.items, parentModelName, itemFieldName, collector);
  if (isUnknownType(newItemRef)) return field;

  const newArrayRef: TypeRef = { kind: 'array', items: newItemRef } as TypeRef;
  const newType: TypeRef = isNullableWrapper ? ({ kind: 'nullable', inner: newArrayRef } as TypeRef) : newArrayRef;

  return { ...field, type: newType };
}

// ---------------------------------------------------------------------------
// Module-level store for synthetic enums produced during enrichment.
// Consumed by `getSyntheticEnums()` after `enrichModelsFromSpec` runs.
// ---------------------------------------------------------------------------
let _lastSyntheticEnums: Enum[] = [];

/**
 * Return the synthetic enums generated during the last call to
 * `enrichModelsFromSpec`. Call this after enrichment to merge them into the
 * enum generation phase.
 */
export function getSyntheticEnums(): Enum[] {
  return _lastSyntheticEnums;
}

// ---------------------------------------------------------------------------
// Implicit discriminator detection
// ---------------------------------------------------------------------------

/**
 * Find a property name that has a `const` value in ALL oneOf variants.
 * Returns null if no shared const property is found.
 */
function findSharedConstProperty(oneOfSchemas: Record<string, any>[]): string | null {
  if (oneOfSchemas.length === 0) return null;

  const first = oneOfSchemas[0];
  if (!first.properties) return null;

  // Candidate properties from the first variant that have const values
  const candidates = Object.keys(first.properties).filter((name) => first.properties[name].const !== undefined);

  // Return the first candidate that has const values in ALL variants
  for (const candidate of candidates) {
    const allHaveConst = oneOfSchemas.every((variant) => variant.properties?.[candidate]?.const !== undefined);
    if (allHaveConst) return candidate;
  }

  return null;
}

/**
 * Build a discriminator mapping from const values to IR model names.
 * For each oneOf variant's const value on `discProperty`, find the IR model
 * whose field with the same name is a Literal type with that value.
 */
function buildDiscriminatorMapping(
  discProperty: string,
  oneOfSchemas: Record<string, any>[],
  models: Model[],
  parentModelName: string,
): Record<string, string> {
  const mapping: Record<string, string> = {};

  for (const variant of oneOfSchemas) {
    const constValue = variant.properties?.[discProperty]?.const;
    if (constValue === undefined) continue;

    const variantModel = models.find(
      (m) =>
        m.name !== parentModelName &&
        m.fields.some(
          (f) => f.name === discProperty && f.type.kind === 'literal' && (f.type as any).value === constValue,
        ),
    );
    if (variantModel) {
      mapping[String(constValue)] = variantModel.name;
    }
  }

  return mapping;
}

/**
 * Detect implicit discriminators on models without full oneOf flattening.
 * Returns a new array with discriminator annotations; models without
 * discriminators are returned as-is. Use this when you need discriminator
 * info but don't want the side-effects of full enrichment (synthetic
 * models/enums, field flattening).
 */
export function detectDiscriminators(models: Model[]): Model[] {
  const spec = loadRawSpec();
  if (!spec) return models;

  let changed = false;
  const result = models.map((model) => {
    if ((model as any).discriminator) return model;

    const rawSchema = lookupRawSchema(model.name);
    if (!rawSchema) return model;

    const oneOfContainer = rawSchema.allOf?.find((s: any) => s.oneOf);
    if (!oneOfContainer?.oneOf || oneOfContainer.oneOf.length === 0) return model;

    const discProperty = findSharedConstProperty(oneOfContainer.oneOf);
    if (!discProperty) return model;

    const mapping = buildDiscriminatorMapping(discProperty, oneOfContainer.oneOf, models, model.name);
    if (Object.keys(mapping).length === 0) return model;

    changed = true;
    return {
      ...model,
      fields: [],
      discriminator: { property: discProperty, mapping },
    };
  });

  return changed ? result : models;
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
 * Inline objects and enums in oneOf branches are promoted to synthetic
 * models/enums instead of degrading to `object` / `string`.
 *
 * Returns a new array of enriched models (original models are not mutated).
 * Synthetic enums are stored internally; retrieve them via `getSyntheticEnums()`.
 */
export function enrichModelsFromSpec(models: Model[]): Model[] {
  const spec = loadRawSpec();
  if (!spec) {
    _lastSyntheticEnums = [];
    return models;
  }

  const collector = createCollector();
  // Avoid name collisions with existing models (check both PascalCase and
  // snake_case to prevent synthetic models from shadowing existing ones when
  // they share a file name, e.g. FooBar vs Foo_bar -> foo_bar).
  for (const m of models) {
    collector.usedNames.add(m.name);
    collector.usedNames.add(toSnakeCase(m.name));
  }

  const enriched = models.map((model) => {
    const rawSchema = lookupRawSchema(model.name);
    if (!rawSchema) return model;

    const hasOneOf = rawSchema.oneOf || rawSchema.allOf?.some((s: any) => s.oneOf);
    if (!hasOneOf) return model;

    // Skip schemas with explicit discriminator -- those are intentional unions
    const hasDiscriminator =
      rawSchema.discriminator ||
      rawSchema.oneOf?.some((v: any) => v.discriminator) ||
      rawSchema.allOf?.some((s: any) => s.discriminator || s.oneOf?.some((v: any) => v.discriminator));
    if (hasDiscriminator) return model;

    // Detect implicit discriminators: allOf+oneOf where all variants share a
    // property with const values (e.g., EventSchema with event: const: "user.created").
    // When found, attach a discriminator mapping and clear fields so the emitter
    // generates a dispatcher class instead of a flat dataclass.
    const oneOfContainer = rawSchema.allOf?.find((s: any) => s.oneOf);
    if (oneOfContainer?.oneOf && oneOfContainer.oneOf.length > 0) {
      const discProperty = findSharedConstProperty(oneOfContainer.oneOf);
      if (discProperty) {
        const mapping = buildDiscriminatorMapping(discProperty, oneOfContainer.oneOf, models, model.name);
        if (Object.keys(mapping).length > 0) {
          return {
            ...model,
            fields: [],
            discriminator: { property: discProperty, mapping },
          };
        }
      }
    }

    // Collect all variant fields from the raw schema, generating synthetic
    // models/enums for inline definitions along the way.
    const variantFields = collectOneOfFields(rawSchema, model.name, collector);
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

  // Second pass: fix array fields whose items degraded to `unknown` in the
  // IR but are actually inline objects or enums in the raw spec.
  const enriched2 = enriched.map((model) => {
    const rawSchema = lookupRawSchema(model.name);
    if (!rawSchema?.properties) return model;

    let modified = false;
    const newFields = model.fields.map((field) => {
      const upgraded = upgradeArrayItemType(field, rawSchema, model.name, collector);
      if (upgraded !== field) modified = true;
      return upgraded;
    });

    return modified ? { ...model, fields: newFields } : model;
  });

  // Convert synthetic enum collector entries to proper Enum objects. PHP's
  // emitter (and others built on top of `EnumValue.name`) crash when this
  // field is missing, so derive it from the value via the same upper-snake
  // transform the parser uses for declared enums.
  _lastSyntheticEnums = collector.enums.map((e) => ({
    name: e.name,
    values: e.values.map((v) => ({
      name: toUpperSnakeCase(String(v.value)),
      value: v.value,
      description: v.description,
    })),
  })) as Enum[];

  // Append synthetic models, skipping those whose snake_case name collides
  // with an existing model (prevents broken TypeAlias self-imports).
  const existingSnakeNames = new Set(enriched2.map((m) => toSnakeCase(m.name)));
  const filteredSynthetic = collector.models.filter((m) => !existingSnakeNames.has(toSnakeCase(m.name)));
  return [...enriched2, ...filteredSynthetic];
}
