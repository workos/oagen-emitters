import type { Model, EmitterContext, GeneratedFile, TypeRef, Field } from '@workos/oagen';
import { mapTypeRef, discriminatedUnions } from './type-map.js';
import { className, propertyName, ktStringLiteral } from './naming.js';
import { enumCanonicalMap } from './enums.js';
import { isListWrapperModel, isListMetadataModel } from '../shared/model-utils.js';

const KOTLIN_SRC_PREFIX = 'src/main/kotlin/';
const MODELS_PACKAGE = 'com.workos.models';
const MODELS_DIR = 'com/workos/models';

/**
 * Generate Kotlin `data class` models. Each model becomes a separate `.kt`
 * file under `com.workos.models`. Discriminated unions emit a sealed class
 * with Jackson `@JsonTypeInfo` / `@JsonSubTypes` annotations so the base type
 * picks the right variant at deserialization time.
 *
 * List wrappers (`{ data, list_metadata }`) and the shared `ListMetadata`
 * model are skipped — the hand-maintained runtime provides [Page]/[ListMetadata].
 */
export function generateModels(models: Model[], _ctx: EmitterContext): GeneratedFile[] {
  if (models.length === 0) return [];

  // First pass: call mapTypeRef on every model field so discriminator info is
  // registered before we start emitting parents.
  for (const model of models) {
    for (const field of model.fields) mapTypeRef(field.type);
  }

  const files: GeneratedFile[] = [];

  // Deduplication: identical structures become typealiases.
  // Pass 1: hash without nested-alias resolution.
  modelAliasMap = null;
  const hashGroupsPass1 = new Map<string, string[]>();
  for (const model of models) {
    if (isListWrapperModel(model) || isListMetadataModel(model)) continue;
    if (model.fields.length === 0 && discriminatedUnions.has(className(model.name))) continue;
    const hash = structuralHash(model);
    if (!hashGroupsPass1.has(hash)) hashGroupsPass1.set(hash, []);
    hashGroupsPass1.get(hash)!.push(model.name);
  }

  const aliasOf = new Map<string, string>();
  for (const [hash, names] of hashGroupsPass1) {
    if (names.length <= 1 || hash === '') continue;
    const sorted = [...names].sort(preferShorterCanonical);
    const canonical = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      if (hasRequestSuffix(sorted[i]) !== hasRequestSuffix(canonical)) continue;
      aliasOf.set(sorted[i], canonical);
    }
  }

  // Pass 2: re-hash with the alias map so models whose only difference was
  // referencing aliased vs canonical nested types now collide.
  modelAliasMap = aliasOf;
  const hashGroupsPass2 = new Map<string, string[]>();
  for (const model of models) {
    if (isListWrapperModel(model) || isListMetadataModel(model)) continue;
    if (model.fields.length === 0 && discriminatedUnions.has(className(model.name))) continue;
    if (aliasOf.has(model.name)) continue; // already aliased in pass 1
    const hash = structuralHash(model);
    if (!hashGroupsPass2.has(hash)) hashGroupsPass2.set(hash, []);
    hashGroupsPass2.get(hash)!.push(model.name);
  }
  for (const [hash, names] of hashGroupsPass2) {
    if (names.length <= 1 || hash === '') continue;
    const sorted = [...names].sort(preferShorterCanonical);
    const canonical = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      if (aliasOf.has(sorted[i])) continue;
      if (hasRequestSuffix(sorted[i]) !== hasRequestSuffix(canonical)) continue;
      aliasOf.set(sorted[i], canonical);
    }
  }

  for (const model of models) {
    if (isListWrapperModel(model) || isListMetadataModel(model)) continue;
    const typeName = className(model.name);

    // Parent of a discriminated union: emit a sealed class.
    if (model.fields.length === 0 && discriminatedUnions.has(typeName)) {
      files.push(emitSealedUnion(typeName, discriminatedUnions.get(typeName)!));
      continue;
    }

    const canonical = aliasOf.get(model.name);
    if (canonical) {
      const canonicalType = className(canonical);
      // Skip when different IR names collapse to the same output name
      if (typeName === canonicalType) continue;
      const aliasContent = [`package ${MODELS_PACKAGE}`, '', `typealias ${typeName} = ${canonicalType}`, ''].join('\n');
      files.push({
        path: `${KOTLIN_SRC_PREFIX}${MODELS_DIR}/${typeName}.kt`,
        content: aliasContent,
        overwriteExisting: true,
      });
      continue;
    }

    files.push(emitDataClass(model));
  }

  return files;
}

