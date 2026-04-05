import type { Model, TypeRef, EmitterContext, GeneratedFile } from '@workos/oagen';
import { mapTypeRef } from './type-map.js';
import { className, fieldName } from './naming.js';

/**
 * Check if a model is a list metadata model (e.g., ListMetadata).
 */
export function isListMetadataModel(model: Model): boolean {
  return /^list.?metadata$/i.test(model.name);
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
  const modelMap = new Map(ctx.spec.models.map((m) => [m.name, m]));

  for (const model of models) {
    if (isListMetadataModel(model)) continue;
    if (isListWrapperModel(model)) continue;

    const name = className(model.name);
    const lines: string[] = [];

    // No <?php here — the file header from fileHeader() provides it
    lines.push(`namespace ${ctx.namespacePascal}\\Resource;`);
    lines.push('');
    lines.push(`readonly class ${name} implements \\JsonSerializable`);
    lines.push('{');

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
      const accessor = generateFromArrayAccessor(field.type, wireName, field.required, modelMap);

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

    // jsonSerialize
    lines.push('');
    lines.push('    public function jsonSerialize(): array');
    lines.push('    {');
    lines.push('        return $this->toArray();');
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
function generateFromArrayAccessor(
  ref: TypeRef,
  wireName: string,
  required: boolean,
  modelMap: Map<string, Model>,
): string {
  if (!required) {
    // Optional field: use ?? null or isset() for complex types
    const inner = generateFromArrayValue(ref, `$data['${wireName}']`, modelMap, { insideIsset: true });
    if (isComplexType(ref)) {
      return `isset($data['${wireName}']) ? ${inner} : null`;
    }
    return `$data['${wireName}'] ?? null`;
  }
  // Required field: access directly
  return generateFromArrayValue(ref, `$data['${wireName}']`, modelMap, { insideIsset: false });
}

/**
 * Generate the fromArray value expression for a type.
 */
function generateFromArrayValue(
  ref: TypeRef,
  accessor: string,
  _modelMap: Map<string, Model>,
  opts: { insideIsset: boolean } = { insideIsset: false },
): string {
  switch (ref.kind) {
    case 'primitive':
      if (ref.format === 'date-time') {
        // Inside isset(), the value is guaranteed non-null — no fallback needed.
        // Outside isset(), use ?? 'now' to handle null gracefully.
        return opts.insideIsset
          ? `new \\DateTimeImmutable(${accessor})`
          : `new \\DateTimeImmutable(${accessor} ?? 'now')`;
      }
      return accessor;
    case 'model': {
      const name = className(ref.name);
      return `${name}::fromArray(${accessor})`;
    }
    case 'enum': {
      const name = className(ref.name);
      return `${name}::tryFrom(${accessor}) ?? ${accessor}`;
    }
    case 'array':
      if (ref.items.kind === 'model') {
        const itemName = className(ref.items.name);
        return `array_map(fn ($item) => ${itemName}::fromArray($item), ${accessor})`;
      }
      return accessor;
    case 'nullable':
      return generateFromArrayValue(ref.inner, accessor, _modelMap, opts);
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
