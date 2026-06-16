import type { EmitterContext, GeneratedFile, Model } from '@workos/oagen';
import { toPascalCase, toCamelCase } from '@workos/oagen';
import { loadRawSpec } from '../shared/model-utils.js';
import { fileName, wireInterfaceName } from './naming.js';
import { createServiceDirResolver } from './utils.js';

/**
 * Discriminated `allOf [base, oneOf [variant, …]]` model support for Node.
 *
 * When a component schema matches that shape and every oneOf branch pins the
 * same property to a distinct string-const value, we emit:
 *
 *   - One interface per variant, holding the base fields plus that variant's
 *     specific fields (with the discriminator typed as the const literal).
 *   - A type alias union that ties the variants together.
 *
 * Doing this from raw spec — rather than from the IR — sidesteps the parser's
 * `detectAllOfVariantDiscriminator` failing on variants whose properties live
 * behind another `allOf` (the OAuth branch of `ConnectApplication`). That
 * limitation also breaks Python's flat dataclass output; fixing the parser is
 * the proper long-term move but riskier because it would change every
 * emitter's view of `ConnectApplication` at once. This module is contained to
 * the Node emitter.
 */

interface RawSchema {
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  format?: string;
  description?: string;
  required?: string[];
  properties?: Record<string, RawSchema>;
  items?: RawSchema;
  allOf?: RawSchema[];
  oneOf?: RawSchema[];
  anyOf?: RawSchema[];
  $ref?: string;
}

interface FieldSpec {
  name: string;
  description?: string;
  required: boolean;
  /** Domain (camelCase) TS type. */
  domainType: string;
  /** Wire (snake_case) TS type. */
  wireType: string;
  /** Model deps for imports — IR names (PascalCase). */
  modelDeps: Set<string>;
  /** Whether the field requires date parsing/formatting (format: date-time). */
  hasDateTime: boolean;
  /** Inline string-enum values, rendered as a literal union (e.g. `'a' | 'b'`). */
  enumValues?: string[];
}

interface VariantSpec {
  /** Domain interface name suffix, e.g. `OAuth`, `M2M`. */
  nameSuffix: string;
  /** Discriminator value, e.g. `oauth`, `m2m`, or `true`/`false`. */
  discriminatorValue: string;
  /** Whether the discriminator value is a boolean literal (emit unquoted). */
  discriminatorIsBoolean?: boolean;
  /** Fields specific to this variant (excluding the discriminator). */
  fields: FieldSpec[];
}

