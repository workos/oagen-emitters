import type { Model, EmitterContext, GeneratedFile, TypeRef, Field } from '@workos/oagen';
import { mapTypeRef } from './type-map.js';
import { className, enumClassName, fieldName, fileName } from './naming.js';

/**
 * Look up an existing model interface from the API surface by trying various name forms.
 */
function findSurfaceInterface(
  modelName: string,
  ctx: EmitterContext,
): { fields: Record<string, { name: string }> } | undefined {
  const surface = ctx.apiSurface;
  if (!surface?.interfaces) return undefined;

  const phpName = className(modelName);
  // Try exact match, then the PHP class name
  return surface.interfaces[modelName] ?? surface.interfaces[phpName];
}

/**
 * Build RESOURCE_ATTRIBUTES and RESPONSE_TO_RESOURCE_KEY from surface data when available.
 * Falls back to generating from IR fields when no surface data exists.
 */
function buildModelAttributes(
  model: Model,
  deduplicatedFields: Field[],
  ctx: EmitterContext,
): { attributes: string[]; mapping: Array<{ wire: string; attr: string }>; isNameCollision: boolean } {
  const surfaceIface = findSurfaceInterface(model.name, ctx);

  if (surfaceIface) {
    // Use the surface interface fields — preserves original order, key convention, and field subset
    const surfaceFieldNames = Object.keys(surfaceIface.fields);
    const attributes: string[] = [];
    const mapping: Array<{ wire: string; attr: string }> = [];

    // Build a map from camelCase/snake_case attr name to wire name
    const attrToWire = new Map<string, string>();
    for (const f of deduplicatedFields) {
      const camelAttr = fieldName(f.name);
      attrToWire.set(camelAttr, f.name);
      attrToWire.set(f.name, f.name); // Also map snake_case → snake_case for identity-mapped models
    }

    for (const surfaceAttr of surfaceFieldNames) {
      const wire = attrToWire.get(surfaceAttr);
      if (wire) {
        attributes.push(surfaceAttr);
        mapping.push({ wire, attr: surfaceAttr });
      }
    }

    // If no fields matched, this is a name collision — the surface interface represents
    // a different model with the same name. Signal to skip generation.
    if (attributes.length === 0) {
      return { attributes: [], mapping: [], isNameCollision: true };
    }

    // For models with surface data, DON'T append new fields — preserve exact old field set for BC.
    // New spec fields are still accessible via the raw response array.
    return { attributes, mapping, isNameCollision: false };
  }

  // No surface data — generate fresh with camelCase convention (default for new models)
  return { ...buildDefaultAttributes(deduplicatedFields), isNameCollision: false };
}

/** Generate default attributes for new models (no surface data). */
function buildDefaultAttributes(deduplicatedFields: Field[]): {
  attributes: string[];
  mapping: Array<{ wire: string; attr: string }>;
} {
  const attributes: string[] = [];
  const mapping: Array<{ wire: string; attr: string }> = [];

  for (const f of deduplicatedFields) {
    const attr = fieldName(f.name);
    attributes.push(attr);
    mapping.push({ wire: f.name, attr });
  }

  return { attributes, mapping };
}

interface FieldMapping {
  field: Field;
  phpName: string;
  wireName: string;
}

/**
 * Resolve field mappings using surface data for BC, or default camelCase convention.
 */
function resolveFieldMappings(model: Model, deduplicatedFields: Field[], ctx: EmitterContext): FieldMapping[] {
  const surfaceIface = findSurfaceInterface(model.name, ctx);

  if (surfaceIface) {
    const surfaceFieldNames = Object.keys(surfaceIface.fields);
    const fieldByWire = new Map<string, Field>();
    const fieldByCamel = new Map<string, Field>();
    for (const f of deduplicatedFields) {
      fieldByWire.set(f.name, f);
      fieldByCamel.set(fieldName(f.name), f);
    }

    const mappings: FieldMapping[] = [];
    const used = new Set<string>();

    for (const surfaceAttr of surfaceFieldNames) {
      const byWire = fieldByWire.get(surfaceAttr);
      const byCamel = fieldByCamel.get(surfaceAttr);
      const field = byWire ?? byCamel;
      if (field && !used.has(field.name)) {
        used.add(field.name);
        mappings.push({
          field,
          phpName: surfaceAttr,
          wireName: field.name,
        });
      }
    }

    return mappings;
  }

  return deduplicatedFields.map((f) => ({
    field: f,
    phpName: fieldName(f.name),
    wireName: f.name,
  }));
}

