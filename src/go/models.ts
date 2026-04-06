import type { Model, EmitterContext, GeneratedFile } from '@workos/oagen';
import { mapTypeRef } from './type-map.js';
import { className, fieldName } from './naming.js';

/**
 * Check if a model is a list wrapper (envelope for pagination).
 * List wrappers have a `data` array field and a `list_metadata` or `listMetadata` field.
 */
export function isListWrapperModel(model: Model): boolean {
  const hasData = model.fields.some((f) => f.name === 'data' && f.type.kind === 'array');
  const hasListMetadata = model.fields.some((f) => f.name === 'list_metadata' || f.name === 'listMetadata');
  return hasData && hasListMetadata;
}

/**
 * Check if a model is list metadata (e.g., ListMetadata, FooListListMetadata).
 */
export function isListMetadataModel(model: Model): boolean {
  const lower = model.name.toLowerCase();
  return lower === 'listmetadata' || lower.endsWith('listlistmetadata');
}

/**
 * Generate Go struct definitions from IR Models.
 * All models go into a single models.go file for the flat package.
 */
export function generateModels(models: Model[], ctx: EmitterContext): GeneratedFile[] {
  if (models.length === 0) return [];

  const files: GeneratedFile[] = [];
  const lines: string[] = [];

  lines.push(`package ${ctx.namespace}`);
  lines.push('');

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
  for (const [, names] of hashGroups) {
    if (names.length <= 1) continue;
    const sorted = [...names].sort();
    const canonical = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      aliasOf.set(sorted[i], canonical);
    }
  }

  for (const model of models) {
    if (isListWrapperModel(model) || isListMetadataModel(model)) continue;

    const structName = className(model.name);

    // If this model is a dedup alias, emit a type alias
    const canonicalName = aliasOf.get(model.name);
    if (canonicalName) {
      const canonicalStruct = className(canonicalName);
      lines.push(`// ${structName} is an alias for ${canonicalStruct}.`);
      lines.push(`type ${structName} = ${canonicalStruct}`);
      lines.push('');
      continue;
    }

    // Emit struct
    if (model.description) {
      const descLines = model.description.split('\n').filter((l) => l.trim());
      lines.push(`// ${structName} ${lowerFirst(descLines[0])}`);
      for (let i = 1; i < descLines.length; i++) {
        lines.push(`// ${descLines[i].trim()}`);
      }
    } else {
      lines.push(`// ${structName} represents a ${humanize(model.name)}.`);
    }
    lines.push(`type ${structName} struct {`);

    // Deduplicate fields by Go field name
    const seenFieldNames = new Set<string>();
    for (const field of model.fields) {
      const goFieldName = fieldName(field.name);
      if (seenFieldNames.has(goFieldName)) continue;
      seenFieldNames.add(goFieldName);

      const isOptional = !field.required;
      const goType = isOptional ? makeOptional(mapTypeRef(field.type)) : mapTypeRef(field.type);

      const jsonTag = field.required ? `json:"${field.name}"` : `json:"${field.name},omitempty"`;

      if (field.description) {
        const fdLines = field.description.split('\n').filter((l) => l.trim());
        lines.push(`\t// ${goFieldName} is ${lowerFirst(fdLines[0])}`);
        for (let i = 1; i < fdLines.length; i++) {
          lines.push(`\t// ${fdLines[i].trim()}`);
        }
      }
      lines.push(`\t${goFieldName} ${goType} \`${jsonTag}\``);
    }

    lines.push('}');
    lines.push('');
  }

  files.push({
    path: 'models.go',
    content: lines.join('\n'),
    overwriteExisting: true,
  });

  return files;
}

/**
 * Make a Go type optional (pointer) if it isn't already.
 */
function makeOptional(goType: string): string {
  if (goType.startsWith('*') || goType.startsWith('[]') || goType.startsWith('map[')) {
    return goType;
  }
  return `*${goType}`;
}

function structuralHash(model: Model): string {
  return model.fields
    .map((f) => `${f.name}:${JSON.stringify(f.type)}:${f.required}`)
    .sort()
    .join('|');
}

function humanize(name: string): string {
  let result = name.replace(/([a-z])([A-Z])/g, '$1 $2');
  result = result.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return result.toLowerCase();
}

function lowerFirst(s: string): string {
  if (!s) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}
