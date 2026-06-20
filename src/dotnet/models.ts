import type { Model, EmitterContext, GeneratedFile, TypeRef, Service } from '@workos/oagen';
import { walkTypeRef } from '@workos/oagen';
import {
  mapTypeRef,
  isValueTypeRef,
  isEnumRef,
  emitJsonPropertyAttributes,
  setModelAliases,
  isModelAlias,
  resolveModelName,
} from './type-map.js';
import {
  articleFor,
  fieldName,
  domainFieldName,
  humanize,
  emitXmlDoc,
  deprecationMessage,
  escapeCsAttributeString,
  modelClassName,
} from './naming.js';

// Import and re-export shared model detection utilities
import {
  isListWrapperModel,
  isListMetadataModel,
  collectNonPaginatedResponseModelNames,
} from '../shared/model-utils.js';
import { isModelInScope } from '../shared/resolved-ops.js';
export { isListWrapperModel, isListMetadataModel };

/**
 * Context for discriminated union inheritance in generated models.
 * When present, base models get a [JsonConverter] attribute and variant
 * models extend the base class, inheriting common fields.
 */
export interface DiscriminatorContext {
  /** Model names that are discriminated union bases. */
  discriminatorBases: Set<string>;
  /** Maps variant model name → base model name. */
  variantToBase: Map<string, string>;
  /** Maps base model name → wire name of the discriminator property. */
  discriminatorProperties?: Map<string, string>;
}

/**
 * Generate C# model classes from IR Models.
 * Each model becomes a separate .cs file under Services/{mount}/Entities/.
 * For initial generation, all models go into a flat Entities/ directory.
 */
