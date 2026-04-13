import type { Model, EmitterContext, GeneratedFile, TypeRef } from '@workos/oagen';
import { mapTypeRef, isValueTypeRef, isEnumRef, emitJsonPropertyAttributes } from './type-map.js';
import { className, fieldName, emitXmlDoc, deprecationMessage, escapeCsAttributeString } from './naming.js';

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

  // Build structural hash for deduplication. Run the hash → canonical pass
  // iteratively so that parent classes whose only structural difference is
  // an already-aliased child type also collapse. Terminates when a full
  // round produces no new aliases.
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

  for (const model of models) {
    if (isListWrapperModel(model) || isListMetadataModel(model)) continue;

    const csClassName = className(model.name);
    const canonicalName = aliasOf.get(model.name);

    if (canonicalName) {
      // Emit alias as subclass of canonical
      const canonicalClass = className(canonicalName);
      const lines: string[] = [];
      lines.push(`namespace ${ctx.namespacePascal}`);
      lines.push('{');
      lines.push(`    /// <summary>${csClassName} is structurally identical to ${canonicalClass}.</summary>`);
      lines.push(`    public class ${csClassName} : ${canonicalClass} { }`);
      lines.push('}');

      files.push({
        path: `Entities/${csClassName}.cs`,
        content: lines.join('\n'),
        overwriteExisting: true,
      });
      continue;
    }

    const lines: string[] = [];
    const needsCollections = model.fields.some((f) => {
      const csType = mapTypeRef(f.type);
      return csType.startsWith('List<') || csType.startsWith('Dictionary<');
    });
    const needsSystem = model.fields.some((f) => {
      const csType = mapTypeRef(f.type);
      return csType.includes('DateTimeOffset');
    });

    lines.push(`namespace ${ctx.namespacePascal}`);
    lines.push('{');
    if (needsSystem) {
      lines.push('    using System;');
    }
    if (needsCollections) {
      lines.push('    using System.Collections.Generic;');
    }
    lines.push('    using Newtonsoft.Json;');
    lines.push('    using STJS = System.Text.Json.Serialization;');
    lines.push('');

    // XML doc comment
    if (model.description) {
      lines.push(...emitXmlDoc(model.description, '    '));
    } else {
      lines.push(`    /// <summary>Represents a ${humanize(model.name)}.</summary>`);
    }

    lines.push(`    public class ${csClassName}`);
    lines.push('    {');

    // Deduplicate fields by C# property name
    const seenFieldNames = new Set<string>();
    for (const field of model.fields) {
      const csFieldName = fieldName(field.name);
      if (seenFieldNames.has(csFieldName)) continue;
      seenFieldNames.add(csFieldName);

      const isOptional = !field.required;
      const baseType = mapTypeRef(field.type);
      const isAlreadyNullable = baseType.endsWith('?');
      const constValue = singleValueEnumConst(field.type, enumConstByName);
      let csType: string;
      let initializer = '';
      let setterModifier = '';

      if (constValue !== null) {
        // Discriminator-style single-value enum: emit as string with a const
        // initializer and a non-public setter so callers can't drift the
        // wire value. The converter still reads whatever the server sends.
        csType = baseType; // already `string` for 1-value enum via mapTypeRef
        initializer = ` = "${constValue}";`;
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

      const isRequiredEnum = field.required && isEnumRef(field.type) && constValue === null;
      lines.push(...emitJsonPropertyAttributes(field.name, { isRequiredEnum }));
      lines.push(`        public ${csType} ${csFieldName} { get; ${setterModifier}set; }${initializer}`);
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
 * If the given TypeRef is a single-value enum (a discriminator const
 * masquerading as an enum), return the wire value as a raw string so the
 * emitter can lock the field down with a const initializer and non-public
 * setter. Returns null for any other type.
 */
function singleValueEnumConst(ref: TypeRef, enumConstByName: Map<string, string>): string | null {
  // OpenAPI `enum: [value]` (single-value) is normalized by the IR to a
  // LiteralType on the field, not an EnumRef.
  if (ref.kind === 'literal') {
    if (ref.value === null) return null;
    if (typeof ref.value === 'string' || typeof ref.value === 'number' || typeof ref.value === 'boolean') {
      return String(ref.value);
    }
    return null;
  }
  if (ref.kind !== 'enum') return null;
  if (ref.values && ref.values.length === 1) {
    const v = ref.values[0] as string | number | { value: string | number };
    if (typeof v === 'string' || typeof v === 'number') return String(v);
    return String(v.value);
  }
  return enumConstByName.get(ref.name) ?? null;
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

function humanize(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase();
}