/**
 * Detect whether a model follows the webhook event envelope pattern:
 * has required `id`, `event`, `created_at` fields plus a `data` field.
 */
function isEventEnvelopeModel(model: Model): boolean {
  const fieldNames = new Set(model.fields.map((f) => f.name));
  return fieldNames.has('id') && fieldNames.has('event') && fieldNames.has('created_at') && fieldNames.has('data');
}

function emitDataClass(model: Model): GeneratedFile {
  const typeName = className(model.name);
  const imports = collectImports(model.fields);
  const implementsEvent = isEventEnvelopeModel(model);
  if (implementsEvent) imports.add('com.workos.common.http.WorkOSEvent');
  const lines: string[] = [];
  lines.push(`package ${MODELS_PACKAGE}`);
  lines.push('');
  for (const imp of [...imports].sort()) lines.push(`import ${imp}`);
  if (imports.size > 0) lines.push('');

  appendKdoc(lines, model.description ?? `${typeName} model.`, 0);

  if (model.fields.length === 0) {
    // Kotlin data classes require at least one primary constructor param.
    // Use a regular empty class instead.
    lines.push(`class ${typeName}`);
    lines.push('');
  } else {
    const implClause = implementsEvent ? ' : WorkOSEvent' : '';
    lines.push(`data class ${typeName}(`);

    // Emit non-defaulted params first, then defaulted — Kotlin requires
    // non-defaulted params before defaulted ones. Literal-typed fields always
    // receive a default, so they sort after plain required fields.
    const hasDefault = (f: Field): boolean => !f.required || f.type.kind === 'literal';
    const ordered = [...model.fields].sort((a, b) => {
      const aDef = hasDefault(a);
      const bDef = hasDefault(b);
      if (aDef === bDef) return 0;
      return aDef ? 1 : -1;
    });
    // When implementing WorkOSEvent, matching fields need `override`.
    const overrideFields = implementsEvent ? new Set(['id', 'event', 'createdAt']) : new Set<string>();
    const rendered = renderFields(ordered, overrideFields);
    for (let i = 0; i < rendered.length; i++) {
      const suffix = i === rendered.length - 1 ? '' : ',';
      lines.push(`${rendered[i]}${suffix}`);
    }

    lines.push(`)${implClause}`);
    lines.push('');
  }

  return {
    path: `${KOTLIN_SRC_PREFIX}${MODELS_DIR}/${typeName}.kt`,
    content: lines.join('\n'),
    overwriteExisting: true,
  };
}

function emitSealedUnion(
  typeName: string,
  disc: { property: string; mapping: Record<string, string>; variantTypes: string[] },
): GeneratedFile {
  const lines: string[] = [];
  lines.push(`package ${MODELS_PACKAGE}`);
  lines.push('');
  lines.push('import com.fasterxml.jackson.annotation.JsonSubTypes');
  lines.push('import com.fasterxml.jackson.annotation.JsonTypeInfo');
  lines.push('');
  appendKdoc(lines, `Discriminated union over ${typeName} variants. Selected by \`${disc.property}\`.`, 0);
  lines.push('@JsonTypeInfo(');
  lines.push('  use = JsonTypeInfo.Id.NAME,');
  lines.push('  include = JsonTypeInfo.As.EXISTING_PROPERTY,');
  lines.push(`  property = ${ktStringLiteral(disc.property)},`);
  lines.push('  visible = true');
  lines.push(')');
  lines.push('@JsonSubTypes(');
  const entries = Object.entries(disc.mapping);
  for (let i = 0; i < entries.length; i++) {
    const [wireValue, modelName] = entries[i];
    const variantType = className(modelName);
    const suffix = i === entries.length - 1 ? '' : ',';
    lines.push(`  JsonSubTypes.Type(value = ${variantType}::class, name = ${ktStringLiteral(wireValue)})${suffix}`);
  }
  lines.push(')');
  lines.push(`sealed class ${typeName}`);
  lines.push('');

  return {
    path: `${KOTLIN_SRC_PREFIX}${MODELS_DIR}/${typeName}.kt`,
    content: lines.join('\n'),
    overwriteExisting: true,
  };
}

