import type { Model, EmitterContext, GeneratedFile, TypeRef } from '@workos/oagen';
import {
  mapTypeRef,
  isValueTypeRef,
  isEnumRef,
  emitJsonPropertyAttributes,
  setModelAliases,
  isModelAlias,
} from './type-map.js';
import {
  articleFor,
  fieldName,
  humanize,
  emitXmlDoc,
  deprecationMessage,
  escapeCsAttributeString,
  modelClassName,
} from './naming.js';

// Import and re-export shared model detection utilities
import { isListWrapperModel, isListMetadataModel } from '../shared/model-utils.js';
export { isListWrapperModel, isListMetadataModel };

/**
 * Generate C# model classes from IR Models.
 * Each model becomes a separate .cs file under Services/{mount}/Entities/.
 * For initial generation, all models go into a flat Entities/ directory.
 */
export function generateModels(models: Model[], ctx: EmitterContext): GeneratedFile[] {
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
  primeModelAliases(models);

  for (const model of models) {
    if (isListWrapperModel(model) || isListMetadataModel(model)) continue;

    const csClassName = modelClassName(model.name);

    // Skip alias models — all references are already rewritten to the
    // canonical type by mapTypeRef, so the alias class would be dead code.
    if (isModelAlias(model.name)) continue;

    const lines: string[] = [];
    const fieldTypes = model.fields.map((f) => mapTypeRef(f.type));
    const needsCollections = fieldTypes.some((t) => t.startsWith('List<') || t.startsWith('Dictionary<'));
    const needsSystem = fieldTypes.some((t) => t.includes('DateTimeOffset'));
    const needsJsonAttrs = model.fields.some((f) => f.required && isEnumRef(f.type));

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

    lines.push(`    public class ${csClassName}`);
    lines.push('    {');

    // Track Dictionary<string, object> fields so we can emit a typed
    // accessor helper per field at the end of the class body.
    const dictObjectFields: Array<{ csName: string; typeText: string }> = [];

    // Deduplicate fields by C# property name
    const seenFieldNames = new Set<string>();
    for (const field of model.fields) {
      const csFieldName = fieldName(field.name);
      if (seenFieldNames.has(csFieldName)) continue;
      seenFieldNames.add(csFieldName);

      const isOptional = !field.required;
      const baseType = mapTypeRef(field.type);
      const isAlreadyNullable = baseType.endsWith('?');
      const constInit = singleValueConstInitializer(field.type, enumConstByName);
      let csType: string;
      let initializer = '';
      let setterModifier = '';

      if (constInit !== null) {
        // Discriminator-style single-value enum/literal: emit with a const
        // initializer and a non-public setter so callers can't drift the
        // wire value. The converter still reads whatever the server sends.
        csType = baseType;
        initializer = ` = ${constInit};`;
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
      lines.push(...emitJsonPropertyAttributes(field.name, { isRequiredEnum }));
      lines.push(`        public ${csType} ${csFieldName} { get; ${setterModifier}set; }${initializer}`);

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

    files.push({
      path: `Entities/${csClassName}.cs`,
      content: lines.join('\n'),
      overwriteExisting: true,
    });
  }

  return files;
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
