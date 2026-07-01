import type { Model, EmitterContext, GeneratedFile, TypeRef, Field } from '@workos/oagen';
import { mapTypeRef, discriminatedUnions } from './type-map.js';
import { className, domainPropertyName, ktStringLiteral, humanize } from './naming.js';
import { enumCanonicalMap } from './enums.js';
import {
  isListWrapperModel,
  isListMetadataModel,
  collectNonPaginatedResponseModelNames,
  collectReferencedListMetadataModels,
} from '../shared/model-utils.js';
import { isModelInScope, fileExistsAfterRun } from '../shared/resolved-ops.js';

const KOTLIN_SRC_PREFIX = 'src/main/kotlin/';
const MODELS_PACKAGE = 'com.workos.models';
const MODELS_DIR = 'com/workos/models';

/**
 * The relative path (target-root-relative, matching the prior manifest) of the
 * per-model `.kt` FILE the emitter writes for a model. The aggregate gate
 * ({@link fileExistsAfterRun}) checks this exact path against the freshly-emitted
 * in-scope set and the prior manifest. Must stay in sync with the path used in
 * {@link emitDataClass} / {@link emitSealedUnion} / the typealias branch.
 */
function modelFilePath(modelName: string): string {
  return `${KOTLIN_SRC_PREFIX}${MODELS_DIR}/${className(modelName)}.kt`;
}

/**
 * Some specs leave string fields without `format: date-time` even though the
 * description (or the example) makes clear they carry an ISO-8601 timestamp.
 * Detect that here so we can promote the type to `OffsetDateTime` in the
 * Kotlin output.
 */
const ISO_8601_DESCRIPTION_RE = /\bISO[-_ ]?8601\b/i;

function looksLikeIso8601String(description: string | undefined): boolean {
  if (!description) return false;
  return ISO_8601_DESCRIPTION_RE.test(description);
}

function promoteIso8601TypeRef(type: TypeRef, description: string | undefined): TypeRef {
  if (!looksLikeIso8601String(description)) return type;
  const promote = (t: TypeRef): TypeRef => {
    if (t.kind === 'primitive' && t.type === 'string' && !t.format) {
      return { kind: 'primitive', type: 'string', format: 'date-time' };
    }
    if (t.kind === 'nullable') return { kind: 'nullable', inner: promote(t.inner) };
    return t;
  };
  return promote(type);
}

function promoteFieldType(f: Field): Field {
  const promoted = promoteIso8601TypeRef(f.type, f.description);
  return promoted === f.type ? f : { ...f, type: promoted };
}

/**
 * Generate Kotlin `data class` models. Each model becomes a separate `.kt`
 * file under `com.workos.models`. Discriminated unions emit a sealed class
 * with Jackson `@JsonTypeInfo` / `@JsonSubTypes` annotations so the base type
 * picks the right variant at deserialization time.
 *
 * List wrappers (`{ data, list_metadata }`) and the shared `ListMetadata`
 * model are skipped — the hand-maintained runtime provides [Page]/[ListMetadata].
 */
