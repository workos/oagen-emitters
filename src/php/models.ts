import type { Model, TypeRef, EmitterContext, GeneratedFile } from '@workos/oagen';
import { mapTypeRef, mapTypeRefForPHPDoc } from './type-map.js';
import { className, enumClassName, fieldName } from './naming.js';
import { phpDocComment } from './utils.js';

// Import and re-export shared model detection utilities
import { isListMetadataModel, isListWrapperModel } from '../shared/model-utils.js';
export { isListMetadataModel, isListWrapperModel };

/**
 * Generate PHP model files from IR models.
 */
export function generateModels(models: Model[], ctx: EmitterContext): GeneratedFile[] {
  if (models.length === 0) return [];

  // Build structural hash for deduplication
  const modelHashMap = new Map<string, string>();
  const hashGroups = new Map<string, string[]>();
  for (const model of models) {
    if (isListMetadataModel(model)) continue;
    if (isListWrapperModel(model)) continue;
    const hash = structuralHash(model);
    modelHashMap.set(model.name, hash);
    if (!hashGroups.has(hash)) hashGroups.set(hash, []);
    hashGroups.get(hash)!.push(model.name);
  }

  // Pick canonical for each duplicate group (shortest class name wins)
  const aliasOf = new Map<string, string>();
  for (const [hash, names] of hashGroups) {
    if (names.length <= 1) continue;
    if (hash === '') continue;
    const sorted = [...names].sort((a, b) => className(a).length - className(b).length);
    const canonical = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      aliasOf.set(sorted[i], canonical);
    }
  }

  const files: GeneratedFile[] = [];

  // Emit shared JsonSerializableTrait once
  files.push({
    path: 'lib/Resource/JsonSerializableTrait.php',
    content: [
      `namespace ${ctx.namespacePascal}\\Resource;`,
      '',
      'trait JsonSerializableTrait',
      '{',
      '    public function jsonSerialize(): array',
      '    {',
      '        return $this->toArray();',
      '    }',
      '}',
    ].join('\n'),
    overwriteExisting: true,
  });

  for (const model of models) {
    if (isListMetadataModel(model)) continue;
    if (isListWrapperModel(model)) continue;
    if (aliasOf.has(model.name)) continue; // skip structural duplicates

    const name = className(model.name);
    const lines: string[] = [];

    // No <?php here — the file header from fileHeader() provides it
    lines.push(`namespace ${ctx.namespacePascal}\\Resource;`);
    lines.push('');
    if (model.description) {
      lines.push(...phpDocComment(model.description, 0));
    }
    lines.push(`readonly class ${name} implements \\JsonSerializable`);
    lines.push('{');
    lines.push('    use JsonSerializableTrait;');
    lines.push('');

    // Constructor with promoted properties
    lines.push('    public function __construct(');
    const requiredFields = model.fields.filter((f) => f.required);
    const optionalFields = model.fields.filter((f) => !f.required);
    // Deduplicate fields that map to the same PHP name
    const seenNames = new Set<string>();
    const allFields = [...requiredFields, ...optionalFields].filter((f) => {
      const phpName = fieldName(f.name);
      if (seenNames.has(phpName)) return false;
      seenNames.add(phpName);
      return true;
    });

    for (let i = 0; i < allFields.length; i++) {
      const field = allFields[i];
      const phpName = fieldName(field.name);
      const phpType = mapTypeRef(field.type);
      const isOptional = !field.required;
      const comma = i < allFields.length - 1 ? ',' : ',';

      const varDocType = mapTypeRefForPHPDoc(field.type);
      const varNullSuffix = isOptional && !varDocType.endsWith('|null') ? '|null' : '';
      const varAnnotation = needsVarAnnotation(field.type) ? `@var ${varDocType}${varNullSuffix}` : null;
      if (field.description || field.deprecated || varAnnotation) {
        const parts: string[] = [];
        if (field.description) parts.push(field.description);
        if (varAnnotation) parts.push(varAnnotation);
        if (field.deprecated) parts.push('@deprecated');
        lines.push(...phpDocComment(parts.join('\n'), 8));
      }

      if (isOptional) {
        const nullableType = phpType.startsWith('?') ? phpType : `?${phpType}`;
        lines.push(`        public ${nullableType} $${phpName} = null${comma}`);
      } else {
        lines.push(`        public ${phpType} $${phpName}${comma}`);
      }
    }
    lines.push('    ) {');
    lines.push('    }');

    // fromArray factory method
    lines.push('');
    lines.push(`    public static function fromArray(array $data): self`);
    lines.push('    {');
    lines.push(`        return new self(`);
    for (let i = 0; i < allFields.length; i++) {
      const field = allFields[i];
      const phpName = fieldName(field.name);
      const wireName = field.name;
      const comma = i < allFields.length - 1 ? ',' : ',';
      const accessor = generateFromArrayAccessor(field.type, wireName, field.required);

      lines.push(`            ${phpName}: ${accessor}${comma}`);
    }
    lines.push('        );');
    lines.push('    }');

    // toArray method
    lines.push('');
    lines.push('    public function toArray(): array');
    lines.push('    {');
    lines.push('        return [');
    for (const field of allFields) {
      const phpName = fieldName(field.name);
      const wireName = field.name;
      const serialized = generateToArrayValue(field.type, `$this->${phpName}`, !field.required);
      lines.push(`            '${wireName}' => ${serialized},`);
    }
    lines.push('        ];');
    lines.push('    }');

    lines.push('}');

    files.push({
      path: `lib/Resource/${name}.php`,
      content: lines.join('\n'),
      overwriteExisting: true,
    });
  }

  return files;
}