export function generateModels(models: Model[], ctx: EmitterContext, discCtx?: DiscriminatorContext): GeneratedFile[] {
  if (models.length === 0) return [];

  // Build a lookup from enum name → single wire value for 1-value enums so
  // we can emit a const initializer on the owning property without needing
  // the full EnumRef.values payload (which the IR sometimes omits on refs).
  const enumConstByName = new Map<string, string>();
  for (const e of ctx.spec.enums) {
    if (e.values.length === 1) {
      enumConstByName.set(e.name, String(e.values[0].value));
    }
  }

  const files: GeneratedFile[] = [];

  // Compute and publish model aliases so mapTypeRef rewrites references.
  // Must run BEFORE collectRequestBodyOnlyModelNames so the body/non-body
  // tally collapses aliased pairs onto their canonical name — otherwise a
  // model that's only a request body in name (e.g. `AddRolePermissionDto`)
  // but is the canonical for a field-referenced alias (e.g. `SlimRole`)
  // would be wrongly classified as body-only and skipped from emission,
  // leaving every alias-rewritten field reference dangling.
  primeModelAliases(models);

  // Models that are referenced ONLY as an operation request body (not by any
  // response, field, or other operation type) are dead surface in .NET because
  // the wrapper generator emits a per-operation `*Options` class containing
  // the same fields. The method signature consumes the Options class — the
  // named entity is never instantiated by callers and just clutters the SDK
  // (see workos-dotnet#248 with `CreateUserApiKey` /
  // `UserManagementCreateApiKeyOptions`). Skip emission for those.
  const requestBodyOnlyNames = collectRequestBodyOnlyModelNames(ctx.spec.services, models);
  // Wrappers referenced as a non-paginated response (e.g. `VersionListResponse`
  // for `GET /vault/v1/kv/{id}/versions`) must still be emitted — the resource
  // code references them by name and the pagination iterator doesn't unwrap them.
  const nonPaginatedRefs = collectNonPaginatedResponseModelNames(ctx.spec.services);
  const skipAsListWrapper = (m: Model): boolean => isListWrapperModel(m) && !nonPaginatedRefs.has(m.name);

  // Build a lookup of base model field C# names → C# types for inheritance.
  // Variant models skip inherited fields and use `new` for type-divergent ones.
  const baseFieldLookup = new Map<string, Map<string, string>>();
  if (discCtx) {
    for (const model of models) {
      if (discCtx.discriminatorBases.has(model.name)) {
        const baseClassName = modelClassName(model.name);
        const fieldMap = new Map<string, string>();
        for (const field of model.fields) {
          // DOMAIN identifier: the C# property name used for inheritance
          // comparison (honors a `domainName` override). Must match the
          // property name emitted below so variant fields dedup correctly.
          let csName = domainFieldName(field);
          if (csName === baseClassName) csName = `${csName}Value`;
          fieldMap.set(csName, mapTypeRef(field.type));
        }
        baseFieldLookup.set(model.name, fieldMap);
      }
    }
  }

  for (const model of models) {
    if (skipAsListWrapper(model) || isListMetadataModel(model)) continue;
    if (requestBodyOnlyNames.has(model.name)) continue;

    const csClassName = modelClassName(model.name);

    // Skip alias models — all references are already rewritten to the
    // canonical type by mapTypeRef, so the alias class would be dead code.
    if (isModelAlias(model.name)) continue;

    const lines: string[] = [];
    const fieldTypes = model.fields.map((f) => mapTypeRef(f.type));
    const needsCollections = fieldTypes.some((t) => t.startsWith('List<') || t.startsWith('Dictionary<'));
    const needsSystem = fieldTypes.some((t) => t.includes('DateTimeOffset'));
    // Required enums need JsonProperty / STJS; a field whose PascalCase name
    // collides with the enclosing class needs the same imports for the wire-
    // name override emitted below.
    // DOMAIN identifier: the emitted C# property name (honors `domainName`)
    // is what can collide with the enclosing class name.
    const hasClassNameCollision = model.fields.some((f) => domainFieldName(f) === csClassName);
    // A `domainName` override renames the C# property away from the wire key
    // (e.g. wire `connection_type` surfaced as domain `Type`). The
    // SnakeCaseLower naming policy would otherwise serialize the domain name,
    // so these fields need an explicit pinned wire name (and thus the imports).
    const hasDomainRename = model.fields.some((f) => domainFieldName(f) !== fieldName(f.name));
    const needsJsonAttrs =
      hasClassNameCollision || hasDomainRename || model.fields.some((f) => f.required && isEnumRef(f.type));

    lines.push(`namespace ${ctx.namespacePascal}`);
    lines.push('{');
    if (needsSystem) {
      lines.push('    using System;');
    }
    if (needsCollections) {
      lines.push('    using System.Collections.Generic;');
    }
    if (needsJsonAttrs) {
      lines.push('    using Newtonsoft.Json;');
      lines.push('    using STJS = System.Text.Json.Serialization;');
    }
    lines.push('');

    // XML doc comment
    if (model.description) {
      lines.push(...emitXmlDoc(model.description, '    '));
    } else {
      const human = humanize(model.name);
      lines.push(`    /// <summary>Represents ${articleFor(human)} ${human}.</summary>`);
    }

    // Discriminated union base: add JsonConverter so the deserializer dispatches
    // to the correct variant subclass.
    const isDiscBase = discCtx?.discriminatorBases.has(model.name) ?? false;
    if (isDiscBase) {
      lines.push(`    [Newtonsoft.Json.JsonConverter(typeof(${csClassName}DiscriminatorConverter))]`);
    }

    // Variant: extend the base class to inherit common fields.
    const baseName = discCtx?.variantToBase.get(model.name);
    const baseClassName = baseName ? modelClassName(baseName) : null;
    const baseFields = baseName ? baseFieldLookup.get(baseName) : undefined;

    if (baseClassName) {
      lines.push(`    public class ${csClassName} : ${baseClassName}`);
    } else {
      lines.push(`    public class ${csClassName}`);
    }
    lines.push('    {');

    // Track Dictionary<string, object> fields so we can emit a typed
    // accessor helper per field at the end of the class body.
    const dictObjectFields: Array<{ csName: string; typeText: string }> = [];

    // Deduplicate fields by C# property name
    const seenFieldNames = new Set<string>();
    for (const field of model.fields) {
      // CS0542: a property can't share its enclosing class's name. Spec schemas
      // like `Error.error` PascalCase into `Error.Error`, so suffix with `Value`
      // when that happens. Track the rename so we emit an explicit
      // `[JsonProperty]` attribute below — the SnakeCaseLower naming policy
      // would otherwise serialize `ErrorValue` as `error_value`, not `error`.
      // DOMAIN identifier: the C# property name, honoring a `domainName`
      // override (e.g. wire `connection_type` → domain `Type`). The wire key
      // passed to `emitJsonPropertyAttributes` below still derives from
      // `field.name`.
      let csFieldName = domainFieldName(field);
      const collidesWithClassName = csFieldName === csClassName;
      if (collidesWithClassName) csFieldName = `${csFieldName}Value`;
      // When the domain rename diverges from the wire key, the SnakeCaseLower
      // naming policy can't recover the wire name from the property — pin it.
      const hasDomainOverride = domainFieldName(field) !== fieldName(field.name);
      if (seenFieldNames.has(csFieldName)) continue;
      seenFieldNames.add(csFieldName);

      // Inheritance: if this variant extends a base class, check each field
      // against the base. Same C# type → skip (inherited). Different C# type
      // → emit with `new` keyword so the variant has its own typed property.
      let useNewModifier = false;
      if (baseFields) {
        const baseType = baseFields.get(csFieldName);
        if (baseType !== undefined) {
          const variantType = mapTypeRef(field.type);
          if (baseType === variantType) {
            continue; // Inherited from base — skip
          }
          useNewModifier = true;
        }
      }

      const isOptional = !field.required;
      const baseType = mapTypeRef(field.type);
      const isAlreadyNullable = baseType.endsWith('?');
      const constInit = singleValueConstInitializer(field.type, enumConstByName);
      let csType: string;
      let initializer = '';
      let setterModifier = '';

      // On a discriminated union base, the discriminator property (e.g. "event")
      // should be non-public-settable even though it lacks a single const value
      // (each variant has a different value). Consumers must never mutate it.
      const discProp = isDiscBase ? discCtx?.discriminatorProperties?.get(model.name) : undefined;
      const isDiscriminatorField = discProp !== undefined && field.name === discProp;

      if (constInit !== null && !isOptional) {
        // Discriminator-style single-value enum/literal: emit with a const
        // initializer and a non-public setter so callers can't drift the
        // wire value. The converter still reads whatever the server sends.
        // Only for required fields — optional literal fields must be nullable
        // so absent keys round-trip correctly.
        csType = baseType;
        initializer = ` = ${constInit};`;
        setterModifier = 'internal ';
      } else if (isDiscriminatorField) {
        // Discriminator property on the base class: varies per variant but
        // should still be non-public-settable so consumers can't change it.
        csType = baseType;
        if (!isAlreadyNullable && !isValueTypeRef(field.type)) {
          initializer = ' = default!;';
        }
        setterModifier = 'internal ';
      } else if (isOptional) {
        if (isAlreadyNullable) {
          csType = baseType;
        } else if (isValueTypeRef(field.type)) {
          csType = `${baseType}?`;
        } else {
          // With nullable enabled, optional reference types need `?`
          csType = `${baseType}?`;
        }
      } else {
        csType = baseType;
        // Required non-nullable reference types need = default! to suppress CS8618
        if (!isAlreadyNullable && !isValueTypeRef(field.type)) {
          initializer = ' = default!;';
        }
      }

      // Field description (full multi-line, with continuations as <remarks>)
      const fieldDocs = emitXmlDoc(field.description, '        ');
      if (fieldDocs.length > 0) {
        lines.push('');
        lines.push(...fieldDocs);
      }

      if (field.deprecated) {
        const msg = escapeCsAttributeString(deprecationMessage(field.description, 'field'));
        lines.push(`        [System.Obsolete("${msg}")]`);
      }

      const isRequiredEnum = field.required && isEnumRef(field.type) && constInit === null;
      // WIRE key: always derives from `field.name`. Pin it explicitly when the
      // C# property name (collision suffix or `domainName` override) no longer
      // round-trips to the wire name via the SnakeCaseLower naming policy.
      lines.push(
        ...emitJsonPropertyAttributes(field.name, {
          isRequiredEnum,
          explicitWireName: collidesWithClassName || hasDomainOverride,
        }),
      );
      // Discriminated-union-typed field: attach the variant-dispatching converter
      // so Newtonsoft picks the right subtype on deserialization. The converter
      // name is keyed off the first IR variant model name (matches how
      // `joinUnionVariants` registered it in `discriminatedUnions`).
      const discriminatedUnionConverter = discriminatedUnionConverterName(field.type);
      if (discriminatedUnionConverter) {
        lines.push(`        [Newtonsoft.Json.JsonConverter(typeof(${discriminatedUnionConverter}))]`);
      }
      const newMod = useNewModifier ? 'new ' : '';
      lines.push(`        public ${newMod}${csType} ${csFieldName} { get; ${setterModifier}set; }${initializer}`);

      // Track additional-properties / metadata dictionaries for typed accessors.
      // Skip deprecated fields so the generated accessor doesn't reference
      // a field marked `[System.Obsolete]` (which would fail the build).
      if (isDictionaryOfObject(csType) && !field.deprecated) {
        dictObjectFields.push({ csName: csFieldName, typeText: csType });
      }
    }

    for (const dict of dictObjectFields) {
      lines.push('');
      lines.push(`        /// <summary>`);
      lines.push(`        /// Typed accessor for <see cref="${dict.csName}"/>. Returns the value stored under`);
      lines.push(`        /// <paramref name="key"/> coerced to <typeparamref name="T"/>, or the default`);
      lines.push(`        /// value when the key is missing or the value is not convertible.`);
      lines.push(`        /// </summary>`);
      if (isDiscBase) {
        lines.push(`        /// <remarks>`);
        lines.push(`        /// Variant subclasses provide strongly-typed <c>${dict.csName}</c> properties that`);
        lines.push(`        /// shadow this dictionary. This accessor is intended for forward-compatible handling`);
        lines.push(`        /// of types not yet known to this SDK version. For recognized types, cast to the`);
        lines.push(`        /// specific subclass and access its typed <c>${dict.csName}</c> property directly.`);
        lines.push(`        /// </remarks>`);
      }
      lines.push(`        /// <typeparam name="T">Expected value type.</typeparam>`);
      lines.push(`        /// <param name="key">The key to look up.</param>`);
      lines.push(`        public T? Get${dict.csName}Attribute<T>(string key)`);
      lines.push('        {');
      lines.push(`            if (this.${dict.csName} == null)`);
      lines.push('            {');
      lines.push('                return default;');
      lines.push('            }');
      lines.push('');
      lines.push(`            if (!this.${dict.csName}.TryGetValue(key, out var value))`);
      lines.push('            {');
      lines.push('                return default;');
      lines.push('            }');
      lines.push('');
      lines.push('            if (value is T typed)');
      lines.push('            {');
      lines.push('                return typed;');
      lines.push('            }');
      lines.push('');
      lines.push('            if (value is Newtonsoft.Json.Linq.JToken token)');
      lines.push('            {');
      lines.push('                return token.ToObject<T>();');
      lines.push('            }');
      lines.push('');
      lines.push('            if (value is System.Text.Json.JsonElement element)');
      lines.push('            {');
      lines.push('                return System.Text.Json.JsonSerializer.Deserialize<T>(element.GetRawText());');
      lines.push('            }');
      lines.push('');
      lines.push('            return default;');
      lines.push('        }');
    }

    lines.push('    }');
    lines.push('}');

    // FR-1.4: write the per-model FILE only when in scope. .NET uses a flat
    // Entities/ directory with C# namespaces (no barrel/index), so an
    // out-of-scope model left untouched on disk stays referenceable.
    if (isModelInScope(model.name, ctx)) {
      files.push({
        path: `Entities/${csClassName}.cs`,
        content: lines.join('\n'),
        overwriteExisting: true,
      });
    }
  }

  return files;
}

