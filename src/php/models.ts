import type { Model, EmitterContext, GeneratedFile, TypeRef, Field } from '@workos/oagen';
import { walkTypeRef } from '@workos/oagen';
import { mapTypeRef } from './type-map.js';
import { className, fieldName, fileName } from './naming.js';

/**
 * Generate PHP readonly model classes from IR Model definitions.
 */
export function generateModels(models: Model[], ctx: EmitterContext): GeneratedFile[] {
  if (models.length === 0) return [];

  const enumNames = new Set(ctx.spec.enums.map((e) => e.name));
  const files: GeneratedFile[] = [];

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

    const lines: string[] = [];

    lines.push('<?php');
    lines.push('');
    lines.push(`namespace ${ctx.namespacePascal}\\Models;`);
    lines.push('');

    // Collect imports
    const imports = collectModelImports(deduplicatedFields, ctx);
    if (imports.length > 0) {
      for (const imp of imports) {
        lines.push(`use ${imp};`);
      }
      lines.push('');
    }

    // Class declaration
    if (model.description) {
      lines.push('/**');
      lines.push(` * ${model.description}`);
      lines.push(' */');
    }
    lines.push(`readonly class ${phpClassName} implements \\JsonSerializable`);
    lines.push('{');

    // Constructor with promoted properties
    lines.push('    public function __construct(');
    const requiredFields = deduplicatedFields.filter((f) => f.required);
    const optionalFields = deduplicatedFields.filter((f) => !f.required);
    const allFields = [...requiredFields, ...optionalFields];

    for (let i = 0; i < allFields.length; i++) {
      const f = allFields[i];
      const phpType = mapTypeRef(f.type);
      const phpProp = fieldName(f.name);
      const isOptional = !f.required;
      const defaultVal = isOptional ? ' = null' : '';

      // Use nullable prefix only if the type doesn't already have ? or is not union
      const typeHint =
        isOptional && !phpType.includes('|') && !phpType.startsWith('?')
          ? `?${phpType}`
          : isOptional && phpType.includes('|')
            ? `${phpType}|null`
            : phpType;

      const comma = i < allFields.length - 1 ? ',' : ',';
      lines.push(`        public ${typeHint} $${phpProp}${defaultVal}${comma}`);
    }
    lines.push('    ) {}');
    lines.push('');

    // fromArray factory method
    lines.push('    /**');
    lines.push('     * @param array<string, mixed> $data');
    lines.push('     */');
    lines.push('    public static function fromArray(array $data): static');
    lines.push('    {');
    lines.push('        return new static(');

    for (let i = 0; i < allFields.length; i++) {
      const f = allFields[i];
      const phpProp = fieldName(f.name);
      const wire = f.name; // Preserve original wire name for deserialization
      const comma = i < allFields.length - 1 ? ',' : ',';
      const deserExpr = generateFromArrayExpression(f.type, `$data['${wire}']`, !f.required, ctx, enumNames);
      lines.push(`            ${phpProp}: ${deserExpr}${comma}`);
    }

    lines.push('        );');
    lines.push('    }');
    lines.push('');

    // toArray method
    lines.push('    /**');
    lines.push('     * @return array<string, mixed>');
    lines.push('     */');
    lines.push('    public function toArray(): array');
    lines.push('    {');
    lines.push('        return array_filter([');
    for (const f of allFields) {
      const phpProp = fieldName(f.name);
      const wire = f.name;
      const serExpr = generateToArrayExpression(f.type, `$this->${phpProp}`, enumNames);
      lines.push(`            '${wire}' => ${serExpr},`);
    }
    lines.push('        ], fn (\\$v) => \\$v !== null);');
    lines.push('    }');
    lines.push('');

    // jsonSerialize
    lines.push('    /**');
    lines.push('     * @return array<string, mixed>');
    lines.push('     */');
    lines.push('    public function jsonSerialize(): array');
    lines.push('    {');
    lines.push('        return $this->toArray();');
    lines.push('    }');

    lines.push('}');

    files.push({
      path: `lib/Models/${phpFileName}.php`,
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

function collectModelImports(fields: Field[], ctx: EmitterContext): string[] {
  const imports = new Set<string>();
  for (const f of fields) {
    walkTypeRef(f.type, {
      enum: (ref) => {
        imports.add(`${ctx.namespacePascal}\\Enums\\${className(ref.name)}`);
      },
    });
  }
  return [...imports].sort();
}

function generateFromArrayExpression(
  ref: TypeRef,
  accessor: string,
  optional: boolean,
  _ctx: EmitterContext,
  enumNames: Set<string>,
): string {
  if (optional) {
    const innerExpr = generateFromArrayExpression(
      ref.kind === 'nullable' ? ref.inner : ref,
      accessor,
      false,
      _ctx,
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
        return `${className(ref.name)}::tryFrom(${accessor}) ?? ${accessor}`;
      }
      return `${className(ref.name)}::fromArray(${accessor})`;
    case 'enum':
      return `${className(ref.name)}::tryFrom(${accessor}) ?? ${accessor}`;
    case 'array':
      if (ref.items.kind === 'model') {
        if (enumNames.has(ref.items.name)) {
          return `array_map(fn (\\$item) => ${className(ref.items.name)}::tryFrom(\\$item) ?? \\$item, ${accessor})`;
        }
        return `array_map(fn (\\$item) => ${className(ref.items.name)}::fromArray(\\$item), ${accessor})`;
      }
      if (ref.items.kind === 'enum') {
        return `array_map(fn (\\$item) => ${className(ref.items.name)}::tryFrom(\\$item) ?? \\$item, ${accessor})`;
      }
      return accessor;
    case 'nullable': {
      const innerExpr = generateFromArrayExpression(ref.inner, accessor, false, _ctx, enumNames);
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
        return `${accessor}?->format(\\DateTimeInterface::RFC3339_EXTENDED)`;
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
          return `array_map(fn (\\$item) => \\$item instanceof \\BackedEnum ? \\$item->value : \\$item, ${accessor} ?? [])`;
        }
        return `array_map(fn (\\$item) => \\$item->toArray(), ${accessor} ?? [])`;
      }
      if (ref.items.kind === 'enum') {
        return `array_map(fn (\\$item) => \\$item instanceof \\BackedEnum ? \\$item->value : \\$item, ${accessor} ?? [])`;
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
