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
}

interface VariantSpec {
  /** Domain interface name suffix, e.g. `OAuth`, `M2M`. */
  nameSuffix: string;
  /** Discriminator string value, e.g. `oauth`, `m2m`. */
  discriminatorValue: string;
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
  variants: VariantSpec[];
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export function detectDiscriminatedShape(
  modelName: string,
  rawSchemas: Record<string, RawSchema>,
): DiscriminatedShape | null {
  const schema = rawSchemas[modelName];
  if (!schema?.allOf) return null;

  // The expected shape: allOf contains exactly one base object and one oneOf
  // wrapper. The base contributes shared fields; the oneOf contributes
  // variant-specific fields.
  let baseObject: RawSchema | null = null;
  let oneOfVariants: RawSchema[] | null = null;
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
    .map((fv) => {
      const discValue = readConstString(fv.alwaysProperties.get(discProp));
      if (!discValue) return null;
      return {
        nameSuffix: variantNameSuffix(discValue),
        discriminatorValue: discValue,
        fields: variantFields(fv, discProp, modelName, rawSchemas),
      };
    })
    .filter((v): v is VariantSpec => v !== null);

  if (variants.length !== flattenedVariants.length) return null;

  const baseFields = baseObject ? collectObjectFields(baseObject, modelName, rawSchemas) : [];

  return {
    modelName,
    baseFields,
    discriminatorProperty: discProp,
    discriminatorPropertyDomain: toCamelCase(discProp),
    variants,
  };
}

function mergeBase(prev: RawSchema | null, next: RawSchema): RawSchema {
  if (!prev) return next;
  return {
    type: 'object',
    properties: { ...(prev.properties ?? {}), ...(next.properties ?? {}) },
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
      const val = readConstString(schema);
      if (val === null) {
        allConst = false;
        break;
      }
      values.push(val);
    }
    if (allConst && new Set(values).size === values.length) {
      return propName;
    }
  }
  return null;
}

function readConstString(schema: RawSchema | undefined | null): string | null {
  if (!schema) return null;
  if (typeof schema.const === 'string') return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length === 1 && typeof schema.enum[0] === 'string') {
    return schema.enum[0];
  }
  return null;
}

function variantNameSuffix(constValue: string): string {
  return toPascalCase(constValue);
}

// ---------------------------------------------------------------------------
// Field extraction
// ---------------------------------------------------------------------------

function collectObjectFields(
  schema: RawSchema,
  parentName: string,
  rawSchemas: Record<string, RawSchema>,
): FieldSpec[] {
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const fields: FieldSpec[] = [];
  for (const [name, propSchema] of Object.entries(props)) {
    fields.push(buildField(name, propSchema, required.has(name), parentName, rawSchemas));
  }
  return fields;
}

function variantFields(
  fv: FlattenedVariant,
  discriminatorProperty: string,
  parentName: string,
  rawSchemas: Record<string, RawSchema>,
): FieldSpec[] {
  const fields: FieldSpec[] = [];
  for (const [name, propSchema] of fv.alwaysProperties) {
    if (name === discriminatorProperty) continue;
    fields.push(buildField(name, propSchema, fv.required.has(name), parentName, rawSchemas));
  }
  for (const [name, propSchema] of fv.optionalProperties) {
    if (name === discriminatorProperty) continue;
    fields.push(buildField(name, propSchema, false, parentName, rawSchemas));
  }
  return fields;
}