/**
 * Compute the name of the discriminator converter class for a field whose
 * type is a discriminated union, mirroring the keying used in
 * `joinUnionVariants` (first IR model variant name + "DiscriminatorConverter").
 * Returns null when the type isn't a discriminated union with a populated
 * mapping. Also walks through `nullable` so an optional discriminated field
 * still gets the converter applied.
 */
function discriminatedUnionConverterName(ref: TypeRef): string | null {
  const inner = ref.kind === 'nullable' ? ref.inner : ref;
  if (inner.kind !== 'union') return null;
  if (!inner.discriminator || !inner.discriminator.mapping) return null;
  if (Object.keys(inner.discriminator.mapping).length === 0) return null;
  const firstModel = inner.variants.find((v) => v.kind === 'model');
  if (!firstModel || firstModel.kind !== 'model') return null;
  return `${modelClassName(firstModel.name)}DiscriminatorConverter`;
}

/**
 * Whether the emitted C# type is `Dictionary<string, object>` or its
 * nullable variant — the usual shape of metadata / additional-properties
 * fields that get typed accessors.
 */
function isDictionaryOfObject(csType: string): boolean {
  const bare = csType.endsWith('?') ? csType.slice(0, -1) : csType;
  return bare === 'Dictionary<string, object>';
}