function renderFields(fields: Field[], overrideFields: Set<string> = new Set()): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];

  for (const field of fields) {
    const kotlinName = propertyName(field.name);
    if (seen.has(kotlinName)) continue;
    seen.add(kotlinName);

    const baseType = mapTypeRef(field.type);
    let kotlinType: string;
    let defaultExpr: string | null = null;

    // Const literal fields: always emit a hardcoded default matching the
    // literal value so callers don't have to pass it.
    const literalDefault = literalDefaultExpr(field.type);

    if (literalDefault !== null) {
      kotlinType = baseType;
      defaultExpr = literalDefault;
    } else if (!field.required) {
      kotlinType = baseType.endsWith('?') ? baseType : `${baseType}?`;
      defaultExpr = 'null';
    } else if (baseType.endsWith('?')) {
      // Required field whose underlying type is already nullable.
      kotlinType = baseType;
    } else {
      kotlinType = baseType;
    }

    const isOverride = overrideFields.has(kotlinName);
    const annotations: string[] = [];
    // Omit @JvmField so Kotlin generates proper getter methods (getId(),
    // isEmailVerified(), etc.) for Java callers — matching the accessor
    // convention used by Stripe, AWS SDK v2, and Twilio.
    annotations.push(`@JsonProperty(${ktStringLiteral(field.name)})`);
    if (field.deprecated) annotations.push('@Deprecated("Deprecated field")');

    const paramParts: string[] = [];
    if (field.description?.trim()) {
      const line = field.description.split('\n').find((l) => l.trim()) ?? '';
      lines.push(`  /** ${escapeKdoc(line.trim())} */`);
    } else if (literalDefault !== null) {
      lines.push(`  /** Always \`${literalDefault}\`. */`);
    }
    for (const anno of annotations) lines.push(`  ${anno}`);

    const overridePrefix = isOverride ? 'override ' : '';
    const rendered = `  ${overridePrefix}val ${kotlinName}: ${kotlinType}`;
    paramParts.push(rendered);
    if (defaultExpr !== null) paramParts[0] = `${paramParts[0]} = ${defaultExpr}`;
    lines.push(paramParts[0]);
  }
  // Collapse annotation + val pairs into a list where each contiguous block
  // becomes one field entry, preserving order.
  return collapseFieldEntries(lines);
}

function collapseFieldEntries(rawLines: string[]): string[] {
  // `rawLines` intermixes kdoc comments, annotations, and `val` declarations.
  // Group them so each field is a single multi-line entry, so the caller can
  // append a trailing comma at the right spot.
  const entries: string[] = [];
  let current: string[] = [];
  for (const line of rawLines) {
    const trimmed = line.trimStart();
    const isDeclaration = trimmed.startsWith('val ') || trimmed.startsWith('override val ');
    current.push(line);
    if (isDeclaration) {
      entries.push(current.join('\n'));
      current = [];
    }
  }
  if (current.length > 0) entries.push(current.join('\n'));
  return entries;
}

/**
 * If the TypeRef is a literal (const) with a string, number, or boolean value,
 * return the Kotlin expression for that default. Otherwise return null.
 */
function literalDefaultExpr(ref: TypeRef): string | null {
  if (ref.kind !== 'literal' || ref.value === null) return null;
  if (typeof ref.value === 'string') return ktStringLiteral(ref.value);
  if (typeof ref.value === 'number') return Number.isInteger(ref.value) ? `${ref.value}L` : String(ref.value);
  if (typeof ref.value === 'boolean') return ref.value ? 'true' : 'false';
  return null;
}