function buildField(
  rawName: string,
  schema: RawSchema,
  required: boolean,
  parentName: string,
  rawSchemas: Record<string, RawSchema>,
): FieldSpec {
  const modelDeps = new Set<string>();
  const domainType = rawSchemaToTS(schema, parentName, rawName, false, modelDeps, rawSchemas);
  const wireType = rawSchemaToTS(schema, parentName, rawName, true, modelDeps, rawSchemas);
  return {
    name: rawName,
    description: schema.description,
    required,
    domainType,
    wireType,
    modelDeps,
    hasDateTime: schemaHasDateTime(schema),
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
  rawSchemas: Record<string, RawSchema>,
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
    const items = rawSchemaToTS(schema.items, parentName, singularize(fieldName), isWire, modelDeps, rawSchemas);
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
}

export function planDiscriminatedModels(models: Model[], ctx: EmitterContext): Map<string, DiscriminatedPlan> {
  const plans = new Map<string, DiscriminatedPlan>();
  const spec = loadRawSpec();
  if (!spec?.components?.schemas) return plans;
  const rawSchemas = spec.components.schemas as Record<string, RawSchema>;
  const { modelToService, resolveDir } = createServiceDirResolver(models, ctx.spec.services, ctx);
  for (const model of models) {
    const shape = detectDiscriminatedShape(model.name, rawSchemas);
    if (!shape) continue;
    const modelDir = resolveDir(modelToService.get(model.name));
    plans.set(model.name, { shape, modelDir });
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

function buildInterfaceBody(name: string, shape: DiscriminatedShape, variant: VariantSpec, isWire: boolean): string[] {
  const lines: string[] = [];
  lines.push(`export interface ${name} {`);
  // Base fields
  for (const field of shape.baseFields) {
    pushFieldLine(lines, field, isWire);
  }
  // Discriminator (typed as the variant's const value)
  const discKey = isWire ? shape.discriminatorProperty : shape.discriminatorPropertyDomain;
  lines.push(`  ${discKey}: '${variant.discriminatorValue}';`);
  // Variant-specific fields
  for (const field of variant.fields) {
    pushFieldLine(lines, field, isWire);
  }
  lines.push('}');
  return lines;
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
  // Group by directory — all deps under the same modelDir get one import.
  // We assume all deps live in the same service for now (same dir as this
  // model). Cross-service imports would need ctx.spec.services lookups; the
  // current discriminated-shape cases (ConnectApplication) are all
  // intra-service.
  const symbols: string[] = [];
  for (const dep of [...deps].sort()) {
    const domain = toPascalCase(dep);
    symbols.push(domain);
    const wire = wireInterfaceName(domain);
    if (wire !== domain) symbols.push(wire);
  }
  if (symbols.length === 0) return [];
  // Single import block from sibling files in the same interfaces directory.
  return symbols
    .map((sym) => {
      const fname = fileName(toSnakeFromPascal(sym.replace(/Response$/, '')));
      return { path: `./${fname}.interface`, symbols: [sym] };
    })
    .reduce((acc, cur) => {
      const existing = acc.find((a) => a.path === cur.path);
      if (existing) existing.symbols.push(...cur.symbols);
      else acc.push(cur);
      return acc;
    }, [] as ImportSpec[]);
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

  for (const dep of [...allDeps].sort()) {
    const depDomain = toPascalCase(dep);
    const depFile = fileName(toSnakeFromPascal(depDomain));
    lines.push(`import { deserialize${depDomain}, serialize${depDomain} } from './${depFile}.serializer';`);
  }
  lines.push('');

  // Deserializer
  lines.push(`export const deserialize${domain} = (response: ${wire}): ${domain} => {`);
  lines.push(`  switch (response.${shape.discriminatorProperty}) {`);
  for (const variant of shape.variants) {
    lines.push(`    case '${variant.discriminatorValue}':`);
    lines.push(`      return {`);
    for (const field of shape.baseFields) {
      lines.push(`        ${assignmentLine(field, /*serialize*/ false, allDeps)},`);
    }
    lines.push(`        ${shape.discriminatorPropertyDomain}: '${variant.discriminatorValue}',`);
    for (const field of variant.fields) {
      lines.push(`        ${assignmentLine(field, /*serialize*/ false, allDeps)},`);
    }
    lines.push(`      };`);
  }
  lines.push(`    default:`);
  lines.push(
    `      throw new Error(\`Unknown ${shape.discriminatorProperty}: \${(response as { ${shape.discriminatorProperty}: string }).${shape.discriminatorProperty}}\`);`,
  );
  lines.push(`  }`);
  lines.push(`};`);
  lines.push('');

  // Serializer
  lines.push(`export const serialize${domain} = (model: ${domain}): ${wire} => {`);
  lines.push(`  switch (model.${shape.discriminatorPropertyDomain}) {`);
  for (const variant of shape.variants) {
    lines.push(`    case '${variant.discriminatorValue}':`);
    lines.push(`      return {`);
    for (const field of shape.baseFields) {
      lines.push(`        ${assignmentLine(field, /*serialize*/ true, allDeps)},`);
    }
    lines.push(`        ${shape.discriminatorProperty}: '${variant.discriminatorValue}',`);
    for (const field of variant.fields) {
      lines.push(`        ${assignmentLine(field, /*serialize*/ true, allDeps)},`);
    }
    lines.push(`      };`);
  }
  lines.push(`  }`);
  lines.push(`};`);

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