export function generateModels(models: Model[], ctx: EmitterContext): GeneratedFile[] {
  if (models.length === 0) return [];

  // First pass: call mapTypeRef on every model field so discriminator info is
  // registered before we start emitting parents.
  for (const model of models) {
    for (const field of model.fields) mapTypeRef(field.type);
  }

  const files: GeneratedFile[] = [];

  // Wrappers referenced as a non-paginated response (e.g. `VersionListResponse`
  // for `GET /vault/v1/kv/{id}/versions`) must still be emitted — the resource
  // code references them by name and pagination iterators don't unwrap them.
  const nonPaginatedRefs = collectNonPaginatedResponseModelNames(ctx.spec.services);
  const skipAsListWrapper = (m: Model): boolean => isListWrapperModel(m) && !nonPaginatedRefs.has(m.name);
  // A `ListMetadata`-shape model referenced by a surviving non-paginated
  // wrapper (e.g. vault's `VersionListResponse`) must still emit a data class
  // — otherwise the wrapper's class references a type that was never declared.
  const listMetadataNeeded = collectReferencedListMetadataModels(models, nonPaginatedRefs);
  const skipAsListMetadata = (m: Model): boolean => isListMetadataModel(m) && !listMetadataNeeded.has(m.name);

  // Deduplication: identical structures become typealiases.
  // Pass 1: hash without nested-alias resolution.
  modelAliasMap = null;
  const hashGroupsPass1 = new Map<string, string[]>();
  for (const model of models) {
    if (skipAsListWrapper(model) || skipAsListMetadata(model)) continue;
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
    if (skipAsListWrapper(model) || skipAsListMetadata(model)) continue;
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
    if (skipAsListWrapper(model) || skipAsListMetadata(model)) continue;
    const typeName = className(model.name);
    // FR-1.4: write per-model FILES only when in scope. Each model is its own
    // `.kt` file (no barrel), so an out-of-scope model left untouched on disk
    // stays importable. The WorkOSEvent sealed interface below is an aggregate
    // built from many event models, so it is NOT gated.
    const modelInScope = isModelInScope(model.name, ctx);

    // Parent of a discriminated union: emit a sealed class.
    if (model.fields.length === 0 && discriminatedUnions.has(typeName)) {
      if (modelInScope) {
        files.push(emitSealedUnion(typeName, discriminatedUnions.get(typeName)!, ctx));
      }
      continue;
    }

    const canonical = aliasOf.get(model.name);
    if (canonical) {
      const canonicalType = className(canonical);
      // Skip when different IR names collapse to the same output name
      if (typeName === canonicalType) continue;
      const aliasContent = [
        `package ${MODELS_PACKAGE}`,
        '',
        `/** Alias for [${canonicalType}]. */`,
        `typealias ${typeName} = ${canonicalType}`,
        '',
      ].join('\n');
      if (modelInScope) {
        files.push({
          path: `${KOTLIN_SRC_PREFIX}${MODELS_DIR}/${typeName}.kt`,
          content: aliasContent,
          overwriteExisting: true,
        });
      }
      continue;
    }

    if (modelInScope) {
      files.push(emitDataClass(model));
    }
  }

  // Generate the sealed WorkOSEvent interface. Collect all event envelope
  // models that have a literal `event` field and build the @JsonSubTypes
  // mapping so Jackson can deserialize directly to the correct concrete type.
  //
  // This is an AGGREGATE: it enumerates many event models by name. A scoped
  // (`--services`) run emits per-model `.kt` files only for in-scope models, so
  // listing a brand-new OUT-OF-SCOPE event model here would reference a
  // `ModelName::class` whose file is never written → "Unresolved reference"
  // (the WorkOSEvent.kt build break). Gate each entry so it appears only if its
  // model file will EXIST on disk after the run = in-scope (emitted now) ∪
  // already-on-disk (prior manifest; scoped runs never prune). Renamed/
  // removed-but-on-disk models still present under the same name in the spec are
  // retained; full runs include everything (gate is inert).
  const eventMapping: Array<{ wireValue: string; modelName: string }> = [];
  for (const model of models) {
    if (skipAsListWrapper(model) || skipAsListMetadata(model)) continue;
    if (aliasOf.has(model.name)) continue;
    if (!isEventEnvelopeModel(model)) continue;
    if (!fileExistsAfterRun(modelFilePath(model.name), isModelInScope(model.name, ctx), ctx)) continue;
    const eventField = model.fields.find((f) => f.name === 'event');
    if (eventField && eventField.type.kind === 'literal' && typeof eventField.type.value === 'string') {
      eventMapping.push({ wireValue: eventField.type.value, modelName: model.name });
    }
  }
  if (eventMapping.length > 0) {
    files.push(emitWorkOSEvent(eventMapping));
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
  // WorkOSEvent sealed interface is generated in the same package — no import needed.
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
      // Visually separate properties: KDoc + annotations for the next field
      // get their own paragraph. Kotlin requires the comma to come *before*
      // the blank line; we already appended it above.
      if (i < rendered.length - 1) {
        lines.push('');
      }
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
  ctx: EmitterContext,
): GeneratedFile {
  const lines: string[] = [];
  lines.push(`package ${MODELS_PACKAGE}`);
  lines.push('');
  lines.push('import com.fasterxml.jackson.annotation.JsonSubTypes');
  lines.push('import com.fasterxml.jackson.annotation.JsonTypeInfo');
  lines.push('');
  // AGGREGATE gate: @JsonSubTypes enumerates each variant model by name
  // (`VariantClass::class`). The sealed parent itself is in scope here, but a
  // scoped run may not emit a brand-new OUT-OF-SCOPE variant's `.kt` file — so
  // only list variants whose model file will exist on disk after the run
  // (in-scope ∪ prior manifest). A full run keeps every variant (gate is inert).
  const entries = Object.entries(disc.mapping).filter(([, modelName]) =>
    fileExistsAfterRun(modelFilePath(modelName), isModelInScope(modelName, ctx), ctx),
  );
  // KDoc with worked Kotlin + Java consumption examples. These unions are
  // returned by Jackson; callers branch on the concrete subtype to access
  // variant-specific data. Use a surviving variant so the example never names a
  // class whose file the scoped run skipped.
  const exampleVariantType = entries.length > 0 ? className(entries[0][1]) : null;
  lines.push('/**');
  lines.push(` * Discriminated union over ${typeName} variants. Selected by \`${disc.property}\`.`);
  if (exampleVariantType) {
    lines.push(' *');
    lines.push(' * Usage from Kotlin:');
    lines.push(' * ```kotlin');
    lines.push(` * when (val v: ${typeName} = receivedFromApi()) {`);
    lines.push(` *   is ${exampleVariantType} -> handle(v)`);
    lines.push(' *   else -> handleOther(v)');
    lines.push(' * }');
    lines.push(' * ```');
    lines.push(' *');
    lines.push(' * Usage from Java:');
    lines.push(' * ```java');
    lines.push(` * ${typeName} v = receivedFromApi();`);
    lines.push(` * if (v instanceof ${exampleVariantType}) {`);
    lines.push(` *     handle((${exampleVariantType}) v);`);
    lines.push(' * }');
    lines.push(' * ```');
  }
  lines.push(' */');
  lines.push('@JsonTypeInfo(');
  lines.push('  use = JsonTypeInfo.Id.NAME,');
  lines.push('  include = JsonTypeInfo.As.EXISTING_PROPERTY,');
  lines.push(`  property = ${ktStringLiteral(disc.property)},`);
  lines.push('  visible = true');
  lines.push(')');
  lines.push('@JsonSubTypes(');
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

/**
 * Emit the sealed `WorkOSEvent` interface with Jackson discriminated
 * deserialization. Each concrete event model (UserCreated, DsyncUserUpdated,
 * etc.) already extends this interface. The `@JsonSubTypes` annotation lets
 * Jackson pick the right subclass when deserializing JSON with an `event`
 * discriminator field. `EventSchema` is the fallback for unknown event types.
 */
function emitWorkOSEvent(eventMapping: Array<{ wireValue: string; modelName: string }>): GeneratedFile {
  const lines: string[] = [];
  lines.push(`package ${MODELS_PACKAGE}`);
  lines.push('');
  lines.push('import com.fasterxml.jackson.annotation.JsonSubTypes');
  lines.push('import com.fasterxml.jackson.annotation.JsonTypeInfo');
  lines.push('import java.time.OffsetDateTime');
  lines.push('');

  lines.push('/**');
  lines.push(' * Sealed interface for all webhook/event envelope models.');
  lines.push(' *');
  lines.push(' * Jackson deserializes incoming event JSON to the correct concrete type');
  lines.push(' * based on the `event` discriminator field. Unknown event types fall back');
  lines.push(' * to [EventSchema] with untyped `data: Map<String, Any>`.');
  lines.push(' *');
  lines.push(' * ```kotlin');
  lines.push(' * val event: WorkOSEvent = objectMapper.readValue(json, WorkOSEvent::class.java)');
  lines.push(' * when (event) {');
  lines.push(' *   is UserCreated -> println("User created: ${event.data.id}")');
  lines.push(' *   is EventSchema -> println("Unknown event: ${event.event}")');
  lines.push(' * }');
  lines.push(' * ```');
  lines.push(' */');

  lines.push('@JsonTypeInfo(');
  lines.push('  use = JsonTypeInfo.Id.NAME,');
  lines.push('  include = JsonTypeInfo.As.EXISTING_PROPERTY,');
  lines.push('  property = "event",');
  lines.push('  visible = true,');
  lines.push('  defaultImpl = EventSchema::class');
  lines.push(')');
  lines.push('@JsonSubTypes(');
  // Sort entries for stable output
  const sorted = [...eventMapping].sort((a, b) => a.wireValue.localeCompare(b.wireValue));
  for (let i = 0; i < sorted.length; i++) {
    const { wireValue, modelName } = sorted[i];
    const typeName = className(modelName);
    const suffix = i === sorted.length - 1 ? '' : ',';
    lines.push(`  JsonSubTypes.Type(value = ${typeName}::class, name = ${ktStringLiteral(wireValue)})${suffix}`);
  }
  lines.push(')');
  lines.push('sealed interface WorkOSEvent {');
  lines.push('  /** Unique identifier for this event. */');
  lines.push('  val id: String');
  lines.push('');
  lines.push('  /** The event type identifier. */');
  lines.push('  val event: String');
  lines.push('');
  lines.push('  /** Timestamp when the event was created. */');
  lines.push('  val createdAt: OffsetDateTime');
  lines.push('}');
  lines.push('');

  return {
    path: `${KOTLIN_SRC_PREFIX}${MODELS_DIR}/WorkOSEvent.kt`,
    content: lines.join('\n'),
    overwriteExisting: true,
  };
}

function renderFields(fields: Field[], overrideFields: Set<string> = new Set()): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];

  for (const rawField of fields) {
    const field = promoteFieldType(rawField);
    // DOMAIN identifier: the data class property name. Honors a `domainName`
    // override (e.g. connection_type -> type); the `@JsonProperty(...)` wire
    // key below still derives from `field.name`.
    const kotlinName = domainPropertyName(field);
    if (seen.has(kotlinName)) continue;
    seen.add(kotlinName);

    const baseType = mapTypeRef(field.type);
    let kotlinType: string;
    let defaultExpr: string | null = null;

    // Const literal fields: emit a hardcoded default matching the literal
    // value so callers don't have to pass it — but only when the field is
    // required. Optional literal fields must default to null so that absent
    // keys round-trip correctly.
    const literalDefault = literalDefaultExpr(field.type);

    if (literalDefault !== null && field.required) {
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
    if (field.deprecated) annotations.push(buildDeprecatedAnnotation(field.description));

    const paramParts: string[] = [];
    if (field.description?.trim()) {
      const line = field.description.split('\n').find((l) => l.trim()) ?? '';
      lines.push(`  /** ${escapeKdoc(line.trim())} */`);
    } else if (literalDefault !== null) {
      lines.push(`  /** Always \`${literalDefault}\`. */`);
    } else {
      lines.push(`  /** The ${humanize(field.name)}. */`);
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
 * Pull the most useful free-form deprecation hint out of a field description
 * and lift it into the `@Deprecated(...)` message argument. Most WorkOS
 * deprecations are written as a description that begins with "Deprecated"
 * (e.g. "Deprecated. Use `domain_data` instead."). When the description
 * doesn't carry a hint we fall back to a short, self-explanatory message
 * rather than the generic "Deprecated field" placeholder.
 */
function deprecationMessageFromDescription(description: string | undefined): string {
  if (!description) return 'Deprecated.';
  const firstLine = description
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return 'Deprecated.';
  // Trim trailing whitespace and collapse internal whitespace runs so the
  // annotation argument stays on one line.
  const collapsed = firstLine.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return 'Deprecated.';
  // Only lift the description when it actually carries a deprecation hint
  // (e.g. "Deprecated. Use `domain_data` instead.") — many fields keep their
  // forward-looking description verbatim, which would be misleading inside
  // an `@Deprecated(...)` argument.
  if (/\bdeprecat/i.test(collapsed)) return collapsed;
  return 'Deprecated.';
}

function buildDeprecatedAnnotation(description: string | undefined): string {
  const message = deprecationMessageFromDescription(description);
  return `@Deprecated(${ktStringLiteral(message)})`;
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
  for (const rawField of fields) {
    const field = promoteFieldType(rawField);
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