interface DiscriminatedShape {
  modelName: string;
  /** Base fields common to every variant. */
  baseFields: FieldSpec[];
  /** Field name on the wire (snake_case). */
  discriminatorProperty: string;
  /** Field name in domain (camelCase). */
  discriminatorPropertyDomain: string;
  /** Description from the OpenAPI spec, if present. */
  discriminatorDescription?: string;
  variants: VariantSpec[];
  /**
   * Set for pure `oneOf` schemas (no `allOf` base wrapper). These are emitted
   * as an inline anonymous union (`type X = { … } | { … }`) rather than as a
   * set of named variant interfaces, which keeps two-variant unions — e.g. the
   * boolean-discriminated `active: true | false` token response — readable.
   */
  inlineUnion?: boolean;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export function detectDiscriminatedShape(
  modelName: string,
  rawSchemas: Record<string, RawSchema>,
): DiscriminatedShape | null {
  const schema = rawSchemas[modelName];
  if (!schema) return null;

  let baseObject: RawSchema | null = null;
  let oneOfVariants: RawSchema[] | null = null;
  let inlineUnion = false;

  if (schema.allOf) {
    // `allOf [base, oneOf [variant, …]]`: the base contributes shared fields;
    // the oneOf contributes variant-specific fields. Emitted as named variant
    // interfaces (one per variant) plus a union alias.
    for (const member of schema.allOf) {
      const resolved = resolveRef(member, rawSchemas);
      if (resolved.oneOf) {
        if (oneOfVariants) return null; // unexpected: multiple oneOf branches at top
        oneOfVariants = resolved.oneOf;
      } else if (resolved.properties) {
        baseObject = mergeBase(baseObject, resolved);
      } else if (resolved.allOf) {
        // Nested allOf at top: walk it
        const nestedBase = flattenObjectAllOf(resolved, rawSchemas);
        baseObject = mergeBase(baseObject, nestedBase);
      }
    }
  } else if (schema.oneOf && schema.oneOf.length >= 2) {
    // Pure `oneOf` (no base wrapper): every branch must be a plain inline
    // object so a shared const discriminator can tell them apart. This is the
    // discriminated-union shape the parser would otherwise flatten into a
    // single all-optional interface (e.g. the boolean-discriminated token
    // response `{ active: true; … } | { active: false; … }`). The
    // mutually-exclusive-field-group oneOf (no shared discriminator) is left
    // alone by the `findSharedDiscriminator` check below.
    const allInlineObjects = schema.oneOf.every(
      (v) => v.properties && !v.$ref && (v.type === 'object' || !v.type) && !v.allOf && !v.oneOf,
    );
    if (!allInlineObjects) return null;
    oneOfVariants = schema.oneOf;
    inlineUnion = true;
  } else {
    return null;
  }
  if (!oneOfVariants || oneOfVariants.length < 2) return null;

  // Flatten each variant through its own allOf to get the effective property
  // set. Variants that themselves embed a nested `oneOf` (e.g. the OAuth
  // first-party / dynamically-registered sub-variants) merge into a single
  // shape: any field appearing in any sub-branch is included, required only
  // when present in every sub-branch.
  const flattenedVariants = oneOfVariants.map((v) => flattenVariant(v, rawSchemas));

  // Find a shared discriminator: a property whose value is a distinct
  // string-const on every variant. Has to be in `alwaysProperties` of every
  // variant.
  const discProp = findSharedDiscriminator(flattenedVariants);
  if (!discProp) return null;

  // Build variant specs.
  const variants: VariantSpec[] = flattenedVariants
    .map((fv): VariantSpec | null => {
      const discValue = readConst(fv.alwaysProperties.get(discProp));
      if (discValue === null) return null;
      return {
        nameSuffix: variantNameSuffix(String(discValue)),
        discriminatorValue: String(discValue),
        discriminatorIsBoolean: typeof discValue === 'boolean',
        fields: variantFields(fv, discProp, modelName),
      };
    })
    .filter((v): v is VariantSpec => v !== null);

  if (variants.length !== flattenedVariants.length) return null;

  const baseFields = baseObject ? collectObjectFields(baseObject, modelName) : [];

  const discriminatorDescription = flattenedVariants[0].alwaysProperties.get(discProp)?.description;

  return {
    modelName,
    baseFields,
    discriminatorProperty: discProp,
    discriminatorPropertyDomain: toCamelCase(discProp),
    discriminatorDescription,
    variants,
    inlineUnion,
  };
}

function mergeBase(prev: RawSchema | null, next: RawSchema): RawSchema {
  if (!prev) return next;
  return {
    type: 'object',
    properties: { ...prev.properties, ...next.properties },
    required: [...new Set([...(prev.required ?? []), ...(next.required ?? [])])],
  };
}

function flattenObjectAllOf(schema: RawSchema, rawSchemas: Record<string, RawSchema>): RawSchema {
  let merged: RawSchema = { type: 'object', properties: {}, required: [] };
  for (const sub of schema.allOf ?? []) {
    const resolved = resolveRef(sub, rawSchemas);
    if (resolved.properties) {
      merged = mergeBase(merged, resolved);
    } else if (resolved.allOf) {
      merged = mergeBase(merged, flattenObjectAllOf(resolved, rawSchemas));
    }
    // Ignore oneOf inside base allOf — that's a different code path.
  }
  return merged;
}

interface FlattenedVariant {
  /** Properties present unconditionally (in every sub-branch of nested oneOf). */
  alwaysProperties: Map<string, RawSchema>;
  /** Properties present in at least one sub-branch but not all. */
  optionalProperties: Map<string, RawSchema>;
  /** Required field names — must be required in every sub-branch to remain required. */
  required: Set<string>;
}

function flattenVariant(variant: RawSchema, rawSchemas: Record<string, RawSchema>): FlattenedVariant {
  const resolved = resolveRef(variant, rawSchemas);

  // Leaf: plain object with properties.
  if (resolved.properties && !resolved.allOf && !resolved.oneOf) {
    const props = new Map<string, RawSchema>();
    for (const [k, v] of Object.entries(resolved.properties)) props.set(k, v);
    return {
      alwaysProperties: props,
      optionalProperties: new Map(),
      required: new Set(resolved.required ?? []),
    };
  }

  if (resolved.allOf) {
    // Merge each allOf member's flattened view.
    let agg: FlattenedVariant = {
      alwaysProperties: new Map(),
      optionalProperties: new Map(),
      required: new Set(),
    };
    let initialized = false;
    for (const member of resolved.allOf) {
      const memberView = flattenVariant(member, rawSchemas);
      if (!initialized) {
        agg = {
          alwaysProperties: new Map(memberView.alwaysProperties),
          optionalProperties: new Map(memberView.optionalProperties),
          required: new Set(memberView.required),
        };
        initialized = true;
        continue;
      }
      // allOf is intersection — union of properties, union of required.
      for (const [k, v] of memberView.alwaysProperties) {
        if (!agg.alwaysProperties.has(k) && !agg.optionalProperties.has(k)) {
          agg.alwaysProperties.set(k, v);
        }
      }
      for (const [k, v] of memberView.optionalProperties) {
        if (!agg.alwaysProperties.has(k) && !agg.optionalProperties.has(k)) {
          agg.optionalProperties.set(k, v);
        }
      }
      for (const r of memberView.required) agg.required.add(r);
    }
    return agg;
  }

  if (resolved.oneOf) {
    // Merge each oneOf member's flattened view — union the properties, but
    // demote anything not present in EVERY member to optional.
    const memberViews = resolved.oneOf.map((m) => flattenVariant(m, rawSchemas));
    const allKeys = new Set<string>();
    for (const view of memberViews) {
      for (const k of view.alwaysProperties.keys()) allKeys.add(k);
      for (const k of view.optionalProperties.keys()) allKeys.add(k);
    }
    const always = new Map<string, RawSchema>();
    const optional = new Map<string, RawSchema>();
    const requiredEverywhere = new Set<string>();
    for (const key of allKeys) {
      const inAll = memberViews.every((v) => v.alwaysProperties.has(key) || v.optionalProperties.has(key));
      const schemas = memberViews
        .map((v) => v.alwaysProperties.get(key) ?? v.optionalProperties.get(key))
        .filter((s): s is RawSchema => Boolean(s));
      const merged = mergeFieldSchemas(schemas);
      if (inAll) {
        always.set(key, merged);
      } else {
        optional.set(key, merged);
      }
      if (inAll && memberViews.every((v) => v.required.has(key))) {
        requiredEverywhere.add(key);
      }
    }
    return {
      alwaysProperties: always,
      optionalProperties: optional,
      required: requiredEverywhere,
    };
  }

  return {
    alwaysProperties: new Map(),
    optionalProperties: new Map(),
    required: new Set(),
  };
}

function mergeFieldSchemas(schemas: RawSchema[]): RawSchema {
  if (schemas.length === 0) return {};
  if (schemas.length === 1) return schemas[0];

  // If every schema is a boolean const, widen to boolean.
  const boolConsts = schemas.every((s) => s.type === 'boolean' && typeof s.const === 'boolean');
  if (boolConsts) {
    return { type: 'boolean', description: schemas[0].description };
  }

  // If every schema is a string const with differing values, widen to a plain
  // string (the variant interface narrows it back to the specific literal via
  // its discriminator value, so we lose nothing here).
  const stringConsts = schemas.every((s) => s.type === 'string' && typeof s.const === 'string');
  if (stringConsts) {
    const values = schemas.map((s) => s.const as string);
    if (new Set(values).size === 1) {
      return schemas[0];
    }
    return { type: 'string', description: schemas[0].description };
  }

  return schemas[0];
}

function findSharedDiscriminator(variants: FlattenedVariant[]): string | null {
  if (variants.length < 2) return null;
  const firstAlways = variants[0].alwaysProperties;
  for (const propName of firstAlways.keys()) {
    let allConst = true;
    const values: string[] = [];
    for (const v of variants) {
      const schema = v.alwaysProperties.get(propName);
      const val = readConst(schema);
      if (val === null) {
        allConst = false;
        break;
      }
      values.push(String(val));
    }
    if (allConst && new Set(values).size === values.length) {
      return propName;
    }
  }
  return null;
}

/**
 * Read a discriminator value pinned by `const` (or a single-value `enum`).
 * Supports string and boolean literals — the latter drives the
 * `active: true | false` style token response union.
 */
function readConst(schema: RawSchema | undefined | null): string | boolean | null {
  if (!schema) return null;
  if (typeof schema.const === 'string' || typeof schema.const === 'boolean') return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length === 1) {
    const only = schema.enum[0];
    if (typeof only === 'string' || typeof only === 'boolean') return only;
  }
  return null;
}