/**
 * If the given TypeRef is a single-value enum / literal (a discriminator
 * const masquerading as an enum), return the C# literal expression (already
 * quoted for strings, bare for bool/number) so the emitter can lock the
 * field down with a const initializer and non-public setter. Returns null
 * for any other type.
 */
function singleValueConstInitializer(ref: TypeRef, enumConstByName: Map<string, string>): string | null {
  // OpenAPI `enum: [value]` (single-value) is normalized by the IR to a
  // LiteralType on the field, not an EnumRef. Emit per-type: booleans and
  // numbers are bare literals; strings get JSON-quoted.
  if (ref.kind === 'literal') {
    if (ref.value === null) return null;
    if (typeof ref.value === 'boolean') return ref.value ? 'true' : 'false';
    if (typeof ref.value === 'number') return String(ref.value);
    if (typeof ref.value === 'string') return JSON.stringify(ref.value);
    return null;
  }
  if (ref.kind !== 'enum') return null;
  let wire: string | null = null;
  if (ref.values && ref.values.length === 1) {
    const v = ref.values[0] as string | number | { value: string | number };
    wire = typeof v === 'string' || typeof v === 'number' ? String(v) : String(v.value);
  } else {
    wire = enumConstByName.get(ref.name) ?? null;
  }
  if (wire === null) return null;
  // Enum wire values serialize as strings in JSON, and mapTypeRef returns
  // `string` for single-value enums — so always quote.
  return JSON.stringify(wire);
}

