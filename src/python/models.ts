import type { Model, EmitterContext, GeneratedFile } from '@workos/oagen';
import { assignModelsToServices, collectFieldDependencies } from '@workos/oagen';
import { mapTypeRef } from './type-map.js';
import { className, fieldName, fileName, resolveServiceDir, buildServiceNameMap } from './naming.js';
import { assignEnumsToServices } from './enums.js';

/**
 * Generate Python dataclass model files from IR Model definitions.
 * Each model becomes a single .py file with a dataclass, from_dict, and to_dict.
 */
export function generateModels(models: Model[], ctx: EmitterContext): GeneratedFile[] {
  if (models.length === 0) return [];

  const modelToService = assignModelsToServices(models, ctx.spec.services);
  const enumToService = assignEnumsToServices(ctx.spec.enums, ctx.spec.services);
  const serviceNameMap = buildServiceNameMap(ctx.spec.services, ctx);
  const resolveDir = (irService: string | undefined) =>
    irService ? resolveServiceDir(serviceNameMap.get(irService) ?? irService) : 'common';
  const modelMap = new Map(models.map((m) => [m.name, m]));
  const files: GeneratedFile[] = [];

  for (const model of models) {
    // Skip list metadata models only if they have generic names (e.g., ListMetadata)
    // but keep named ones like FooListListMetadata since they're imported by list wrappers
    if (isListMetadataModel(model) && model.name === 'ListMetadata') continue;

    const service = modelToService.get(model.name);
    const dirName = resolveDir(service);
    const modelClassName = className(model.name);

    // Deduplicate fields that map to the same snake_case name
    const seenFieldNames = new Set<string>();
    const deduplicatedFields = model.fields.filter((f) => {
      const pyName = fieldName(f.name);
      if (seenFieldNames.has(pyName)) return false;
      seenFieldNames.add(pyName);
      return true;
    });
    const dedupModel = { ...model, fields: deduplicatedFields };
    const deps = collectFieldDependencies(dedupModel);

    const lines: string[] = [];

    // Collect typing imports
    const typingImports = new Set<string>();
    typingImports.add('Any');
    typingImports.add('Dict');
    for (const field of deduplicatedFields) {
      collectTypingImports(field.type, typingImports);
    }
    const hasOptional = deduplicatedFields.some((f) => !f.required || f.type.kind === 'nullable');
    if (hasOptional) typingImports.add('Optional');

    lines.push('from __future__ import annotations');
    lines.push('');
    lines.push('from dataclasses import dataclass');
    lines.push(`from typing import ${[...typingImports].sort().join(', ')}`);

    // Import referenced models from their service's models package
    if (deps.models.size > 0) {
      lines.push('');
      for (const modelName of [...deps.models].sort()) {
        if (modelName === model.name) continue; // skip self
        const modelService = modelToService.get(modelName);
        const modelDir = resolveDir(modelService);
        if (modelDir === dirName) {
          lines.push(`from .${fileName(modelName)} import ${className(modelName)}`);
        } else {
          lines.push(`from ${ctx.namespace}.${modelDir}.models import ${className(modelName)}`);
        }
      }
    }

    // Import referenced enums from their service's models package
    if (deps.enums.size > 0) {
      for (const enumName of [...deps.enums].sort()) {
        const enumService = enumToService.get(enumName);
        const enumDir = resolveDir(enumService);
        if (enumDir === dirName) {
          lines.push(`from .${fileName(enumName)} import ${className(enumName)}`);
        } else {
          lines.push(`from ${ctx.namespace}.${enumDir}.models import ${className(enumName)}`);
        }
      }
    }

    lines.push('');
    lines.push('');

    // Dataclass definition
    if (model.description) {
      lines.push('@dataclass');
      lines.push(`class ${modelClassName}:`);
      lines.push(`    """${model.description}"""`);
    } else {
      lines.push('@dataclass');
      lines.push(`class ${modelClassName}:`);
    }

    lines.push('');

    // Sort fields: required first, then optional
    const requiredFields = deduplicatedFields.filter((f) => f.required && f.type.kind !== 'nullable');
    const optionalFields = deduplicatedFields.filter((f) => !f.required || f.type.kind === 'nullable');

    for (const field of requiredFields) {
      const pyFieldName = fieldName(field.name);
      const pyType = mapTypeRef(field.type);
      if (field.description) {
        lines.push(`    ${pyFieldName}: ${pyType}`);
        lines.push(`    """${field.description}"""`);
      } else {
        lines.push(`    ${pyFieldName}: ${pyType}`);
      }
    }

    for (const field of optionalFields) {
      const pyFieldName = fieldName(field.name);
      const innerType = field.type.kind === 'nullable' ? mapTypeRef(field.type.inner) : mapTypeRef(field.type);
      const pyType = `Optional[${innerType}]`;
      if (field.description) {
        lines.push(`    ${pyFieldName}: ${pyType} = None`);
        lines.push(`    """${field.description}"""`);
      } else {
        lines.push(`    ${pyFieldName}: ${pyType} = None`);
      }
    }

    if (deduplicatedFields.length === 0) {
      lines.push('    pass');
    }

    // from_dict class method
    lines.push('');
    lines.push('    @classmethod');
    lines.push(`    def from_dict(cls, data: Dict[str, Any]) -> "${modelClassName}":`);
    lines.push(`        """Deserialize from a dictionary."""`);
    lines.push('        return cls(');

    for (const field of [...requiredFields, ...optionalFields]) {
      const pyFieldName = fieldName(field.name);
      const wireKey = field.name; // Wire keys are snake_case from the spec
      const isRequired = field.required && field.type.kind !== 'nullable';
      const accessor = isRequired ? `data["${wireKey}"]` : `data.get("${wireKey}")`;
      const deserExpr = deserializeField(field.type, accessor, isRequired, modelMap);
      lines.push(`            ${pyFieldName}=${deserExpr},`);
    }

    lines.push('        )');

    // to_dict instance method
    lines.push('');
    lines.push('    def to_dict(self) -> Dict[str, Any]:');
    lines.push('        """Serialize to a dictionary."""');
    lines.push('        result: Dict[str, Any] = {}');

    for (const field of [...requiredFields, ...optionalFields]) {
      const pyFieldName = fieldName(field.name);
      const wireKey = field.name;
      const isRequired = field.required && field.type.kind !== 'nullable';

      if (isRequired) {
        const serExpr = serializeField(field.type, `self.${pyFieldName}`);
        lines.push(`        result["${wireKey}"] = ${serExpr}`);
      } else {
        const serExpr = serializeField(
          field.type.kind === 'nullable' ? field.type.inner : field.type,
          `self.${pyFieldName}`,
        );
        lines.push(`        if self.${pyFieldName} is not None:`);
        lines.push(`            result["${wireKey}"] = ${serExpr}`);
      }
    }

    lines.push('        return result');

    files.push({
      path: `${ctx.namespace}/${dirName}/models/${fileName(model.name)}.py`,
      content: lines.join('\n'),
    });
  }

  // Generate __init__.py barrel files for each models/ directory
  // Include both models and enums
  const symbolsByDir = new Map<string, string[]>();
  for (const model of models) {
    if (isListMetadataModel(model)) continue;
    const service = modelToService.get(model.name);
    const dirName = resolveDir(service);
    const key = `${ctx.namespace}/${dirName}/models`;
    if (!symbolsByDir.has(key)) symbolsByDir.set(key, []);
    symbolsByDir.get(key)!.push(model.name);
  }

  // Also include enums in the barrels
  for (const enumDef of ctx.spec.enums) {
    const service = enumToService.get(enumDef.name);
    const dirName = resolveDir(service);
    const key = `${ctx.namespace}/${dirName}/models`;
    if (!symbolsByDir.has(key)) symbolsByDir.set(key, []);
    symbolsByDir.get(key)!.push(enumDef.name);
  }

  for (const [dirPath, names] of symbolsByDir) {
    const imports = [...new Set(names)]
      .sort()
      .map((name) => `from .${fileName(name)} import ${className(name)}`)
      .join('\n');
    files.push({
      path: `${dirPath}/__init__.py`,
      content: imports,
    });
  }

  return files;
}