function variantNameSuffix(constValue: string): string {
  return toPascalCase(constValue);
}

// ---------------------------------------------------------------------------
// Field extraction
// ---------------------------------------------------------------------------

function collectObjectFields(schema: RawSchema, parentName: string): FieldSpec[] {
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const fields: FieldSpec[] = [];
  for (const [name, propSchema] of Object.entries(props)) {
    fields.push(buildField(name, propSchema, required.has(name), parentName));
  }
  return fields;
}

function variantFields(fv: FlattenedVariant, discriminatorProperty: string, parentName: string): FieldSpec[] {
  const fields: FieldSpec[] = [];
  for (const [name, propSchema] of fv.alwaysProperties) {
    if (name === discriminatorProperty) continue;
    fields.push(buildField(name, propSchema, fv.required.has(name), parentName));
  }
  for (const [name, propSchema] of fv.optionalProperties) {
    if (name === discriminatorProperty) continue;
    fields.push(buildField(name, propSchema, false, parentName));
  }
  return fields;
}

function buildField(rawName: string, schema: RawSchema, required: boolean, parentName: string): FieldSpec {
  const modelDeps = new Set<string>();
  const domainType = rawSchemaToTS(schema, parentName, rawName, false, modelDeps);
  const wireType = rawSchemaToTS(schema, parentName, rawName, true, modelDeps);
  const enumValues =
    Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.every((e) => typeof e === 'string')
      ? (schema.enum as string[])
      : undefined;
  return {
    name: rawName,
    description: schema.description,
    required,
    domainType,
    wireType,
    modelDeps,
    hasDateTime: schemaHasDateTime(schema),
    enumValues,
  };
}