function collectImports(fields: Field[]): Set<string> {
  const imports = new Set<string>();
  if (fields.length === 0) return imports;
  imports.add('com.fasterxml.jackson.annotation.JsonProperty');
  for (const field of fields) {
    const mapped = mapTypeRef(field.type);
    if (/\bOffsetDateTime\b/.test(mapped)) imports.add('java.time.OffsetDateTime');
    for (const enumName of collectEnumNames(field.type)) {
      // Resolve through the canonical map so imports point at the actual
      // enum class, not an alias that may not have its own file.
      const canonical = enumCanonicalMap.get(enumName) ?? enumName;
      imports.add(`com.workos.types.${className(canonical)}`);
    }
  }
  return imports;
}

function collectEnumNames(ref: TypeRef, acc: Set<string> = new Set()): Set<string> {
  if (ref.kind === 'enum') acc.add(ref.name);
  else if (ref.kind === 'array') collectEnumNames(ref.items, acc);
  else if (ref.kind === 'map') collectEnumNames(ref.valueType, acc);
  else if (ref.kind === 'nullable') collectEnumNames(ref.inner, acc);
  else if (ref.kind === 'union') for (const v of ref.variants) collectEnumNames(v, acc);
  return acc;
}

function appendKdoc(lines: string[], text: string, indent: number): void {
  const pad = ' '.repeat(indent);
  const firstLine = text.split('\n').find((l) => l.trim()) ?? '';
  lines.push(`${pad}/** ${escapeKdoc(firstLine.trim())} */`);
}

function escapeKdoc(s: string): string {
  return s.replace(/\*\//g, '*\u200b/');
}

// Re-exported so downstream emitters (resources, tests) can filter wrapper models.
export { isListWrapperModel, isListMetadataModel };

// --- Canonical name selection ---

/**
 * When picking which model name should be the concrete class (canonical) vs.
 * a typealias, prefer shorter names first (they tend to be the public-facing
 * names like `User`, `Role`), then fall back to alphabetical order for
 * stability. This avoids situations where `User = EmailChangeConfirmationUser`
 * or `SlimRole = AddRolePermission`.
 */
function preferShorterCanonical(a: string, b: string): number {
  const aName = className(a);
  const bName = className(b);
  if (aName.length !== bName.length) return aName.length - bName.length;
  return aName.localeCompare(bName);
}

// --- Unsafe typealias guard ---

/** Suffixes that indicate a request / mutation DTO. */
const REQUEST_SUFFIXES = /(?:Dto|Request|Create|Update|Add|Remove|Set)$/i;

/**
 * Returns true when [name] looks like a request DTO based on its suffix.
 * Used to prevent aliasing request DTOs to response models that happen to
 * share the same field shapes today.
 */
function hasRequestSuffix(name: string): boolean {
  return REQUEST_SUFFIXES.test(className(name));
}

// --- Structural dedup ---

/**
 * Resolve a model name through the alias map so that two models referencing
 * aliased nested types produce the same structural hash. Called after the
 * first alias pass to catch transitive matches.
 */
let modelAliasMap: Map<string, string> | null = null;

function normalizeTypeForHash(ref: TypeRef): unknown {
  if (ref.kind === 'enum') {
    const vals = ref.values ? [...ref.values].sort() : [];
    return { kind: 'enum', values: vals };
  }
  if (ref.kind === 'model') {
    // Resolve through the alias map so `FooData` and `BarData` (aliased to
    // FooData) produce the same hash when referenced as nested types.
    const resolved = modelAliasMap?.get(ref.name) ?? ref.name;
    return { kind: 'model', name: resolved };
  }
  if (ref.kind === 'nullable') return { kind: 'nullable', inner: normalizeTypeForHash(ref.inner) };
  if (ref.kind === 'array') return { kind: 'array', items: normalizeTypeForHash(ref.items) };
  if (ref.kind === 'union') return { kind: 'union', variants: ref.variants.map(normalizeTypeForHash) };
  if (ref.kind === 'map') return { kind: 'map', valueType: normalizeTypeForHash(ref.valueType) };
  return ref;
}

function structuralHash(model: Model): string {
  return model.fields
    .map((f) => `${f.name}:${JSON.stringify(normalizeTypeForHash(f.type))}:${f.required}`)
    .sort()
    .join('|');
}
