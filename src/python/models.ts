import type { Model, Enum, EmitterContext, GeneratedFile } from '@workos/oagen';
import { assignModelsToServices, collectFieldDependencies, planOperation, walkTypeRef } from '@workos/oagen';
import { mapTypeRef } from './type-map.js';
import { className, fieldName, fileName, buildMountDirMap, dirToModule } from './naming.js';
import { assignEnumsToServices, collectGeneratedEnumSymbolsByDir } from './enums.js';
import { findSharedSchemas } from './shared-schemas.js';

/**
 * Generate Python dataclass model files from IR Model definitions.
 * Each model becomes a single .py file with a dataclass, from_dict, and to_dict.
 */
export function generateModels(models: Model[], ctx: EmitterContext): GeneratedFile[] {
  if (models.length === 0) return [];

  const modelToService = assignModelsToServices(models, ctx.spec.services, ctx.modelHints);
  const enumToService = assignEnumsToServices(ctx.spec.enums, ctx.spec.services);
  // Models referenced (transitively) by 2+ services are shared; route them to
  // common/ rather than the first alphabetical service that happens to use them.
  // assignModelsToServices uses first-wins, so we strip shared assignments here.
  // Hinted models bypass the shared rule (an explicit pin always wins).
  const hintedNames = new Set(Object.keys(ctx.modelHints ?? {}));
  const { models: sharedModelNames } = findSharedSchemas(ctx.spec);
  for (const name of sharedModelNames) {
    if (!hintedNames.has(name)) modelToService.delete(name);
  }
  const mountDirMap = buildMountDirMap(ctx);
  const resolveDir = (irService: string | undefined) =>
    irService ? (mountDirMap.get(irService) ?? 'common') : 'common';
  const files: GeneratedFile[] = [];
  const emittedModelSymbolsByDir = new Map<string, string[]>();
  // Overrides fileName() for symbols that live in a differently-named file.
  // Used for variant type aliases (e.g. EventSchemaVariant → event_schema).
  const symbolToFile = new Map<string, string>();
  const modelUsage = collectModelUsage(ctx.spec);

  // Build recursive structural hashes for deduplication.
  // Model/enum references are resolved bottom-up so structurally-identical
  // model trees (e.g. event context/actor sub-models) get the same hash.
  const recursiveHashes = buildRecursiveHashMap(models, ctx.spec.enums);
  const hashGroups = new Map<string, string[]>(); // hash -> model names
  for (const model of models) {
    if (isListWrapperModel(model) || isListMetadataModel(model)) continue;
    const hash = recursiveHashes.get(model.name) ?? '';
    if (!hashGroups.has(hash)) hashGroups.set(hash, []);
    hashGroups.get(hash)!.push(model.name);
  }

  // For each group of identical models, pick canonical (alphabetically first)
  const aliasOf = new Map<string, string>(); // alias name -> canonical name
  for (const [, names] of hashGroups) {
    if (names.length <= 1) continue;
    const sorted = [...names].sort((a, b) => compareAliasPriority(a, b, modelUsage));
    const canonical = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      if (canAliasModels(canonical, sorted[i], modelUsage)) {
        aliasOf.set(sorted[i], canonical);
      }
    }
  }

  // Track emitted file paths to prevent duplicates when synthetic models from
  // oneOf enrichment collide with existing IR models in snake_case.
  const emittedFilePaths = new Set<string>();

  for (const model of models) {
    // Skip list wrapper models (e.g., OrganizationList) — SyncPage handles envelopes
    if (isListWrapperModel(model)) continue;
    // Skip all list metadata models (e.g., ListMetadata, FooListListMetadata)
    if (isListMetadataModel(model)) continue;

    const service = modelToService.get(model.name);
    const dirName = resolveDir(service);
    const modelClassName = className(model.name);

    // Skip models whose file path was already emitted (name collision after snake_case)
    const modelFilePath = `src/${ctx.namespace}/${dirName}/models/${fileName(model.name)}.py`;
    if (emittedFilePaths.has(modelFilePath)) continue;
    emittedFilePaths.add(modelFilePath);

    // If this model is a discriminated union dispatcher, generate a factory class
    // instead of a regular dataclass (e.g. EventSchema where each variant has
    // event: const: "..."). The dispatcher owns a Union type alias and a from_dict
    // method that routes to the correct concrete variant at runtime.
    if ((model as any).discriminator) {
      const disc = (model as any).discriminator as { property: string; mapping: Record<string, string> };
      const variantNames = Object.values(disc.mapping); // model names, e.g. ["ActionAuthenticationDenied", ...]
      const variantTypeName = `${modelClassName}Variant`; // e.g. "EventSchemaVariant"

      const dispLines: string[] = [];
      dispLines.push('from __future__ import annotations');
      dispLines.push('');
      dispLines.push('from dataclasses import dataclass');
      dispLines.push('from typing import Any, ClassVar, Dict, Union, cast');
      dispLines.push(`from ${ctx.namespace}._types import _raise_deserialize_error`);
      dispLines.push('');

      // Import each variant model from its resolved location
      const sortedVariants = [...new Set(variantNames)].sort();
      for (const variantModelName of sortedVariants) {
        const variantService = modelToService.get(variantModelName);
        const variantDir = resolveDir(variantService);
        if (variantDir === dirName) {
          dispLines.push(`from .${fileName(variantModelName)} import ${className(variantModelName)}`);
        } else {
          dispLines.push(
            `from ${ctx.namespace}.${dirToModule(variantDir)}.models.${fileName(variantModelName)} import ${className(variantModelName)}`,
          );
        }
      }

      // Unknown variant for forward-compatible unknown discriminator values
      const unknownClassName = `${modelClassName}Unknown`;
      dispLines.push('');
      dispLines.push('');
      dispLines.push('@dataclass(slots=True)');
      dispLines.push(`class ${unknownClassName}:`);
      dispLines.push(`    """Unknown variant of ${modelClassName} not yet recognized by this SDK version."""`);
      dispLines.push('');
      dispLines.push('    raw_data: Dict[str, Any]');
      dispLines.push('    """The raw payload, preserved so callers can still inspect the data."""');
      dispLines.push('');
      dispLines.push('    @classmethod');
      dispLines.push(`    def from_dict(cls, data: Dict[str, Any]) -> "${unknownClassName}":`);
      dispLines.push('        """Wrap raw data in an unknown variant."""');
      dispLines.push('        return cls(raw_data=data)');
      dispLines.push('');
      dispLines.push('    def to_dict(self) -> Dict[str, Any]:');
      dispLines.push('        """Return the original raw data."""');
      dispLines.push('        return dict(self.raw_data)');

      dispLines.push('');
      dispLines.push('');

      // Union type alias — includes unknown variant for forward compatibility
      dispLines.push(`${variantTypeName} = Union[`);
      for (const variantModelName of sortedVariants) {
        dispLines.push(`    ${className(variantModelName)},`);
      }
      dispLines.push(`    ${unknownClassName},`);
      dispLines.push(']');

      dispLines.push('');
      dispLines.push('');

      // Dispatcher class
      if (model.description) {
        dispLines.push(`class ${modelClassName}:`);
        dispLines.push(`    """${model.description}"""`);
      } else {
        dispLines.push(`class ${modelClassName}:`);
        dispLines.push(`    """Discriminated union dispatcher (discriminated by '${disc.property}')."""`);
      }
      dispLines.push('');
      dispLines.push(`    _DISPATCH: ClassVar[Dict[str, type]] = {`);
      for (const [value, variantModelName] of Object.entries(disc.mapping).sort(([a], [b]) => a.localeCompare(b))) {
        dispLines.push(`        "${value}": ${className(variantModelName)},`);
      }
      dispLines.push('    }');
      dispLines.push('');
      dispLines.push('    @classmethod');
      dispLines.push(`    def from_dict(cls, data: Dict[str, Any]) -> "${variantTypeName}":`);
      dispLines.push('        """Deserialize from a dictionary, dispatching to the correct variant."""');
      dispLines.push(`        if "${disc.property}" not in data:`);
      dispLines.push(
        `            _raise_deserialize_error("${modelClassName}", ValueError("Missing required field '${disc.property}'"))`,
      );
      dispLines.push(`        disc_value = data["${disc.property}"]`);
      dispLines.push('        if disc_value is None:');
      dispLines.push(
        `            _raise_deserialize_error("${modelClassName}", ValueError("${disc.property} must not be None"))`,
      );
      dispLines.push('        dispatch_cls = cls._DISPATCH.get(disc_value)');
      dispLines.push('        if dispatch_cls is not None:');
      dispLines.push(`            return cast("${variantTypeName}", dispatch_cls.from_dict(data))`);
      dispLines.push(`        return ${unknownClassName}.from_dict(data)`);

      files.push({
        path: `src/${ctx.namespace}/${dirName}/models/${fileName(model.name)}.py`,
        content: dispLines.join('\n'),
        integrateTarget: true,
        overwriteExisting: true,
      });

      if (!emittedModelSymbolsByDir.has(dirName)) emittedModelSymbolsByDir.set(dirName, []);
      emittedModelSymbolsByDir.get(dirName)!.push(model.name);
      // Also register the variant type alias and unknown variant in the barrel,
      // pointing to the same file as the dispatcher.
      emittedModelSymbolsByDir.get(dirName)!.push(variantTypeName);
      symbolToFile.set(variantTypeName, fileName(model.name));
      emittedModelSymbolsByDir.get(dirName)!.push(unknownClassName);
      symbolToFile.set(unknownClassName, fileName(model.name));
      continue;
    }

    // If this model is an alias for a canonical model, generate a type alias file
    const canonicalName = aliasOf.get(model.name);
    if (canonicalName) {
      // Skip when alias and canonical produce the same file name (self-import).
      // This happens when synthetic models from oneOf enrichment collide with
      // existing IR models in snake_case (e.g., Foo_bar vs FooBar).
      if (fileName(model.name) === fileName(canonicalName)) {
        continue;
      }
      const canonicalService = modelToService.get(canonicalName);
      const canonicalDir = resolveDir(canonicalService);
      const canonicalClassName = className(canonicalName);
      const lines: string[] = [];
      lines.push('from typing import TypeAlias');
      // Always use direct file import to avoid barrel dependency on the canonical
      if (canonicalDir === dirName) {
        lines.push(`from .${fileName(canonicalName)} import ${canonicalClassName}`);
      } else {
        lines.push(
          `from ${ctx.namespace}.${dirToModule(canonicalDir)}.models.${fileName(canonicalName)} import ${canonicalClassName}`,
        );
      }
      lines.push('');
      lines.push(`${modelClassName}: TypeAlias = ${canonicalClassName}`);
      files.push({
        path: `src/${ctx.namespace}/${dirName}/models/${fileName(model.name)}.py`,
        content: lines.join('\n'),
        integrateTarget: true,
        overwriteExisting: true,
      });
      if (!emittedModelSymbolsByDir.has(dirName)) emittedModelSymbolsByDir.set(dirName, []);
      emittedModelSymbolsByDir.get(dirName)!.push(model.name);
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
    const hasOptional = deduplicatedFields.some((f) => isOptionalField(model.name, f, ctx));
    if (hasOptional) typingImports.add('Optional');
    const usesDateTime = deduplicatedFields.some((f) => isDateTimeType(f.type));
    const usesEnum = deps.enums.size > 0;

    lines.push('from __future__ import annotations');
    lines.push('');
    lines.push('from dataclasses import dataclass');
    if (usesDateTime) {
      lines.push('from datetime import datetime');
    }
    if (usesEnum) {
      lines.push('from enum import Enum');
    }
    lines.push('from typing import cast');
    lines.push(`from typing import ${[...typingImports].sort().join(', ')}`);
    lines.push(`from ${ctx.namespace}._types import _raise_deserialize_error`);
    if (usesDateTime) {
      lines.push(`from ${ctx.namespace}._types import _format_datetime, _parse_datetime`);
    }

    // Import referenced models from their service's models package.
    // Always use direct file imports (not barrel __init__.py) to avoid
    // circular-import chains when common/ models reference service modules.
    if (deps.models.size > 0) {
      lines.push('');
      for (const modelName of [...deps.models].sort()) {
        if (modelName === model.name) continue; // skip self
        const modelService = modelToService.get(modelName);
        const modelDir = resolveDir(modelService);
        if (modelDir === dirName) {
          lines.push(`from .${fileName(modelName)} import ${className(modelName)}`);
        } else {
          lines.push(
            `from ${ctx.namespace}.${dirToModule(modelDir)}.models.${fileName(modelName)} import ${className(modelName)}`,
          );
        }
      }
    }

    // Import referenced enums — same direct-file strategy.
    if (deps.enums.size > 0) {
      for (const enumName of [...deps.enums].sort()) {
        const enumService = enumToService.get(enumName);
        const enumDir = resolveDir(enumService);
        if (enumDir === dirName) {
          lines.push(`from .${fileName(enumName)} import ${className(enumName)}`);
        } else {
          lines.push(
            `from ${ctx.namespace}.${dirToModule(enumDir)}.models.${fileName(enumName)} import ${className(enumName)}`,
          );
        }
      }
    }

    lines.push('');
    lines.push('');

    // Dataclass definition
    lines.push('@dataclass(slots=True)');
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
    const requiredFields = deduplicatedFields.filter((f) => !isOptionalField(model.name, f, ctx));
    const optionalFields = deduplicatedFields.filter((f) => isOptionalField(model.name, f, ctx));

    for (const field of requiredFields) {
      const pyFieldName = fieldName(field.name);
      const pyType = resolveModelFieldType(field.type);
      if (field.description || field.deprecated) {
        const parts: string[] = [];
        if (field.description) parts.push(field.description);
        if (field.deprecated) parts.push('.. deprecated:: This field is deprecated.');
        lines.push(`    ${pyFieldName}: ${pyType}`);
        lines.push(`    """${parts.join('\n\n    ')}"""`);
      } else {
        lines.push(`    ${pyFieldName}: ${pyType}`);
      }
    }

    for (const field of optionalFields) {
      const pyFieldName = fieldName(field.name);
      const innerType =
        field.type.kind === 'nullable' ? resolveModelFieldType(field.type.inner) : resolveModelFieldType(field.type);
      const pyType = `Optional[${innerType}]`;
      if (field.description || field.deprecated) {
        const parts: string[] = [];
        if (field.description) parts.push(field.description);
        if (field.deprecated) parts.push('.. deprecated:: This field is deprecated.');
        lines.push(`    ${pyFieldName}: ${pyType} = None`);
        lines.push(`    """${parts.join('\n\n    ')}"""`);
      } else {
        lines.push(`    ${pyFieldName}: ${pyType} = None`);
      }
    }

    // from_dict class method
    lines.push('');
    lines.push('    @classmethod');
    lines.push(`    def from_dict(cls, data: Dict[str, Any]) -> "${modelClassName}":`);
    lines.push(`        """Deserialize from a dictionary."""`);
    lines.push('        try:');
    lines.push('            return cls(');

    for (const field of [...requiredFields, ...optionalFields]) {
      const pyFieldName = fieldName(field.name);
      const wireKey = field.name; // Wire keys are snake_case from the spec
      const isRequired = !isOptionalField(model.name, field, ctx);
      let accessor: string;
      if (field.type.kind === 'literal' && isRequired) {
        // Required literal fields have a statically known value; use .get() with a default
        // so deserialization is resilient when the API omits the key.
        accessor = `data.get("${wireKey}", ${pythonLiteralDefault(field.type.value)})`;
      } else {
        accessor = isRequired ? `data["${wireKey}"]` : `data.get("${wireKey}")`;
      }
      // For deserialization expressions, nullable types must always handle None
      // even when the field itself is required (the key must be present, but value can be null).
      const deserRequired = isRequired && field.type.kind !== 'nullable';
      const walrusVar = `_v_${pyFieldName}`;
      const deserExpr = deserializeField(field.type, accessor, deserRequired, walrusVar);
      lines.push(`                ${pyFieldName}=${deserExpr},`);
    }

    lines.push('            )');
    lines.push('        except (KeyError, ValueError) as e:');
    lines.push(`            _raise_deserialize_error("${modelClassName}", e)`);

    // to_dict instance method
    lines.push('');
    lines.push('    def to_dict(self) -> Dict[str, Any]:');
    lines.push('        """Serialize to a dictionary."""');
    lines.push('        result: Dict[str, Any] = {}');

    for (const field of [...requiredFields, ...optionalFields]) {
      const pyFieldName = fieldName(field.name);
      const wireKey = field.name;
      const isRequired = !isOptionalField(model.name, field, ctx);

      const isNullable = field.type.kind === 'nullable';
      if (isRequired && !isNullable) {
        // Required non-nullable: always serialize directly
        const serExpr = serializeField(field.type, `self.${pyFieldName}`);
        lines.push(`        result["${wireKey}"] = ${serExpr}`);
      } else if (isNullable) {
        // Nullable fields should round-trip explicit None as null, even when optional
        const innerType = (field.type as any).inner;
        const serExpr = serializeField(innerType, `self.${pyFieldName}`);
        lines.push(`        if self.${pyFieldName} is not None:`);
        lines.push(`            result["${wireKey}"] = ${serExpr}`);
        lines.push(`        else:`);
        lines.push(`            result["${wireKey}"] = None`);
      } else {
        // Optional non-nullable fields should be omitted when unset
        const serExpr = serializeField(field.type, `self.${pyFieldName}`);
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
    if (!emittedModelSymbolsByDir.has(dirName)) emittedModelSymbolsByDir.set(dirName, []);
    emittedModelSymbolsByDir.get(dirName)!.push(model.name);
  }

  // Generate __init__.py barrel files for each models/ directory
  // Include both models and enums
  const symbolsByDir = new Map<string, string[]>();
  for (const [dirName, names] of emittedModelSymbolsByDir) {
    const key = `src/${ctx.namespace}/${dirName}/models`;
    if (!symbolsByDir.has(key)) symbolsByDir.set(key, []);
    symbolsByDir.get(key)!.push(...names);
  }

  // Also include enums in the barrels using the enum emitter's actual output placement.
  const reachableEnumNames = collectReachableEnumNames(ctx);
  const emittedEnums = ctx.spec.enums.filter((enumDef) => reachableEnumNames.has(enumDef.name));
  const enumSymbolsByDir = collectGeneratedEnumSymbolsByDir(emittedEnums, ctx);
  for (const [dirName, names] of enumSymbolsByDir) {
    const key = `src/${ctx.namespace}/${dirName}/models`;
    if (!symbolsByDir.has(key)) symbolsByDir.set(key, []);
    symbolsByDir.get(key)!.push(...names);
  }

  // Build set of service directory model paths — these get their parent __init__.py
  // from generateServiceInits in client.ts, so we must not create a competing one here.
  const serviceDirModelPaths = new Set<string>();
  for (const service of ctx.spec.services) {
    const dirName = mountDirMap.get(service.name) ?? resolveDir(service.name);
    serviceDirModelPaths.add(`src/${ctx.namespace}/${dirName}/models`);
  }

  // Emit an empty barrel for every service-models dir that has no symbols of
  // its own (e.g. a service whose models live in another package via
  // cross-domain aliases). Otherwise the live SDK can keep a stale
  // `__init__.py` from a previous spec revision — when the underlying module
  // gets pruned the dangling re-export survives and breaks pyright. Done here
  // (not in client.ts) so a subsequent emission for the same path with real
  // content always wins last-write-wins.
  for (const dirPath of serviceDirModelPaths) {
    if (!symbolsByDir.has(dirPath)) {
      files.push({
        path: `${dirPath}/__init__.py`,
        content: '',
        integrateTarget: true,
        overwriteExisting: true,
      });
    }
  }

  for (const [dirPath, names] of symbolsByDir) {
    // Use `import X as X` syntax for explicit re-exports (required by pyright strict)
    const uniqueNames = [...new Set(names)].sort();
    const importLines: string[] = [];
    for (const name of uniqueNames) {
      const fileNameForSymbol = symbolToFile.get(name) ?? fileName(name);
      importLines.push(`from .${fileNameForSymbol} import ${className(name)} as ${className(name)}`);
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
        integrateTarget: true,
        overwriteExisting: true,
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

function collectReachableEnumNames(ctx: EmitterContext): Set<string> {
  const referencedModels = new Set<string>();
  const referencedEnums = new Set<string>();

  const collectFromTypeRef = (ref: any): void => {
    walkTypeRef(ref, {
      model: (r) => referencedModels.add(r.name),
      enum: (r) => referencedEnums.add(r.name),
    });
  };

  for (const service of ctx.spec.services) {
    for (const op of service.operations) {
      for (const p of [...op.pathParams, ...op.queryParams, ...op.headerParams, ...(op.cookieParams ?? [])]) {
        collectFromTypeRef(p.type);
      }
      if (op.requestBody) collectFromTypeRef(op.requestBody);
      collectFromTypeRef(op.response);
      if (op.pagination) collectFromTypeRef(op.pagination.itemType);
      for (const err of op.errors) {
        if (err.type) collectFromTypeRef(err.type);
      }
      if (op.successResponses) {
        for (const sr of op.successResponses) {
          collectFromTypeRef(sr.type);
        }
      }
    }
  }

  const modelsByName = new Map(ctx.spec.models.map((m) => [m.name, m]));
  const visited = new Set<string>();
  const queue = [...referencedModels];
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (visited.has(name)) continue;
    visited.add(name);
    const model = modelsByName.get(name);
    if (!model) continue;
    for (const field of model.fields) {
      collectFromTypeRef(field.type);
      for (const modelName of referencedModels) {
        if (!visited.has(modelName)) queue.push(modelName);
      }
    }
  }

  return referencedEnums;
}

function collectModelUsage(spec: EmitterContext['spec']): {
  requestOnly: Set<string>;
  response: Set<string>;
  mixed: Set<string>;
} {
  const request = new Set<string>();
  const response = new Set<string>();

  for (const service of spec.services) {
    for (const op of service.operations) {
      const plan = planOperation(op);
      if (plan.responseModelName) {
        response.add(plan.responseModelName);
      }
      if (op.pagination?.itemType.kind === 'model') {
        response.add(op.pagination.itemType.name);
      }
      if (op.requestBody?.kind === 'model') {
        request.add(op.requestBody.name);
      }
      if (op.requestBody?.kind === 'union') {
        for (const variant of op.requestBody.variants ?? []) {
          if (variant.kind === 'model') request.add(variant.name);
        }
      }
    }
  }

  const mixed = new Set<string>();
  for (const name of request) {
    if (response.has(name)) mixed.add(name);
  }

  const requestOnly = new Set([...request].filter((name) => !mixed.has(name)));
  const responseOnly = new Set([...response].filter((name) => !mixed.has(name)));

  return { requestOnly, response: responseOnly, mixed };
}

function compareAliasPriority(left: string, right: string, usage: ReturnType<typeof collectModelUsage>): number {
  const score = (name: string): number => {
    if (usage.response.has(name)) return 0;
    if (usage.mixed.has(name)) return 1;
    if (usage.requestOnly.has(name)) return 2;
    return 3;
  };

  const diff = score(left) - score(right);
  if (diff !== 0) return diff;
  return left.localeCompare(right);
}

function canAliasModels(canonical: string, alias: string, usage: ReturnType<typeof collectModelUsage>): boolean {
  // Don't alias when both models produce the same file name — the TypeAlias
  // file would import from itself (e.g., FooBar aliased to Foo_bar).
  if (fileName(canonical) === fileName(alias)) return false;
  // Don't alias across request/response boundaries — a request-only model
  // and a response-only model may look identical today but evolve independently.
  if (
    (usage.response.has(canonical) && usage.requestOnly.has(alias)) ||
    (usage.response.has(alias) && usage.requestOnly.has(canonical))
  ) {
    return false;
  }
  return true;
}

function isOptionalField(modelName: string, field: Model['fields'][number], ctx: EmitterContext): boolean {
  void modelName;
  void ctx;
  // A field is optional (gets = None default) only if it's not required or deprecated.
  // Nullable-required fields (required: true, type: nullable) are NOT optional —
  // they must appear in the API response (value can be null, but key must be present).
  // The spec's required status always takes precedence over the old SDK's API surface.
  if (!field.required || field.deprecated) return true;
  return false;
}

/** Convert a LiteralType value to a Python default expression for use in data.get(). */
function pythonLiteralDefault(value: string | number | boolean | null): string {
  if (value === null) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'string') return `"${value}"`;
  return String(value);
}

function resolveModelFieldType(ref: any): string {
  // Handle nullable datetime: return Optional[datetime] to preserve nullable wrapper
  if (ref.kind === 'nullable' && isDateTimeType(ref.inner)) {
    return 'Optional[datetime]';
  }
  if (isDateTimeType(ref)) {
    return 'datetime';
  }
  return mapTypeRef(ref);
}

function isDateTimeType(ref: any): boolean {
  if (ref.kind === 'nullable') {
    return isDateTimeType(ref.inner);
  }
  return ref.kind === 'primitive' && ref.type === 'string' && ref.format === 'date-time';
}

function deserializeField(ref: any, accessor: string, isRequired: boolean, walrusVar: string = '_v'): string {
  if (isDateTimeType(ref)) {
    if (isRequired) {
      return `_parse_datetime(${accessor})`;
    }
    return `_parse_datetime(${walrusVar}) if (${walrusVar} := ${accessor}) is not None else None`;
  }
  switch (ref.kind) {
    case 'model': {
      if (isRequired) {
        return `${className(ref.name)}.from_dict(cast(Dict[str, Any], ${accessor}))`;
      }
      return `${className(ref.name)}.from_dict(cast(Dict[str, Any], ${walrusVar})) if (${walrusVar} := ${accessor}) is not None else None`;
    }
    case 'array': {
      if (ref.items.kind === 'model') {
        const listExpr = `[${className(ref.items.name)}.from_dict(cast(Dict[str, Any], item)) for item in cast(list[Any], ${isRequired ? accessor : walrusVar})]`;
        if (isRequired) {
          return listExpr;
        }
        // For optional arrays, preserve None instead of converting to []
        return `${listExpr} if (${walrusVar} := ${accessor}) is not None else None`;
      }
      if (ref.items.kind === 'enum') {
        const enumClass = className(ref.items.name);
        const listExpr = `[${enumClass}(item) for item in cast(list[Any], ${isRequired ? accessor : walrusVar})]`;
        if (isRequired) {
          return listExpr;
        }
        return `${listExpr} if (${walrusVar} := ${accessor}) is not None else None`;
      }
      return accessor;
    }
    case 'enum': {
      const enumClass = className(ref.name);
      if (isRequired) {
        return `${enumClass}(${accessor})`;
      }
      return `${enumClass}(${walrusVar}) if (${walrusVar} := ${accessor}) is not None else None`;
    }
    case 'nullable':
      return deserializeField(ref.inner, accessor, false, walrusVar);
    case 'union': {
      const modelVariants = (ref.variants ?? []).filter((v: any) => v.kind === 'model');
      const uniqueModels = [...new Set(modelVariants.map((v: any) => v.name))] as string[];
      // Discriminated union: dispatch on the discriminator property to call
      // the matching variant's from_dict. Unknown discriminator values fall
      // back to the raw payload so callers can introspect.
      if (ref.discriminator && ref.discriminator.mapping) {
        const entries = Object.entries(ref.discriminator.mapping as Record<string, string>);
        if (entries.length > 0) {
          const dispatchMap = entries.map(([value, modelName]) => `"${value}": ${className(modelName)}`).join(', ');
          const dataExpr = isRequired ? accessor : walrusVar;
          const dataCast = `cast(Dict[str, Any], ${dataExpr})`;
          // The dispatch dict has `str` keys, so pyright (strict) rejects the
          // raw `Any | None` returned by `.get(prop)` even though `dict.get`
          // accepts any hashable. Cast through `str` to satisfy the parameter
          // type — runtime semantics are unchanged because a missing/`None`
          // discriminator simply misses the dispatch and falls through.
          const lookupExpr = `{${dispatchMap}}.get(cast(str, ${dataCast}.get("${ref.discriminator.property}")))`;
          const branch = `(_disc.from_dict(${dataCast}) if (_disc := ${lookupExpr}) is not None else ${dataExpr})`;
          if (isRequired) return branch;
          return `(${branch}) if (${walrusVar} := ${accessor}) is not None else None`;
        }
      }
      if (uniqueModels.length === 1) {
        return deserializeField({ kind: 'model', name: uniqueModels[0] }, accessor, isRequired, walrusVar);
      }
      // Mixed unions — pass through (would need runtime discriminant logic)
      return accessor;
    }
    default:
      return accessor;
  }
}

function serializeField(ref: any, accessor: string): string {
  if (isDateTimeType(ref)) {
    return `_format_datetime(${accessor})`;
  }
  switch (ref.kind) {
    case 'model':
      return `${accessor}.to_dict()`;
    case 'enum':
      return `${accessor}.value if isinstance(${accessor}, Enum) else ${accessor}`;
    case 'array': {
      if (ref.items.kind === 'model') {
        return `[item.to_dict() for item in ${accessor}]`;
      }
      if (ref.items.kind === 'enum') {
        return `[item.value if isinstance(item, Enum) else item for item in ${accessor}]`;
      }
      return accessor;
    }
    case 'union': {
      const modelVariants = (ref.variants ?? []).filter((v: any) => v.kind === 'model');
      const uniqueModels = [...new Set(modelVariants.map((v: any) => v.name))];
      if (uniqueModels.length === 1) {
        return `${accessor}.to_dict()`;
      }
      // Discriminated union: deserialize produced a dataclass instance for
      // known discriminator values and the raw dict for unknowns. Round-trip
      // both — call `.to_dict()` if it exists, otherwise pass through.
      if (ref.discriminator && ref.discriminator.mapping && modelVariants.length > 0) {
        return `${accessor}.to_dict() if hasattr(${accessor}, "to_dict") else ${accessor}`;
      }
      return accessor;
    }
    default:
      return accessor;
  }
}

/**
 * Build recursive structural hashes for all models.
 *
 * Model references are resolved to their own structural hash (bottom-up) and
 * enum references are resolved to their value-set hash.  This means
 * structurally-identical model *trees* — like the dozens of per-event Context /
 * ContextActor / ContextGoogleAnalyticsSession sub-models in the spec — get
 * the same hash even though their IR names differ.
 */
function buildRecursiveHashMap(models: Model[], enums: Enum[]): Map<string, string> {
  const modelByName = new Map(models.map((m) => [m.name, m]));
  const hashCache = new Map<string, string>();
  const visiting = new Set<string>(); // cycle guard

  // Pre-compute enum value hashes so identically-valued enums hash the same.
  const enumVH = new Map<string, string>();
  for (const e of enums) {
    enumVH.set(
      e.name,
      [...e.values]
        .map((v) => String(v.value))
        .sort()
        .join('|'),
    );
  }

  function modelHash(name: string): string {
    const cached = hashCache.get(name);
    if (cached != null) return cached;
    if (visiting.has(name)) return `m:${name}`; // cycle — fall back to name
    visiting.add(name);

    const model = modelByName.get(name);
    if (!model) {
      visiting.delete(name);
      return `m:${name}`; // unknown model
    }

    const hash = [...model.fields]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((f) => `${f.name}:${deepTypeHash(f.type)}:${f.required}`)
      .join('|');

    visiting.delete(name);
    hashCache.set(name, hash);
    return hash;
  }

  function deepTypeHash(ref: any): string {
    switch (ref.kind) {
      case 'primitive':
        return `p:${ref.type}${ref.format ? `:${ref.format}` : ''}`;
      case 'model':
        return `m:{${modelHash(ref.name)}}`;
      case 'enum': {
        const vh = enumVH.get(ref.name);
        return vh != null ? `e:{${vh}}` : `e:${ref.name}`;
      }
      case 'array':
        return `a:${deepTypeHash(ref.items)}`;
      case 'nullable':
        return `n:${deepTypeHash(ref.inner)}`;
      case 'union':
        return `u:${(ref.variants ?? [])
          .map((v: any) => deepTypeHash(v))
          .sort()
          .join(',')}`;
      case 'map':
        return `d:${deepTypeHash(ref.valueType)}`;
      case 'literal':
        return `l:${String(ref.value)}`;
      default:
        return 'unknown';
    }
  }

  for (const model of models) {
    modelHash(model.name);
  }

  return hashCache;
}

// Import and re-export shared model detection utilities
import { isListMetadataModel, isListWrapperModel } from '../shared/model-utils.js';
export { isListMetadataModel, isListWrapperModel };