function schemaHasDateTime(schema: RawSchema): boolean {
  if (schema.format === 'date-time' && typeOf(schema) === 'string') return true;
  if (schema.items && schemaHasDateTime(schema.items)) return true;
  return false;
}

function typeOf(schema: RawSchema): string | undefined {
  if (Array.isArray(schema.type)) {
    return schema.type.find((t) => t !== 'null');
  }
  return schema.type;
}

function isNullable(schema: RawSchema): boolean {
  return Array.isArray(schema.type) && schema.type.includes('null');
}

function rawSchemaToTS(
  schema: RawSchema,
  parentName: string,
  fieldName: string,
  isWire: boolean,
  modelDeps: Set<string>,
): string {
  if (schema.$ref) {
    const refName = schema.$ref.split('/').pop()!;
    modelDeps.add(refName);
    const domain = toPascalCase(refName);
    return isWire ? wireInterfaceName(domain) : domain;
  }
  if (typeof schema.const === 'string') {
    return `'${schema.const}'`;
  }
  if (typeof schema.const === 'boolean') {
    return String(schema.const);
  }
  const baseType = typeOf(schema);
  const nullable = isNullable(schema);
  let core: string;
  if (baseType === 'string') {
    core = !isWire && schema.format === 'date-time' ? 'Date' : 'string';
  } else if (baseType === 'integer' || baseType === 'number') {
    core = 'number';
  } else if (baseType === 'boolean') {
    core = 'boolean';
  } else if (baseType === 'array' && schema.items) {
    const items = rawSchemaToTS(schema.items, parentName, singularize(fieldName), isWire, modelDeps);
    core = `${parenthesizeUnion(items)}[]`;
  } else if (baseType === 'object' && schema.properties) {
    // Inline object — refer to the synthetic model name that
    // `enrichModelsFromSpec` produces. Pattern: `<Parent>_<fieldSingular>`.
    const synthName = `${parentName}_${singularize(fieldName)}`;
    modelDeps.add(synthName);
    const domain = toPascalCase(synthName);
    return isWire ? wireInterfaceName(domain) : domain;
  } else {
    core = 'unknown';
  }
  return nullable ? `${core} | null` : core;
}

