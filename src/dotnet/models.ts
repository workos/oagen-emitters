import type { Model, EmitterContext, GeneratedFile, TypeRef } from '@workos/oagen';
import { mapTypeRef, isValueTypeRef } from './type-map.js';
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

  const files: GeneratedFile[] = [];

  // Build structural hash for deduplication
  const modelHashMap = new Map<string, string>();
  const hashGroups = new Map<string, string[]>();
  for (const model of models) {
    if (isListWrapperModel(model) || isListMetadataModel(model)) continue;
    const hash = structuralHash(model);
    modelHashMap.set(model.name, hash);
    if (!hashGroups.has(hash)) hashGroups.set(hash, []);
    hashGroups.get(hash)!.push(model.name);
  }

  // Pick canonical for each duplicate group
  const aliasOf = new Map<string, string>();
  for (const [hash, names] of hashGroups) {
    if (names.length <= 1) continue;
    if (hash === '') continue;
    const sorted = [...names].sort();
    const canonical = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      aliasOf.set(sorted[i], canonical);
    }
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
      let csType: string;
      let initializer = '';

      if (isOptional) {
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

      lines.push(`        [JsonProperty("${field.name}")]`);
      lines.push(`        [STJS.JsonPropertyName("${field.name}")]`);
      lines.push(`        public ${csType} ${csFieldName} { get; set; }${initializer}`);
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
 * Normalize a TypeRef for structural comparison.
 * Enum references are normalized to their values (not names) so that
 * structurally identical enums with different names still match.
 */
function normalizeTypeForHash(ref: TypeRef): any {
  if (ref.kind === 'enum') {
    // Normalize enum refs by their sorted values, not their name
    const vals = ref.values ? [...ref.values].sort() : [];
    return { kind: 'enum', values: vals };
  }
  if (ref.kind === 'nullable') {
    return { kind: 'nullable', inner: normalizeTypeForHash(ref.inner) };
  }
  if (ref.kind === 'array') {
    return { kind: 'array', items: normalizeTypeForHash(ref.items) };
  }
  if (ref.kind === 'union') {
    return { kind: 'union', variants: ref.variants.map(normalizeTypeForHash) };
  }
  if (ref.kind === 'map') {
    return { kind: 'map', valueType: normalizeTypeForHash(ref.valueType) };
  }
  return ref;
}

function structuralHash(model: Model): string {
  return model.fields
    .map((f) => `${f.name}:${JSON.stringify(normalizeTypeForHash(f.type))}:${f.required}`)
    .sort()
    .join('|');
}

function humanize(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase();
}