/**
 * Generate the fromArray accessor expression for a field.
 */
function generateFromArrayAccessor(ref: TypeRef, wireName: string, required: boolean): string {
  // For nullable types, always guard with isset() regardless of required flag
  const isNullable = ref.kind === 'nullable';
  if (!required || isNullable) {
    const innerRef = isNullable ? ref.inner : ref;
    const inner = generateFromArrayValue(innerRef, `$data['${wireName}']`);
    if (isComplexType(innerRef)) {
      return `isset($data['${wireName}']) ? ${inner} : null`;
    }
    if (isNullable) {
      return `$data['${wireName}'] ?? null`;
    }
    return `$data['${wireName}'] ?? null`;
  }
  // Required field: access directly
  return generateFromArrayValue(ref, `$data['${wireName}']`);
}

/**
 * Generate the fromArray value expression for a type.
 */
function generateFromArrayValue(ref: TypeRef, accessor: string): string {
  switch (ref.kind) {
    case 'primitive':
      if (ref.format === 'date-time') {
        // Always access directly — nullable fields are already guarded by isset() in
        // generateFromArrayAccessor(). Required fields should error if missing.
        return `new \\DateTimeImmutable(${accessor})`;
      }
      return accessor;
    case 'model': {
      const name = className(ref.name);
      return `${name}::fromArray(${accessor})`;
    }
    case 'enum': {
      const name = enumClassName(ref.name);
      return `${name}::from(${accessor})`;
    }
    case 'array':
      if (ref.items.kind === 'model') {
        const itemName = className(ref.items.name);
        return `array_map(fn ($item) => ${itemName}::fromArray($item), ${accessor})`;
      }
      if (ref.items.kind === 'enum') {
        const itemName = enumClassName(ref.items.name);
        return `array_map(fn ($item) => ${itemName}::from($item), ${accessor})`;
      }
      if (ref.items.kind === 'primitive' && ref.items.format === 'date-time') {
        return `array_map(fn ($item) => new \\DateTimeImmutable($item), ${accessor})`;
      }
      return accessor;
    case 'nullable':
      return generateFromArrayValue(ref.inner, accessor);
    case 'union':
      return accessor;
    case 'map':
      return accessor;
    case 'literal':
      return accessor;
  }
}

/**
 * Check if a TypeRef needs special handling (not a simple key access).
 */
function isComplexType(ref: TypeRef): boolean {
  switch (ref.kind) {
    case 'primitive':
      return ref.format === 'date-time';
    case 'model':
    case 'enum':
      return true;
    case 'array':
      return isComplexType(ref.items);
    case 'nullable':
      return isComplexType(ref.inner);
    default:
      return false;
  }
}

/**
 * Generate the toArray serialization expression for a field value.
 */
function generateToArrayValue(ref: TypeRef, accessor: string, nullable = false): string {
  const ns = nullable ? '?' : '';
  switch (ref.kind) {
    case 'primitive':
      if (ref.format === 'date-time') {
        return `${accessor}${ns}->format(\\DateTimeInterface::RFC3339_EXTENDED)`;
      }
      return accessor;
    case 'model':
      return `${accessor}${ns}->toArray()`;
    case 'enum':
      return nullable ? `${accessor}?->value` : `${accessor}->value`;
    case 'array':
      if (ref.items.kind === 'model') {
        return nullable
          ? `${accessor} !== null ? array_map(fn ($item) => $item->toArray(), ${accessor}) : null`
          : `array_map(fn ($item) => $item->toArray(), ${accessor})`;
      }
      if (ref.items.kind === 'enum') {
        return nullable
          ? `${accessor} !== null ? array_map(fn ($item) => $item->value, ${accessor}) : null`
          : `array_map(fn ($item) => $item->value, ${accessor})`;
      }
      if (ref.items.kind === 'primitive' && ref.items.format === 'date-time') {
        return nullable
          ? `${accessor} !== null ? array_map(fn ($item) => $item->format(\\DateTimeInterface::RFC3339_EXTENDED), ${accessor}) : null`
          : `array_map(fn ($item) => $item->format(\\DateTimeInterface::RFC3339_EXTENDED), ${accessor})`;
      }
      return accessor;
    case 'nullable':
      return generateToArrayValue(ref.inner, accessor, true);
    case 'map':
      return accessor;
    case 'union':
      return accessor;
    case 'literal':
      return accessor;
  }
}

/**
 * Check if a TypeRef needs a @var PHPDoc annotation because the PHP type hint
 * loses information (e.g., `array` vs `array<ConnectionDomain>`).
 */
function needsVarAnnotation(ref: TypeRef): boolean {
  switch (ref.kind) {
    case 'array':
    case 'map':
      return true;
    case 'nullable':
      return needsVarAnnotation(ref.inner);
    default:
      return false;
  }
}

function structuralHash(model: Model): string {
  return model.fields
    .map((f) => `${f.name}:${JSON.stringify(f.type)}:${f.required}`)
    .sort()
    .join('|');
}