function parenthesizeUnion(t: string): string {
  return /\s\|\s/.test(t) ? `(${t})` : t;
}

function singularize(name: string): string {
  if (name.endsWith('ies') && name.length > 3) return `${name.slice(0, -3)}y`;
  if (name.endsWith('s') && !name.endsWith('ss')) return name.slice(0, -1);
  return name;
}

function resolveRef(schema: RawSchema, rawSchemas: Record<string, RawSchema>): RawSchema {
  if (!schema.$ref) return schema;
  const segments = schema.$ref.split('/');
  const name = segments[segments.length - 1];
  return rawSchemas[name] ?? schema;
}

// ---------------------------------------------------------------------------
// Public emission entry points
// ---------------------------------------------------------------------------

export interface DiscriminatedPlan {
  shape: DiscriminatedShape;
  modelDir: string;
  /** Maps raw spec schema names to their resolved service directories. */
  depDirMap: Map<string, string>;
}

export function planDiscriminatedModels(models: Model[], ctx: EmitterContext): Map<string, DiscriminatedPlan> {
  const plans = new Map<string, DiscriminatedPlan>();
  const spec = loadRawSpec();
  if (!spec?.components?.schemas) return plans;
  const rawSchemas = spec.components.schemas as Record<string, RawSchema>;
  const { modelToService, resolveDir } = createServiceDirResolver(models, ctx.spec.services, ctx);

  // Build a lookup from IR model names to their resolved service directories.
  const irModelDir = new Map<string, string>();
  for (const model of models) {
    irModelDir.set(model.name, resolveDir(modelToService.get(model.name)));
  }

  // Map raw spec schema names to service directories so discriminated model
  // imports can point to the correct cross-service path. Raw names may differ
  // from IR names due to schemaNameTransform (e.g. Dto stripping).
  const depDirMap = new Map<string, string>();
  for (const rawName of Object.keys(rawSchemas)) {
    if (irModelDir.has(rawName)) {
      depDirMap.set(rawName, irModelDir.get(rawName)!);
      continue;
    }
    const stripped = rawName.replace(/Dto/g, '').replace(/DTO/g, '').replace(/Json$/, '');
    if (stripped !== rawName && irModelDir.has(stripped)) {
      depDirMap.set(rawName, irModelDir.get(stripped)!);
    }
  }

  for (const model of models) {
    const shape = detectDiscriminatedShape(model.name, rawSchemas);
    if (!shape) continue;
    // Skip models whose variant field dependencies can't all be resolved to
    // existing interface files. EventSchema, for instance, references models
    // from many services that may not have generated files yet.
    const allDeps = new Set<string>();
    for (const field of shape.baseFields) {
      for (const d of field.modelDeps) allDeps.add(d);
    }
    for (const variant of shape.variants) {
      for (const field of variant.fields) {
        for (const d of field.modelDeps) allDeps.add(d);
      }
    }
    // `modelDeps` may carry an inline-object synthetic name in raw form
    // (`Parent_field`) while the resolution maps are keyed by the PascalCase IR
    // model name (`ParentField`). Resolve either spelling before deciding a dep
    // is unreachable — otherwise inline-object variant fields (e.g. the token
    // response's nested `access_token`) would wrongly drop the whole plan.
    const resolvable = (dep: string): boolean =>
      depDirMap.has(dep) ||
      irModelDir.has(dep) ||
      depDirMap.has(toPascalCase(dep)) ||
      irModelDir.has(toPascalCase(dep));
    const hasUnresolvableDeps = [...allDeps].some((dep) => !resolvable(dep));
    if (hasUnresolvableDeps) continue;
    const modelDir = resolveDir(modelToService.get(model.name));
    plans.set(model.name, { shape, modelDir, depDirMap });
  }
  return plans;
}

export function generateDiscriminatedFiles(
  plans: Map<string, DiscriminatedPlan>,
  ctx: EmitterContext,
): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  for (const plan of plans.values()) {
    files.push(buildInterfaceFile(plan, ctx));
    files.push(buildSerializerFile(plan, ctx));
  }
  return files;
}