function collectTypingImports(ref: any, imports: Set<string>): void {
  switch (ref.kind) {
    case 'array':
      imports.add('List');
      collectTypingImports(ref.items, imports);
      break;
    case 'nullable':
      imports.add('Optional');
      collectTypingImports(ref.inner, imports);
      break;
    case 'union':
      imports.add('Union');
      for (const v of ref.variants) collectTypingImports(v, imports);
      break;
    case 'map':
      imports.add('Dict');
      collectTypingImports(ref.valueType, imports);
      break;
    case 'literal':
      imports.add('Literal');
      break;
    case 'primitive':
      if (ref.type === 'unknown') imports.add('Any');
      break;
  }
}

function deserializeField(ref: any, accessor: string, isRequired: boolean, _modelMap: Map<string, Model>): string {
  switch (ref.kind) {
    case 'model': {
      if (isRequired) {
        return `${className(ref.name)}.from_dict(${accessor})`;
      }
      // Use a temp var to narrow the type for mypy
      return `${className(ref.name)}.from_dict(_v) if (_v := ${accessor}) is not None else None`;
    }
    case 'array': {
      if (ref.items.kind === 'model') {
        return `[${className(ref.items.name)}.from_dict(item) for item in (${accessor} or [])]`;
      }
      return accessor;
    }
    case 'nullable':
      return deserializeField(ref.inner, accessor, false, _modelMap);
    default:
      return accessor;
  }
}

function serializeField(ref: any, accessor: string): string {
  switch (ref.kind) {
    case 'model':
      return `${accessor}.to_dict()`;
    case 'array': {
      if (ref.items.kind === 'model') {
        return `[item.to_dict() for item in ${accessor}]`;
      }
      return accessor;
    }
    default:
      return accessor;
  }
}

/** Check if a model is a list metadata model (e.g., ListMetadata). */
export function isListMetadataModel(model: Model): boolean {
  const fieldNames = new Set(model.fields.map((f) => f.name));
  return model.fields.length <= 3 && (fieldNames.has('before') || fieldNames.has('after')) && !fieldNames.has('data');
}

/** Check if a model is a list wrapper model (has `data` array + `list_metadata`). */
export function isListWrapperModel(model: Model): boolean {
  const dataField = model.fields.find((f) => f.name === 'data');
  const hasListMetadata = model.fields.some((f) => f.name === 'list_metadata' || f.name === 'listMetadata');
  return !!dataField && hasListMetadata && dataField.type.kind === 'array';
}