/**
 * Generate PHP model classes as readonly classes with constructor promotion.
 */
export function generateModels(models: Model[], ctx: EmitterContext): GeneratedFile[] {
  if (models.length === 0) return [];

  const files: GeneratedFile[] = [];
  const enumNames = new Set(ctx.spec.enums.map((e) => e.name));

  for (const model of models) {
    if (isListWrapperModel(model)) continue;
    if (isListMetadataModel(model)) continue;

    const phpClassName = className(model.name);
    const phpFileName = fileName(model.name);

    // Deduplicate fields that map to the same camelCase name
    const seenFieldNames = new Set<string>();
    const deduplicatedFields = model.fields.filter((f) => {
      const phpName = fieldName(f.name);
      if (seenFieldNames.has(phpName)) return false;
      seenFieldNames.add(phpName);
      return true;
    });

    // Name collision check via surface data
    const { isNameCollision } = buildModelAttributes(model, deduplicatedFields, ctx);
    if (isNameCollision) continue;

    // Custom constructor: the old model has a custom constructFromResponse() override.
    const surfaceIface = findSurfaceInterface(model.name, ctx);
    if (surfaceIface && (surfaceIface as any).hasCustomConstructor) continue;

    // Resolve field mappings (order and naming from surface data or default camelCase)
    const fieldMappings = resolveFieldMappings(model, deduplicatedFields, ctx);
    const required = fieldMappings.filter((m) => m.field.required);
    const optional = fieldMappings.filter((m) => !m.field.required);
    const ordered = [...required, ...optional];

    const lines: string[] = [];

    lines.push('');
    lines.push(`namespace ${ctx.namespacePascal}\\Resource;`);
    lines.push('');

    if (model.description) {
      lines.push('/**');
      lines.push(` * ${model.description}`);
      lines.push(' */');
    }
    lines.push(`readonly class ${phpClassName} implements \\JsonSerializable`);
    lines.push('{');

    // Constructor with promoted properties
    lines.push('    public function __construct(');
    for (const m of ordered) {
      const phpType = mapTypeRef(m.field.type);
      if (m.field.required) {
        lines.push(`        public ${phpType} $${m.phpName},`);
      } else {
        const isAlreadyNullable = phpType.startsWith('?');
        const nullableType = isAlreadyNullable ? phpType : `?${phpType}`;
        lines.push(`        public ${nullableType} $${m.phpName} = null,`);
      }
    }
    lines.push('    ) {}');
    lines.push('');

    // fromArray factory — deserializes from wire-format array
    lines.push('    /**');
    lines.push('     * @param array<string, mixed> $data');
    lines.push('     * @return static');
    lines.push('     */');
    lines.push('    public static function fromArray(array $data): static');
    lines.push('    {');
    lines.push('        return new static(');
    for (const m of ordered) {
      const accessor = `$data['${m.wireName}']`;
      const expr = generateFromArrayExpression(m.field.type, accessor, !m.field.required, enumNames);
      lines.push(`            ${m.phpName}: ${expr},`);
    }
    lines.push('        );');
    lines.push('    }');
    lines.push('');

    // constructFromResponse — BC alias for hand-written code that calls this method
    lines.push('    /**');
    lines.push('     * @param array<string, mixed> $data');
    lines.push('     * @return static');
    lines.push('     * @deprecated Use fromArray() instead.');
    lines.push('     */');
    lines.push('    public static function constructFromResponse(array $data): static');
    lines.push('    {');
    lines.push('        return static::fromArray($data);');
    lines.push('    }');
    lines.push('');

    // toArray — serializes to wire-format array
    lines.push('    /**');
    lines.push('     * @return array<string, mixed>');
    lines.push('     */');
    lines.push('    public function toArray(): array');
    lines.push('    {');
    lines.push('        return [');
    for (const m of ordered) {
      const accessor = `$this->${m.phpName}`;
      const expr = generateToArrayExpression(m.field.type, accessor, enumNames);
      lines.push(`            '${m.wireName}' => ${expr},`);
    }
    lines.push('        ];');
    lines.push('    }');
    lines.push('');

    // jsonSerialize — delegates to toArray for JSON encoding
    lines.push('    /**');
    lines.push('     * @return array<string, mixed>');
    lines.push('     */');
    lines.push('    public function jsonSerialize(): array');
    lines.push('    {');
    lines.push('        return $this->toArray();');
    lines.push('    }');
    lines.push('}');

    files.push({
      path: `lib/Resource/${phpFileName}.php`,
      content: lines.join('\n'),
      integrateTarget: true,
      overwriteExisting: true,
    });
  }

  return files;
}

