import type { Model, TypeRef, EmitterContext, GeneratedFile } from '@workos/oagen';
import { mapTypeRef } from './type-map.js';
import { className, fieldName } from './naming.js';
import { phpDocComment } from './utils.js';

/**
 * Check if a model is a list metadata model (e.g., ListMetadata).
 */
export function isListMetadataModel(model: Model): boolean {
  return /list.?metadata$/i.test(model.name);
}

/**
 * Check if a model is a list wrapper (has `data` array + `list_metadata`).
 */
export function isListWrapperModel(model: Model): boolean {
  const hasData = model.fields.some((f) => f.name === 'data' && f.type.kind === 'array');
  const hasListMeta = model.fields.some((f) => f.name === 'list_metadata' || f.name === 'listMetadata');
  return hasData && hasListMeta;
}

/**
 * Generate PHP model files from IR models.
 */
export function generateModels(models: Model[], ctx: EmitterContext): GeneratedFile[] {
  if (models.length === 0) return [];

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

      if (field.description || field.deprecated) {
        const parts: string[] = [];
        if (field.description) parts.push(field.description);
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
      const name = className(ref.name);
      return `${name}::from(${accessor})`;
    }
    case 'array':
      if (ref.items.kind === 'model') {
        const itemName = className(ref.items.name);
        return `array_map(fn ($item) => ${itemName}::fromArray($item), ${accessor})`;
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
      return nullable ? `${accessor} instanceof \\BackedEnum ? ${accessor}->value : ${accessor}` : `${accessor}->value`;
    case 'array':
      if (ref.items.kind === 'model') {
        return nullable
          ? `array_map(fn ($item) => $item->toArray(), ${accessor} ?? [])`
          : `array_map(fn ($item) => $item->toArray(), ${accessor})`;
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
