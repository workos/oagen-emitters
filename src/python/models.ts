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

  // Build structural hashes for deduplication
  const modelHashMap = new Map<string, string>(); // model name -> hash
  const hashGroups = new Map<string, string[]>(); // hash -> model names
  for (const model of models) {
    if (isListWrapperModel(model) || isListMetadataModel(model)) continue;
    const hash = structuralHash(model);
    modelHashMap.set(model.name, hash);
    if (!hashGroups.has(hash)) hashGroups.set(hash, []);
    hashGroups.get(hash)!.push(model.name);
  }

  // For each group of identical models, pick canonical (alphabetically first)
  const aliasOf = new Map<string, string>(); // alias name -> canonical name
  for (const [, names] of hashGroups) {
    if (names.length <= 1) continue;
    const sorted = [...names].sort();
    const canonical = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      aliasOf.set(sorted[i], canonical);
    }
  }

  for (const model of models) {
    // Skip list wrapper models (e.g., OrganizationList) — SyncPage handles envelopes
    if (isListWrapperModel(model)) continue;
    // Skip all list metadata models (e.g., ListMetadata, FooListListMetadata)
    if (isListMetadataModel(model)) continue;

    const service = modelToService.get(model.name);
    const dirName = resolveDir(service);
    const modelClassName = className(model.name);

    // If this model is an alias for a canonical model, generate a type alias file
    const canonicalName = aliasOf.get(model.name);
    if (canonicalName) {
      const canonicalService = modelToService.get(canonicalName);
      const canonicalDir = resolveDir(canonicalService);
      const canonicalClassName = className(canonicalName);
      const lines: string[] = [];
      if (canonicalDir === dirName) {
        lines.push(`from .${fileName(canonicalName)} import ${canonicalClassName}`);
      } else {
        lines.push(`from ${ctx.namespace}.${canonicalDir}.models import ${canonicalClassName}`);
      }
      lines.push('');
      lines.push(`${modelClassName} = ${canonicalClassName}`);
      files.push({
        path: `src/${ctx.namespace}/${dirName}/models/${fileName(model.name)}.py`,
        content: lines.join('\n'),
        integrateTarget: true,
        overwriteExisting: true,
      });
      continue;
    }

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
    lines.push('from typing import cast');
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
    lines.push('@dataclass');
    lines.push(`class ${modelClassName}:`);
    if (model.description) {
      lines.push(`    """${model.description}"""`);
    } else {
      // Generate a default docstring from the class name when the spec
      // doesn't provide a description.
      let readable = modelClassName.replace(/([a-z])([A-Z])/g, '$1 $2');
      readable = readable.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
      lines.push(`    """${readable} model."""`);
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
      path: `src/${ctx.namespace}/${dirName}/models/${fileName(model.name)}.py`,
      content: lines.join('\n'),
      integrateTarget: true,
      overwriteExisting: true,
    });
  }

  // Generate __init__.py barrel files for each models/ directory
  // Include both models and enums
  const symbolsByDir = new Map<string, string[]>();
  for (const model of models) {
    if (isListWrapperModel(model)) continue;
    if (isListMetadataModel(model)) continue;
    const service = modelToService.get(model.name);
    const dirName = resolveDir(service);
    const key = `src/${ctx.namespace}/${dirName}/models`;
    if (!symbolsByDir.has(key)) symbolsByDir.set(key, []);
    symbolsByDir.get(key)!.push(model.name);
  }

  // Also include enums in the barrels
  for (const enumDef of ctx.spec.enums) {
    const service = enumToService.get(enumDef.name);
    const dirName = resolveDir(service);
    const key = `src/${ctx.namespace}/${dirName}/models`;
    if (!symbolsByDir.has(key)) symbolsByDir.set(key, []);
    symbolsByDir.get(key)!.push(enumDef.name);
  }

  // Build set of service directory model paths — these get their parent __init__.py
  // from generateServiceInits in client.ts, so we must not create a competing one here.
  const serviceDirModelPaths = new Set<string>();
  for (const service of ctx.spec.services) {
    const resolvedName = serviceNameMap.get(service.name) ?? service.name;
    const dirName = resolveServiceDir(resolvedName);
    serviceDirModelPaths.add(`src/${ctx.namespace}/${dirName}/models`);
  }

  for (const [dirPath, names] of symbolsByDir) {
    // Use `import X as X` syntax for explicit re-exports (required by pyright strict)
    const uniqueNames = [...new Set(names)].sort();
    const importLines: string[] = [];
    for (const name of uniqueNames) {
      importLines.push(`from .${fileName(name)} import ${className(name)} as ${className(name)}`);
    }
    const imports = importLines.join('\n');
    files.push({
      path: `${dirPath}/__init__.py`,
      content: imports,
      integrateTarget: true,
      overwriteExisting: true,
    });

    // Only generate parent __init__.py for non-service dirs (e.g., common/).
    // Service dirs get their __init__.py from generateServiceInits in client.ts
    // which includes both the resource class re-export and model star import.
    if (!serviceDirModelPaths.has(dirPath)) {
      const parentDir = dirPath.replace(/\/models$/, '');
      const reExports = [...new Set(names)]
        .sort()
        .map((name) => `from .models import ${className(name)} as ${className(name)}`)
        .join('\n');
      files.push({
        path: `${parentDir}/__init__.py`,
        content: reExports,
        skipIfExists: true,
      });
    }
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

// oxlint-disable-next-line only-used-in-recursion -- modelMap is forwarded through recursive calls
function deserializeField(ref: any, accessor: string, isRequired: boolean, modelMap: Map<string, Model>): string {
  switch (ref.kind) {
    case 'model': {
      if (isRequired) {
        return `${className(ref.name)}.from_dict(cast(Dict[str, Any], ${accessor}))`;
      }
      return `${className(ref.name)}.from_dict(cast(Dict[str, Any], _v)) if (_v := ${accessor}) is not None else None`;
    }
    case 'array': {
      if (ref.items.kind === 'model') {
        const listExpr = `[${className(ref.items.name)}.from_dict(cast(Dict[str, Any], item)) for item in cast(list[Any], ${isRequired ? `${accessor} or []` : '_v'})]`;
        if (isRequired) {
          return listExpr;
        }
        // For optional arrays, preserve None instead of converting to []
        return `${listExpr} if (_v := ${accessor}) is not None else None`;
      }
      if (ref.items.kind === 'enum') {
        const enumClass = className(ref.items.name);
        const listExpr = `[${enumClass}(item) for item in cast(list[Any], ${isRequired ? `${accessor} or []` : '_v'})]`;
        if (isRequired) {
          return listExpr;
        }
        return `${listExpr} if (_v := ${accessor}) is not None else None`;
      }
      return accessor;
    }
    case 'enum': {
      const enumClass = className(ref.name);
      if (isRequired) {
        return `${enumClass}(${accessor})`;
      }
      return `${enumClass}(_v) if (_v := ${accessor}) is not None else None`;
    }
    case 'nullable':
      return deserializeField(ref.inner, accessor, false, modelMap);
    case 'union': {
      const modelVariants = (ref.variants ?? []).filter((v: any) => v.kind === 'model');
      const uniqueModels = [...new Set(modelVariants.map((v: any) => v.name))];
      if (uniqueModels.length === 1) {
        return deserializeField({ kind: 'model', name: uniqueModels[0] }, accessor, isRequired, modelMap);
      }
      // Mixed unions — pass through (would need runtime discriminant logic)
      return accessor;
    }
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
    case 'union': {
      const modelVariants = (ref.variants ?? []).filter((v: any) => v.kind === 'model');
      const uniqueModels = [...new Set(modelVariants.map((v: any) => v.name))];
      if (uniqueModels.length === 1) {
        return `${accessor}.to_dict()`;
      }
      return accessor;
    }
    default:
      return accessor;
  }
}

/**
 * Build a structural hash for a model based on sorted field names, types, and required flags.
 * Two models with the same hash are structurally identical (same fields, types, required).
 */
function structuralHash(model: Model): string {
  const fields = [...model.fields]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((f) => `${f.name}:${typeHash(f.type)}:${f.required}`);
  return fields.join('|');
}

function typeHash(ref: any): string {
  switch (ref.kind) {
    case 'primitive':
      return `p:${ref.type}${ref.format ? `:${ref.format}` : ''}`;
    case 'model':
      return `m:${ref.name}`;
    case 'enum':
      return `e:${ref.name}`;
    case 'array':
      return `a:${typeHash(ref.items)}`;
    case 'nullable':
      return `n:${typeHash(ref.inner)}`;
    case 'union':
      return `u:${ref.variants.map(typeHash).sort().join(',')}`;
    case 'map':
      return `d:${typeHash(ref.valueType)}`;
    case 'literal':
      return `l:${String(ref.value)}`;
    default:
      return 'unknown';
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