function buildInterfaceFile(plan: DiscriminatedPlan, _ctx: EmitterContext): GeneratedFile {
  const { shape, modelDir } = plan;
  if (shape.inlineUnion) return buildInlineUnionFile(plan);
  const domain = toPascalCase(shape.modelName);
  const wire = wireInterfaceName(domain);
  const lines: string[] = [];

  const imports = collectImports(plan);
  if (imports.length > 0) {
    for (const imp of imports) {
      lines.push(`import type { ${imp.symbols.join(', ')} } from '${imp.path}';`);
    }
    lines.push('');
  }

  // Variant interfaces (domain + wire) plus a union type alias.
  for (const variant of shape.variants) {
    const variantDomain = `${domain}${variant.nameSuffix}`;
    const variantWire = `${variantDomain}Response`;
    lines.push(...buildInterfaceBody(variantDomain, shape, variant, /*isWire*/ false));
    lines.push('');
    lines.push(...buildInterfaceBody(variantWire, shape, variant, /*isWire*/ true));
    lines.push('');
  }

  // Union aliases
  const variantNames = shape.variants.map((v) => `${domain}${v.nameSuffix}`);
  lines.push(`export type ${domain} = ${variantNames.join(' | ')};`);
  lines.push('');
  const wireVariantNames = shape.variants.map((v) => `${domain}${v.nameSuffix}Response`);
  lines.push(`export type ${wire} = ${wireVariantNames.join(' | ')};`);

  return {
    path: `src/${modelDir}/interfaces/${fileName(shape.modelName)}.interface.ts`,
    content: lines.join('\n') + '\n',
    overwriteExisting: true,
  };
}

/**
 * Emit a pure-`oneOf` discriminated union as a single inline type alias
 * (`export type X = { … } | { … }`) for both the domain and wire shapes. Used
 * instead of named per-variant interfaces, which read poorly for small
 * (often two-variant, boolean-discriminated) unions like the token response.
 */
function buildInlineUnionFile(plan: DiscriminatedPlan): GeneratedFile {
  const { shape, modelDir } = plan;
  const domain = toPascalCase(shape.modelName);
  const wire = wireInterfaceName(domain);
  const lines: string[] = [];

  const imports = collectImports(plan);
  if (imports.length > 0) {
    for (const imp of imports) {
      lines.push(`import type { ${imp.symbols.join(', ')} } from '${imp.path}';`);
    }
    lines.push('');
  }

  lines.push(...buildInlineUnionAlias(domain, shape, /*isWire*/ false));
  lines.push('');
  lines.push(...buildInlineUnionAlias(wire, shape, /*isWire*/ true));

  return {
    path: `src/${modelDir}/interfaces/${fileName(shape.modelName)}.interface.ts`,
    content: lines.join('\n') + '\n',
    overwriteExisting: true,
  };
}

function buildInlineUnionAlias(name: string, shape: DiscriminatedShape, isWire: boolean): string[] {
  const lines: string[] = [`export type ${name} =`];
  shape.variants.forEach((variant, idx) => {
    const isLast = idx === shape.variants.length - 1;
    const discKey = isWire ? shape.discriminatorProperty : shape.discriminatorPropertyDomain;
    const members = [`${discKey}: ${discLiteral(variant)}`];
    for (const field of variant.fields) {
      const key = isWire ? field.name : toCamelCase(field.name);
      const opt = field.required ? '' : '?';
      members.push(`${key}${opt}: ${inlineFieldType(field, isWire)}`);
    }
    lines.push(`  | { ${members.join('; ')} }${isLast ? ';' : ''}`);
  });
  return lines;
}

function buildInterfaceBody(name: string, shape: DiscriminatedShape, variant: VariantSpec, isWire: boolean): string[] {
  const lines: string[] = [];
  lines.push(`export interface ${name} {`);
  // Variant fields override base fields when both define the same property
  // (variants have narrower types, e.g. `event: 'foo'` vs base `event: string`).
  // The discriminator is also emitted separately as a const literal below.
  const variantFieldNames = new Set(variant.fields.map((f) => f.name));
  for (const field of shape.baseFields) {
    if (variantFieldNames.has(field.name)) continue;
    if (field.name === shape.discriminatorProperty) continue;
    pushFieldLine(lines, field, isWire);
  }
  // Discriminator (typed as the variant's const value)
  const discKey = isWire ? shape.discriminatorProperty : shape.discriminatorPropertyDomain;
  if (shape.discriminatorDescription) {
    lines.push(`  /** ${shape.discriminatorDescription} */`);
  }
  lines.push(`  ${discKey}: ${discLiteral(variant)};`);
  // Variant-specific fields
  for (const field of variant.fields) {
    pushFieldLine(lines, field, isWire);
  }
  lines.push('}');
  return lines;
}