/** Check if a model is a list wrapper (has data + list_metadata fields). */
export function isListWrapperModel(model: Model): boolean {
  const dataField = model.fields.find((f) => f.name === 'data');
  const hasListMeta = model.fields.some((f) => f.name === 'list_metadata' || f.name === 'listMetadata');
  return !!(dataField && hasListMeta && dataField.type.kind === 'array');
}

/** Check if a model is a list metadata model. */
export function isListMetadataModel(model: Model): boolean {
  return /ListMetadata$/i.test(model.name) || model.name === 'ListMetadata';
}

function generateFromArrayExpression(
  ref: TypeRef,
  accessor: string,
  optional: boolean,
  enumNames: Set<string>,
): string {
  if (optional) {
    const innerExpr = generateFromArrayExpression(
      ref.kind === 'nullable' ? ref.inner : ref,
      accessor,
      false,
      enumNames,
    );
    return `isset(${accessor}) ? ${innerExpr} : null`;
  }

  switch (ref.kind) {
    case 'primitive':
      if (ref.format === 'date-time') {
        return `new \\DateTimeImmutable(${accessor})`;
      }
      return accessor;
    case 'model':
      // Parser may represent enum refs as model refs — check the enum set
      if (enumNames.has(ref.name)) {
        return `${enumClassName(ref.name)}::tryFrom(${accessor}) ?? ${accessor}`;
      }
      return `${className(ref.name)}::fromArray(${accessor})`;
    case 'enum':
      return `${enumClassName(ref.name)}::tryFrom(${accessor}) ?? ${accessor}`;
    case 'array':
      if (ref.items.kind === 'model') {
        if (enumNames.has(ref.items.name)) {
          return `array_map(fn ($item) => ${enumClassName(ref.items.name)}::tryFrom($item) ?? $item, ${accessor})`;
        }
        return `array_map(fn ($item) => ${className(ref.items.name)}::fromArray($item), ${accessor})`;
      }
      if (ref.items.kind === 'enum') {
        return `array_map(fn ($item) => ${enumClassName(ref.items.name)}::tryFrom($item) ?? $item, ${accessor})`;
      }
      return accessor;
    case 'nullable': {
      const innerExpr = generateFromArrayExpression(ref.inner, accessor, false, enumNames);
      return `${accessor} !== null ? ${innerExpr} : null`;
    }
    case 'union':
    case 'map':
    case 'literal':
      return accessor;
    default:
      return accessor;
  }
}

function generateToArrayExpression(ref: TypeRef, accessor: string, enumNames: Set<string>): string {
  switch (ref.kind) {
    case 'primitive':
      if (ref.format === 'date-time') {
        // Use Z suffix for BC with old BaseWorkOSResource (stored raw strings with Z)
        return `${accessor} !== null ? str_replace('+00:00', 'Z', ${accessor}->format(\\DateTimeInterface::RFC3339_EXTENDED)) : null`;
      }
      return accessor;
    case 'model':
      // Parser may represent enum refs as model refs — check the enum set
      if (enumNames.has(ref.name)) {
        return `${accessor} instanceof \\BackedEnum ? ${accessor}->value : ${accessor}`;
      }
      return `${accessor}?->toArray()`;
    case 'enum':
      return `${accessor} instanceof \\BackedEnum ? ${accessor}->value : ${accessor}`;
    case 'array':
      if (ref.items.kind === 'model') {
        if (enumNames.has(ref.items.name)) {
          return `array_map(fn ($item) => $item instanceof \\BackedEnum ? $item->value : $item, ${accessor} ?? [])`;
        }
        return `array_map(fn ($item) => $item->toArray(), ${accessor} ?? [])`;
      }
      if (ref.items.kind === 'enum') {
        return `array_map(fn ($item) => $item instanceof \\BackedEnum ? $item->value : $item, ${accessor} ?? [])`;
      }
      return accessor;
    case 'nullable':
      return generateToArrayExpression(ref.inner, accessor, enumNames);
    case 'union':
    case 'map':
    case 'literal':
      return accessor;
    default:
      return accessor;
  }
}
