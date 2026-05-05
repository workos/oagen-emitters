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
 * Resolve a degenerate union to a single TypeRef when possible.
 * - allOf: PHP collapses to the first variant (mirrors `mapTypeRef`).
 * - oneOf/anyOf where every variant has the same generated PHP type: collapse
 *   to that variant (e.g. discriminated unions whose branches the IR pinned to
 *   one model name).
 * Returns null when the union is genuinely polymorphic.
 */
function resolveDegenerateUnion(ref: TypeRef): TypeRef | null {
  if (ref.kind !== 'union') return null;
  if (ref.compositionKind === 'allOf') return ref.variants[0] ?? null;
  if (ref.variants.length === 0) return null;
  const signature = (v: TypeRef): string => {
    if (v.kind === 'model') return `model:${v.name}`;
    if (v.kind === 'enum') return `enum:${v.name}`;
    return `kind:${v.kind}`;
  };
  const first = ref.variants[0];
  const firstSig = signature(first);
  for (const v of ref.variants) {
    if (signature(v) !== firstSig) return null;
  }
  return first;
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
  // Literal fields have a statically known value; use ?? with a default
  // so deserialization is resilient when the API omits the key.
  if (ref.kind === 'literal') {
    return `$data['${wireName}'] ?? ${phpLiteralDefault(ref.value)}`;
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
    case 'union': {
      // Discriminated union: dispatch via match() on the discriminator
      // property to call the matching variant's fromArray. Unknown values
      // pass through as raw arrays so callers can introspect.
      if (ref.discriminator && ref.discriminator.mapping) {
        const entries = Object.entries(ref.discriminator.mapping);
        if (entries.length > 0) {
          const arms = entries
            .map(([value, modelName]) => `'${value}' => ${className(modelName)}::fromArray(${accessor})`)
            .join(', ');
          return `match (${accessor}['${ref.discriminator.property}'] ?? null) { ${arms}, default => ${accessor} }`;
        }
      }
      const resolved = resolveDegenerateUnion(ref);
      if (resolved) return generateFromArrayValue(resolved, accessor);
      return accessor;
    }
    case 'map':
      return accessor;
    case 'literal':
      return accessor;
  }
}

/** Convert a LiteralType value to a PHP default expression for use with ??. */
function phpLiteralDefault(value: string | number | boolean | null): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return `'${value}'`;
  return String(value);
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
    case 'union': {
      const resolved = resolveDegenerateUnion(ref);
      return resolved ? isComplexType(resolved) : false;
    }
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
    case 'union': {
      const resolved = resolveDegenerateUnion(ref);
      if (resolved) return generateToArrayValue(resolved, accessor, nullable);
      return accessor;
    }
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