/**
 * Compute and publish the model alias map. Safe to call multiple times
 * (idempotent for a given set of models). Must be invoked before any emitter
 * phase that calls `mapTypeRef` with model references.
 */
export function primeModelAliases(models: Model[]): void {
  const eligibleModels = models.filter((m) => !isListWrapperModel(m) && !isListMetadataModel(m));
  const aliasOf = new Map<string, string>();
  while (true) {
    const hashGroups = new Map<string, string[]>();
    for (const model of eligibleModels) {
      const hash = structuralHash(model, aliasOf);
      if (!hashGroups.has(hash)) hashGroups.set(hash, []);
      hashGroups.get(hash)!.push(model.name);
    }

    let added = false;
    for (const [hash, names] of hashGroups) {
      if (names.length <= 1) continue;
      if (hash === '') continue;
      const sorted = [...names].sort();
      const canonical = sorted[0];
      for (let i = 1; i < sorted.length; i++) {
        const name = sorted[i];
        if (aliasOf.get(name) !== canonical) {
          aliasOf.set(name, canonical);
          added = true;
        }
      }
    }
    if (!added) break;
  }
  setModelAliases(aliasOf);
}

/**
 * Normalize a TypeRef for structural comparison.
 * Enum references are normalized to their values (not names) so that
 * structurally identical enums with different names still match.
 * Model references are rewritten to their canonical alias (if any) so that
 * parents whose only difference is an already-aliased child collapse too.
 */