/**
 * The discriminator value as a TS literal: quoted for strings (`'oauth'`),
 * bare for booleans (`true`).
 */
function discLiteral(variant: VariantSpec): string {
  return variant.discriminatorIsBoolean ? variant.discriminatorValue : `'${variant.discriminatorValue}'`;
}

/** Field type for an inline-union member: literal union for inline string
 *  enums, otherwise the resolved domain/wire type. */
function inlineFieldType(field: FieldSpec, isWire: boolean): string {
  if (field.enumValues) {
    return field.enumValues.map((v) => `'${v}'`).join(' | ');
  }
  return isWire ? field.wireType : field.domainType;
}

function pushFieldLine(lines: string[], field: FieldSpec, isWire: boolean): void {
  const key = isWire ? field.name : toCamelCase(field.name);
  const opt = field.required ? '' : '?';
  const type = isWire ? field.wireType : field.domainType;
  if (field.description) {
    lines.push(`  /** ${field.description} */`);
  }
  lines.push(`  ${key}${opt}: ${type};`);
}

interface ImportSpec {
  path: string;
  symbols: string[];
}

function collectImports(plan: DiscriminatedPlan): ImportSpec[] {
  const deps = new Set<string>();
  for (const field of plan.shape.baseFields) {
    for (const d of field.modelDeps) deps.add(d);
  }
  for (const variant of plan.shape.variants) {
    for (const field of variant.fields) {
      for (const d of field.modelDeps) deps.add(d);
    }
  }
  const result: ImportSpec[] = [];
  for (const dep of [...deps].sort()) {
    const domain = toPascalCase(dep);
    const wire = wireInterfaceName(domain);
    const symbols = wire !== domain ? [domain, wire] : [domain];
    const depDir = plan.depDirMap.get(dep);
    const baseName = fileName(toSnakeFromPascal(domain));
    let importPath: string;
    if (!depDir || depDir === plan.modelDir) {
      importPath = `./${baseName}.interface`;
    } else {
      importPath = `../../${depDir}/interfaces/${baseName}.interface`;
    }
    const existing = result.find((a) => a.path === importPath);
    if (existing) existing.symbols.push(...symbols);
    else result.push({ path: importPath, symbols });
  }
  return result;
}