function normalizeTypeForHash(ref: TypeRef, aliasOf: Map<string, string>): any {
  if (ref.kind === 'enum') {
    // Normalize enum refs by their sorted values, not their name
    const vals = ref.values ? [...ref.values].sort() : [];
    return { kind: 'enum', values: vals };
  }
  if (ref.kind === 'model') {
    return { kind: 'model', name: aliasOf.get(ref.name) ?? ref.name };
  }
  if (ref.kind === 'nullable') {
    return { kind: 'nullable', inner: normalizeTypeForHash(ref.inner, aliasOf) };
  }
  if (ref.kind === 'array') {
    return { kind: 'array', items: normalizeTypeForHash(ref.items, aliasOf) };
  }
  if (ref.kind === 'union') {
    return { kind: 'union', variants: ref.variants.map((v) => normalizeTypeForHash(v, aliasOf)) };
  }
  if (ref.kind === 'map') {
    return { kind: 'map', valueType: normalizeTypeForHash(ref.valueType, aliasOf) };
  }
  return ref;
}

function structuralHash(model: Model, aliasOf: Map<string, string> = new Map()): string {
  return model.fields
    .map((f) => `${f.name}:${JSON.stringify(normalizeTypeForHash(f.type, aliasOf))}:${f.required}`)
    .sort()
    .join('|');
}

/**
 * Names of models referenced **only** as a named operation request body —
 * i.e. never appearing in a response, an error, a paginated item type, or as
 * a field type on another model. The .NET wrapper generator emits a
 * per-operation `*Options` class containing the same fields, so the named
 * entity is never instantiated by callers and just clutters the SDK
 * (workos-dotnet#248: `CreateUserApiKey` vs `UserManagementCreateApiKeyOptions`).
 */
function collectRequestBodyOnlyModelNames(services: Service[], models: Model[]): Set<string> {
  const requestBodyNames = new Set<string>();
  const otherReferences = new Set<string>();

  // Resolve every reference through the alias map so structurally-identical
  // models share a body/non-body classification. Without this, an alias being
  // used as a field would only mark the alias name as non-body — leaving its
  // canonical (which carries the same shape and gets emitted) wrongly tagged
  // as body-only and skipped.
  const collect = (ref: TypeRef | undefined, into: Set<string>): void => {
    if (!ref) return;
    walkTypeRef(ref, {
      model: (r) => into.add(resolveModelName(r.name)),
    });
  };

  for (const service of services) {
    for (const op of service.operations) {
      if (op.requestBody?.kind === 'model') {
        requestBodyNames.add(resolveModelName(op.requestBody.name));
      }
      collect(op.response, otherReferences);
      if (op.pagination) collect(op.pagination.itemType, otherReferences);
      for (const p of [...op.pathParams, ...op.queryParams, ...op.headerParams, ...(op.cookieParams ?? [])]) {
        collect(p.type, otherReferences);
      }
      if (op.successResponses) {
        for (const sr of op.successResponses) collect(sr.type, otherReferences);
      }
      for (const err of op.errors) {
        if (err.type) collect(err.type, otherReferences);
      }
    }
  }

  for (const model of models) {
    for (const field of model.fields) {
      collect(field.type, otherReferences);
    }
  }

  const result = new Set<string>();
  for (const name of requestBodyNames) {
    if (!otherReferences.has(name)) result.add(name);
  }
  return result;
}