function toSnakeFromPascal(s: string): string {
  // PascalCase → snake_case, preserving acronyms via word splits.
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

function buildSerializerFile(plan: DiscriminatedPlan, _ctx: EmitterContext): GeneratedFile {
  const { shape, modelDir } = plan;
  const domain = toPascalCase(shape.modelName);
  const wire = wireInterfaceName(domain);
  const lines: string[] = [];

  // Imports: domain + wire union types from the interfaces file.
  const interfaceImportPath = `../interfaces/${fileName(shape.modelName)}.interface`;
  lines.push(`import type { ${domain}, ${wire} } from '${interfaceImportPath}';`);

  // Serializer imports for model deps
  const allDeps = new Set<string>();
  for (const field of shape.baseFields) for (const d of field.modelDeps) allDeps.add(d);
  for (const variant of shape.variants)
    for (const field of variant.fields) for (const d of field.modelDeps) allDeps.add(d);

  // Pure-`oneOf` unions are response shapes (e.g. the token response): they are
  // only ever deserialized, and their inline-object fields may have no
  // serializer generated. Emit a deserializer only and import just the
  // deserialize helpers — mirrors the published hand-written serializer.
  const deserializeOnly = shape.inlineUnion === true;
  for (const dep of [...allDeps].sort()) {
    const depDomain = toPascalCase(dep);
    const depFile = fileName(toSnakeFromPascal(depDomain));
    const helpers = deserializeOnly ? `deserialize${depDomain}` : `deserialize${depDomain}, serialize${depDomain}`;
    lines.push(`import { ${helpers} } from './${depFile}.serializer';`);
  }
  lines.push('');

  // Deserializer
  lines.push(`export const deserialize${domain} = (response: ${wire}): ${domain} => {`);
  lines.push(`  switch (response.${shape.discriminatorProperty}) {`);
  for (const variant of shape.variants) {
    lines.push(`    case ${discLiteral(variant)}:`);
    lines.push(`      return {`);
    for (const field of shape.baseFields) {
      lines.push(`        ${assignmentLine(field, /*serialize*/ false, allDeps)},`);
    }
    lines.push(`        ${shape.discriminatorPropertyDomain}: ${discLiteral(variant)},`);
    for (const field of variant.fields) {
      lines.push(`        ${assignmentLine(field, /*serialize*/ false, allDeps)},`);
    }
    lines.push(`      };`);
  }
  lines.push(`    default:`);
  lines.push(
    `      throw new Error(\`Unknown ${shape.discriminatorProperty}: \${String((response as Record<string, unknown>).${shape.discriminatorProperty})}\`);`,
  );
  lines.push(`  }`);
  lines.push(`};`);

  if (!deserializeOnly) {
    lines.push('');
    // Serializer
    lines.push(`export const serialize${domain} = (model: ${domain}): ${wire} => {`);
    lines.push(`  switch (model.${shape.discriminatorPropertyDomain}) {`);
    for (const variant of shape.variants) {
      lines.push(`    case ${discLiteral(variant)}:`);
      lines.push(`      return {`);
      for (const field of shape.baseFields) {
        lines.push(`        ${assignmentLine(field, /*serialize*/ true, allDeps)},`);
      }
      lines.push(`        ${shape.discriminatorProperty}: ${discLiteral(variant)},`);
      for (const field of variant.fields) {
        lines.push(`        ${assignmentLine(field, /*serialize*/ true, allDeps)},`);
      }
      lines.push(`      };`);
    }
    lines.push(`  }`);
    lines.push(`};`);
  }

  return {
    path: `src/${modelDir}/serializers/${fileName(shape.modelName)}.serializer.ts`,
    content: lines.join('\n') + '\n',
    overwriteExisting: true,
  };
}

function assignmentLine(field: FieldSpec, serialize: boolean, _allDeps: Set<string>): string {
  const camel = toCamelCase(field.name);
  const snake = field.name;
  const lhs = serialize ? snake : camel;
  const rhsKey = serialize ? camel : snake;
  const source = serialize ? `model.${rhsKey}` : `response.${rhsKey}`;

  if (field.hasDateTime) {
    if (serialize) {
      if (field.required) return `${lhs}: ${source}.toISOString()`;
      return `${lhs}: ${source} != null ? ${source}.toISOString() : undefined`;
    }
    if (field.required) return `${lhs}: new Date(${source})`;
    return `${lhs}: ${source} != null ? new Date(${source}) : undefined`;
  }

  const arrayDep = arrayItemModelDep(field);
  if (arrayDep) {
    const fn = serialize ? `serialize${arrayDep}` : `deserialize${arrayDep}`;
    if (field.required) return `${lhs}: ${source}.map(${fn})`;
    return `${lhs}: ${source} != null ? ${source}.map(${fn}) : undefined`;
  }

  const scalarDep = scalarModelDepName(field);
  if (scalarDep) {
    const fn = serialize ? `serialize${scalarDep}` : `deserialize${scalarDep}`;
    if (field.required) return `${lhs}: ${fn}(${source})`;
    return `${lhs}: ${source} != null ? ${fn}(${source}) : undefined`;
  }

  return `${lhs}: ${source}`;
}

function arrayItemModelDep(field: FieldSpec): string | null {
  const m = field.domainType.match(/^([A-Z]\w*)\[\]$/);
  if (m && field.modelDeps.size > 0) return m[1];
  return null;
}

function scalarModelDepName(field: FieldSpec): string | null {
  const stripped = field.domainType.replace(/\s*\|\s*null$/, '');
  if (/^[A-Z]\w*$/.test(stripped) && field.modelDeps.size === 1) {
    return toPascalCase([...field.modelDeps][0]);
  }
  return null;
}
