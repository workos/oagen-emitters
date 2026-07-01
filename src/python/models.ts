import type { Model, EmitterContext, GeneratedFile } from '@workos/oagen';
import { collectFieldDependencies, walkTypeRef } from '@workos/oagen';
import { mapTypeRef } from './type-map.js';
import { className, domainFieldName, fileName, buildMountDirMap, dirToModule } from './naming.js';
import { collectGeneratedEnumSymbolsByDir, collectCompatEnumAliases } from './enums.js';
import { computeSchemaPlacement } from './shared-schemas.js';
import {
  isModelInScope,
  isEnumInScope,
  fileExistsAfterRun,
  priorManifestBasenames,
  isMountInScope,
  getMountTarget,
} from '../shared/resolved-ops.js';

/**
 * Generate Python dataclass model files from IR Model definitions.
 * Each model becomes a single .py file with a dataclass, from_dict, and to_dict.
 */
export function generateModels(models: Model[], ctx: EmitterContext): GeneratedFile[] {
  if (models.length === 0) return [];

  // Tests sometimes pass models that aren't in ctx.spec.models, so synthesize
  // a spec view with the passed-in models to keep the placement logic accurate.
  const placementSpec = models === ctx.spec.models ? ctx.spec : { ...ctx.spec, models };
  const placement = computeSchemaPlacement(placementSpec, ctx);
  const {
    modelToService,
    enumToService,
    originalModelToService,
    originalEnumToService,
    relocatedModels,
    relocatedEnums,
    modelAliases: aliasOf,
  } = placement;
  const mountDirMap = buildMountDirMap(ctx);
  const resolveDir = (irService: string | undefined) =>
    irService ? (mountDirMap.get(irService) ?? 'common') : 'common';
  const files: GeneratedFile[] = [];
  const emittedModelSymbolsByDir = new Map<string, string[]>();
  // Overrides fileName() for symbols that live in a differently-named file.
  // Used for variant type aliases (e.g. EventSchemaVariant → event_schema).
  const symbolToFile = new Map<string, string>();
  // Track each emitted symbol's natural (pre-relocation) service so we can
  // re-export relocated symbols from their original service barrel for BC.
  const symbolToOriginalService = new Map<string, string>();

  // Track emitted file paths to prevent duplicates when synthetic models from
  // oneOf enrichment collide with existing IR models in snake_case.
  const emittedFilePaths = new Set<string>();

  // Wrappers referenced as a non-paginated operation response (e.g.
  // `VersionListResponse` for `GET /vault/v1/kv/{id}/versions`) must still be
  // emitted — the resource code references them by name and SyncPage doesn't
  // wrap them.
  const nonPaginatedRefs = collectNonPaginatedResponseModelNames(ctx.spec.services);
  // ListMetadata-shape models referenced by a surviving non-paginated wrapper
  // (e.g. vault's `VersionListResponse`) must still emit a dataclass —
  // otherwise the wrapper's module imports a class that was never written.
  const listMetadataNeeded = collectReferencedListMetadataModels(models, nonPaginatedRefs);

  // Discriminator model names — fields referencing these should use the Variant union type
  const discriminatorNames = new Set<string>();
  for (const m of models) {
    if ((m as any).discriminator) discriminatorNames.add(m.name);
  }

  for (const model of models) {
    // Skip list wrapper models (e.g., OrganizationList) — SyncPage handles envelopes
    if (isListWrapperModel(model) && !nonPaginatedRefs.has(model.name)) continue;
    // Skip all list metadata models (e.g., ListMetadata, FooListListMetadata)
    if (isListMetadataModel(model) && !listMetadataNeeded.has(model.name)) continue;

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

      // FR-1.4: write the file only when in scope; the barrel tracking below is
      // gated on the file existing after the run so out-of-scope models that
      // are already on disk stay exported, but brand-new out-of-scope models
      // (whose file is never emitted) are NOT referenced by the barrel.
      const dispInScope = isModelInScope(model.name, ctx);
      if (dispInScope) {
        files.push({
          path: `src/${ctx.namespace}/${dirName}/models/${fileName(model.name)}.py`,
          content: dispLines.join('\n'),
          integrateTarget: true,
          overwriteExisting: true,
        });
      }

      // Only reference this dispatcher (and its variant/unknown symbols, which
      // live in the same file) from the barrel when that file exists on disk
      // after the run.
      if (fileExistsAfterRun(`src/${ctx.namespace}/${dirName}/models/${fileName(model.name)}.py`, dispInScope, ctx)) {
        if (!emittedModelSymbolsByDir.has(dirName)) emittedModelSymbolsByDir.set(dirName, []);
        emittedModelSymbolsByDir.get(dirName)!.push(model.name);
        // Also register the variant type alias and unknown variant in the barrel,
        // pointing to the same file as the dispatcher.
        emittedModelSymbolsByDir.get(dirName)!.push(variantTypeName);
        symbolToFile.set(variantTypeName, fileName(model.name));
        emittedModelSymbolsByDir.get(dirName)!.push(unknownClassName);
        symbolToFile.set(unknownClassName, fileName(model.name));
        const dispatcherNatural = originalModelToService.get(model.name);
        if (dispatcherNatural) {
          symbolToOriginalService.set(model.name, dispatcherNatural);
          symbolToOriginalService.set(variantTypeName, dispatcherNatural);
          symbolToOriginalService.set(unknownClassName, dispatcherNatural);
        }
      }
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
      if (canonicalDir === dirName) {
        lines.push(`from .${fileName(canonicalName)} import ${canonicalClassName}`);
      } else {
        lines.push(
          `from ${ctx.namespace}.${dirToModule(canonicalDir)}.models.${fileName(canonicalName)} import ${canonicalClassName}`,
        );
      }
      lines.push('');
      lines.push(`${modelClassName}: TypeAlias = ${canonicalClassName}`);
      const aliasInScope = isModelInScope(model.name, ctx);
      const aliasPath = `src/${ctx.namespace}/${dirName}/models/${fileName(model.name)}.py`;
      if (aliasInScope) {
        files.push({
          path: aliasPath,
          content: lines.join('\n'),
          integrateTarget: true,
          overwriteExisting: true,
        });
      }
      // Reference the alias from the barrel only when its file exists on disk
      // after the run (in-scope, or already present from a prior run).
      if (fileExistsAfterRun(aliasPath, aliasInScope, ctx)) {
        if (!emittedModelSymbolsByDir.has(dirName)) emittedModelSymbolsByDir.set(dirName, []);
        emittedModelSymbolsByDir.get(dirName)!.push(model.name);
        const aliasNatural = originalModelToService.get(model.name);
        if (aliasNatural) symbolToOriginalService.set(model.name, aliasNatural);
      }
      continue;
    }

    // Deduplicate fields that map to the same snake_case name
    const seenFieldNames = new Set<string>();
    const deduplicatedFields = model.fields.filter((f) => {
      // Dedup on the DOMAIN identifier (the dataclass attribute name), which
      // honors a `domainName` override; the wire key stays `field.name`.
      const pyName = domainFieldName(f);
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
        // For discriminator models, also import the Variant type alias (lives in same file)
        const importNames = discriminatorNames.has(modelName)
          ? `${className(modelName)}, ${className(modelName)}Variant`
          : className(modelName);
        if (modelDir === dirName) {
          lines.push(`from .${fileName(modelName)} import ${importNames}`);
        } else {
          lines.push(
            `from ${ctx.namespace}.${dirToModule(modelDir)}.models.${fileName(modelName)} import ${importNames}`,
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

    // Rewrite discriminator model references to their Variant union type.
    // E.g. `"ConnectApplication"` → `"ConnectApplicationVariant"`
    const rewriteDiscriminatorType = (typeStr: string): string => {
      for (const discName of discriminatorNames) {
        const quoted = `"${className(discName)}"`;
        if (typeStr.includes(quoted)) {
          typeStr = typeStr.replace(quoted, `"${className(discName)}Variant"`);
        }
      }
      return typeStr;
    };

    for (const field of requiredFields) {
      // DOMAIN identifier: the dataclass attribute name (honors `domainName`).
      const pyFieldName = domainFieldName(field);
      const pyType = rewriteDiscriminatorType(resolveModelFieldType(field.type));
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
      // DOMAIN identifier: the dataclass attribute name (honors `domainName`).
      const pyFieldName = domainFieldName(field);
      const innerType =
        field.type.kind === 'nullable' ? resolveModelFieldType(field.type.inner) : resolveModelFieldType(field.type);
      const pyType = `Optional[${rewriteDiscriminatorType(innerType)}]`;
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

    const preludeLines: string[] = [];
    const fieldAssignmentLines: string[] = [];

    for (const field of [...requiredFields, ...optionalFields]) {
      // DOMAIN identifier (LHS of `cls(...)`); the wire key below stays `field.name`.
      const pyFieldName = domainFieldName(field);
      const wireKey = field.name; // Wire keys are snake_case from the spec
      const isRequired = !isOptionalField(model.name, field, ctx);

      const discPrelude = renderDiscriminatedUnionPrelude(field, pyFieldName, wireKey, modelClassName, isRequired);
      if (discPrelude) {
        preludeLines.push(...discPrelude.prelude);
        fieldAssignmentLines.push(`                ${pyFieldName}=${discPrelude.expr},`);
        continue;
      }

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
      fieldAssignmentLines.push(`                ${pyFieldName}=${deserExpr},`);
    }

    for (const preludeLine of preludeLines) lines.push(preludeLine);
    lines.push('            return cls(');
    for (const assignment of fieldAssignmentLines) lines.push(assignment);
    lines.push('            )');
    lines.push('        except (KeyError, ValueError) as e:');
    lines.push(`            _raise_deserialize_error("${modelClassName}", e)`);

    // to_dict instance method
    lines.push('');
    lines.push('    def to_dict(self) -> Dict[str, Any]:');
    lines.push('        """Serialize to a dictionary."""');
    lines.push('        result: Dict[str, Any] = {}');

    for (const field of [...requiredFields, ...optionalFields]) {
      // DOMAIN identifier (`self.<attr>`); the wire key below stays `field.name`.
      const pyFieldName = domainFieldName(field);
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

    const regularInScope = isModelInScope(model.name, ctx);
    if (regularInScope) {
      files.push({
        path: modelFilePath,
        content: lines.join('\n'),
        integrateTarget: true,
        overwriteExisting: true,
      });
    }
    // Reference the model from the barrel only when its file exists on disk
    // after the run (in-scope, or already present from a prior run). A
    // brand-new out-of-scope model whose file is never emitted must NOT be
    // referenced, or the `from .x import X` line dangles and the import fails.
    if (fileExistsAfterRun(modelFilePath, regularInScope, ctx)) {
      if (!emittedModelSymbolsByDir.has(dirName)) emittedModelSymbolsByDir.set(dirName, []);
      emittedModelSymbolsByDir.get(dirName)!.push(model.name);
      const regularNatural = originalModelToService.get(model.name);
      if (regularNatural) symbolToOriginalService.set(model.name, regularNatural);
    }
  }

  // Generate __init__.py barrel files for each models/ directory
  // Include both models and enums.
  // A direct symbol lives in the file at `dirPath/<file>.py`. A re-exported
  // symbol was relocated to common/ but is being mirrored from its natural
  // service barrel for backwards compatibility.
  // A `retainBasename` symbol has no known IR name — it is a per-item file
  // recorded in the PRIOR manifest (renamed/removed from the current spec but
  // still on disk) that we re-export wholesale via `from .<base> import *` so
  // out-of-scope code the scoped run did not regenerate keeps resolving.
  type BarrelSymbol = { name: string; reExport?: { fromDir: string; file: string }; retainBasename?: string };
  const symbolsByDir = new Map<string, BarrelSymbol[]>();
  for (const [dirName, names] of emittedModelSymbolsByDir) {
    const key = `src/${ctx.namespace}/${dirName}/models`;
    if (!symbolsByDir.has(key)) symbolsByDir.set(key, []);
    for (const name of names) symbolsByDir.get(key)!.push({ name });
  }

  // Also include enums in the barrels using the enum emitter's actual output placement.
  const reachableEnumNames = collectReachableEnumNames(ctx);
  const emittedEnums = ctx.spec.enums.filter((enumDef) => reachableEnumNames.has(enumDef.name));
  const enumSymbolsByDir = collectGeneratedEnumSymbolsByDir(emittedEnums, ctx);
  // Map each compat-alias symbol back to its canonical enum so we can gate it by
  // the canonical enum's scope (the alias file is only written when the
  // canonical enum is in scope; see enums.ts).
  const aliasToCanonicalEnum = new Map<string, string>();
  for (const [canonical, aliasNames] of collectCompatEnumAliases(emittedEnums, ctx)) {
    for (const aliasName of aliasNames) aliasToCanonicalEnum.set(aliasName, canonical);
  }
  for (const [dirName, names] of enumSymbolsByDir) {
    const key = `src/${ctx.namespace}/${dirName}/models`;
    if (!symbolsByDir.has(key)) symbolsByDir.set(key, []);
    for (const name of names) {
      // Reference an enum (or its compat alias) from the barrel only when its
      // per-enum file exists on disk after the run. A brand-new out-of-scope
      // enum whose file is never emitted must NOT be referenced.
      const enumFilePath = `${key}/${fileName(name)}.py`;
      const scopeName = aliasToCanonicalEnum.get(name) ?? name;
      if (fileExistsAfterRun(enumFilePath, isEnumInScope(scopeName, ctx), ctx)) {
        symbolsByDir.get(key)!.push({ name });
      }
    }
  }

  // Scoped runs: retain barrel entries for per-item files still on disk (prior
  // manifest) that the current spec no longer produces — e.g. a model/enum
  // renamed or removed for an out-of-scope service. Out-of-scope code we did
  // not regenerate may still `from .<base> import X`, so dropping it would
  // break the import. We can't recover the original class name from the
  // basename, so re-export the module wholesale with `import *`. A full run
  // (priorManifestBasenames returns []) yields nothing here. De-duped against
  // files already referenced by an emitted/enum symbol in the same dir.
  //
  // Candidate dirs are every `src/<ns>/<dir>/models` that appears in the prior
  // manifest (a dir may have no in-scope items yet still hold on-disk files
  // referenced by stale out-of-scope code).
  const manifestModelDirs = new Set<string>();
  for (const p of ctx.priorTargetManifestPaths ?? []) {
    const m = p.match(new RegExp(`^(src/${ctx.namespace}/[^/]+/models)/[^/]+\\.py$`));
    if (m) manifestModelDirs.add(m[1]);
  }
  for (const dirPath of manifestModelDirs) {
    if (!symbolsByDir.has(dirPath)) symbolsByDir.set(dirPath, []);
    const referencedBasenames = new Set<string>();
    for (const sym of symbolsByDir.get(dirPath)!) {
      if (sym.reExport || sym.retainBasename) continue;
      referencedBasenames.add(symbolToFile.get(sym.name) ?? fileName(sym.name));
    }
    for (const base of priorManifestBasenames(ctx, dirPath, '.py', new Set(['__init__']))) {
      if (referencedBasenames.has(base)) continue;
      referencedBasenames.add(base);
      symbolsByDir.get(dirPath)!.push({ name: base, retainBasename: base });
    }
  }

  // Backwards-compat re-exports: every relocated model is also re-exported
  // from its pre-relocation service barrel so existing
  // `from workos.<service>.models import X` imports keep working.
  const commonDirName = 'common';
  const addReExport = (naturalService: string | undefined, name: string, sourceFile: string): void => {
    if (!naturalService) return;
    const naturalDir = mountDirMap.get(naturalService) ?? naturalService;
    if (naturalDir === commonDirName) return;
    const key = `src/${ctx.namespace}/${naturalDir}/models`;
    if (!symbolsByDir.has(key)) symbolsByDir.set(key, []);
    symbolsByDir.get(key)!.push({ name, reExport: { fromDir: commonDirName, file: sourceFile } });
  };

  for (const symbol of symbolToOriginalService.keys()) {
    // Only re-export symbols that ended up relocated (i.e. their owning model is in relocatedModels)
    // or whose dispatcher parent is relocated.
    const naturalService = symbolToOriginalService.get(symbol)!;
    // Find what file the symbol lives in (in common/)
    const file = symbolToFile.get(symbol) ?? fileName(symbol);
    // Only re-export if it actually got relocated — that is, if its primary
    // model name (or the parent it shares a file with) is in relocatedModels.
    const primaryName = file === fileName(symbol) ? symbol : reverseLookupModelByFile(file, ctx);
    if (primaryName && !relocatedModels.has(primaryName)) continue;
    addReExport(naturalService, symbol, file);
  }
  for (const enumName of relocatedEnums) {
    const naturalService = originalEnumToService.get(enumName);
    addReExport(naturalService, enumName, fileName(enumName));
  }

  // Build set of service directory model paths — these get their parent __init__.py
  // from generateServiceInits in client.ts, so we must not create a competing one here.
  // `inScopeServiceDirModelPaths` is the subset the current run is generating: in a
  // scoped (`--services`) run it excludes services not selected, so a brand-new
  // out-of-scope service the spec just added does not get a stray empty barrel.
  // (Inactive scoping ⇒ isMountInScope is always true ⇒ the two sets match.)
  const serviceDirModelPaths = new Set<string>();
  const inScopeServiceDirModelPaths = new Set<string>();
  for (const service of ctx.spec.services) {
    const dirName = mountDirMap.get(service.name) ?? resolveDir(service.name);
    const modelsPath = `src/${ctx.namespace}/${dirName}/models`;
    serviceDirModelPaths.add(modelsPath);
    if (isMountInScope(getMountTarget(service, ctx), ctx)) {
      inScopeServiceDirModelPaths.add(modelsPath);
    }
  }

  // Emit an empty barrel for every service-models dir that has no symbols of
  // its own (e.g. a service whose models live in another package via
  // cross-domain aliases). Otherwise the live SDK can keep a stale
  // `__init__.py` from a previous spec revision — when the underlying module
  // gets pruned the dangling re-export survives and breaks pyright. Done here
  // (not in client.ts) so a subsequent emission for the same path with real
  // content always wins last-write-wins. Skipped for services outside a scoped
  // run's selection — we don't manage their tree this run.
  for (const dirPath of inScopeServiceDirModelPaths) {
    if (!symbolsByDir.has(dirPath)) {
      files.push({
        path: `${dirPath}/__init__.py`,
        content: '',
        integrateTarget: true,
        overwriteExisting: true,
      });
    }
  }

  for (const [dirPath, symbols] of symbolsByDir) {
    // Deduplicate by symbol name (a direct emission always wins over a stale
    // re-export with the same name).
    const seen = new Map<string, BarrelSymbol>();
    for (const sym of symbols) {
      const existing = seen.get(sym.name);
      if (!existing || (existing.reExport && !sym.reExport)) seen.set(sym.name, sym);
    }
    const uniqueSymbols = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));

    // Use `import X as X` syntax for explicit re-exports (required by pyright strict)
    const importLines: string[] = [];
    for (const sym of uniqueSymbols) {
      if (sym.retainBasename) {
        // On-disk module renamed/removed from the spec: re-export it wholesale
        // since its concrete symbol names are unknown from the manifest alone.
        importLines.push(`from .${sym.retainBasename} import *  # noqa: F401,F403`);
        continue;
      }
      const cls = className(sym.name);
      if (sym.reExport) {
        importLines.push(
          `from ${ctx.namespace}.${dirToModule(sym.reExport.fromDir)}.models.${sym.reExport.file} import ${cls} as ${cls}`,
        );
      } else {
        const fileNameForSymbol = symbolToFile.get(sym.name) ?? fileName(sym.name);
        importLines.push(`from .${fileNameForSymbol} import ${cls} as ${cls}`);
      }
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
      const reExports = [
        ...new Set(
          uniqueSymbols.map((sym) =>
            sym.retainBasename
              ? 'from .models import *  # noqa: F401,F403'
              : `from .models import ${className(sym.name)} as ${className(sym.name)}`,
          ),
        ),
      ].join('\n');
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

/**
 * Given a snake_case file name, return the IR model name that owns it.
 * Used to attribute dispatcher children (FooVariant, FooUnknown) to their
 * parent model when computing relocation re-exports.
 */
function reverseLookupModelByFile(file: string, ctx: EmitterContext): string | undefined {
  for (const m of ctx.spec.models) {
    if (fileName(m.name) === file) return m.name;
  }
  return undefined;
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

/**
 * If `field` is a discriminated-union (or nullable-wrapped discriminated-union)
 * field, return prelude statements that perform strict dispatch and an
 * expression for the `cls(...)` call. Returns null otherwise.
 *
 * Strict dispatch means: an unknown discriminator value raises ValueError
 * naming the parent class, field, observed value, and valid options. The
 * caller's `try/except` block converts that into `_raise_deserialize_error`.
 */
function renderDiscriminatedUnionPrelude(
  field: any,
  pyFieldName: string,
  wireKey: string,
  parentClassName: string,
  isRequired: boolean,
): { prelude: string[]; expr: string } | null {
  let unionRef: any = null;
  let nullable = false;
  if (field.type.kind === 'union' && field.type.discriminator?.mapping) {
    unionRef = field.type;
  } else if (
    field.type.kind === 'nullable' &&
    field.type.inner.kind === 'union' &&
    field.type.inner.discriminator?.mapping
  ) {
    unionRef = field.type.inner;
    nullable = true;
  }
  if (!unionRef) return null;

  const mapping = unionRef.discriminator.mapping as Record<string, string>;
  const entries = Object.entries(mapping);
  if (entries.length === 0) return null;

  const discProp = unionRef.discriminator.property as string;
  const rawVar = `_${pyFieldName}_raw`;
  const dataVar = `_${pyFieldName}_data`;
  const typeVar = `_${pyFieldName}_disc`;
  const mapVar = `_${pyFieldName}_disc_map`;
  const clsVar = `_${pyFieldName}_cls`;
  const valueVar = `_${pyFieldName}_value`;
  const indent = '            ';

  const dispatchBlock = (innerIndent: string): string[] => {
    const lines: string[] = [];
    lines.push(`${innerIndent}${dataVar} = cast(Dict[str, Any], ${rawVar})`);
    lines.push(`${innerIndent}${typeVar} = cast(str, ${dataVar}.get("${discProp}"))`);
    lines.push(`${innerIndent}${mapVar}: Dict[str, Any] = {`);
    for (const [value, variantModelName] of entries) {
      lines.push(`${innerIndent}    "${value}": ${className(variantModelName)},`);
    }
    lines.push(`${innerIndent}}`);
    lines.push(`${innerIndent}${clsVar} = ${mapVar}.get(${typeVar})`);
    lines.push(`${innerIndent}if ${clsVar} is None:`);
    lines.push(`${innerIndent}    raise ValueError(`);
    lines.push(
      `${innerIndent}        f"Unknown discriminator '${discProp}' for ${parentClassName}.${pyFieldName}: {${typeVar}!r}. "`,
    );
    lines.push(`${innerIndent}        f"Expected one of {sorted(${mapVar})}."`);
    lines.push(`${innerIndent}    )`);
    return lines;
  };

  const prelude: string[] = [];
  if (isRequired && !nullable) {
    prelude.push(`${indent}${rawVar} = data["${wireKey}"]`);
    prelude.push(...dispatchBlock(indent));
    return { prelude, expr: `${clsVar}.from_dict(${dataVar})` };
  }

  // Optional or nullable: handle missing/None explicitly.
  const accessor = isRequired ? `data["${wireKey}"]` : `data.get("${wireKey}")`;
  prelude.push(`${indent}${rawVar} = ${accessor}`);
  prelude.push(`${indent}if ${rawVar} is None:`);
  prelude.push(`${indent}    ${valueVar} = None`);
  prelude.push(`${indent}else:`);
  prelude.push(...dispatchBlock(indent + '    '));
  prelude.push(`${indent}    ${valueVar} = ${clsVar}.from_dict(${dataVar})`);
  return { prelude, expr: valueVar };
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
      // Discriminated unions are handled by `renderDiscriminatedUnionPrelude`
      // before deserializeField is called, so they never reach this branch.
      const modelVariants = (ref.variants ?? []).filter((v: any) => v.kind === 'model');
      const uniqueModels = [...new Set(modelVariants.map((v: any) => v.name))] as string[];
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
      // Discriminated union: from_dict always produces a concrete dataclass
      // instance (unknown discriminators raise instead of falling back to a
      // raw dict), so the serialized field is unconditionally `.to_dict()`-able.
      if (ref.discriminator && ref.discriminator.mapping && modelVariants.length > 0) {
        return `${accessor}.to_dict()`;
      }
      return accessor;
    }
    default:
      return accessor;
  }
}

// Import and re-export shared model detection utilities
import {
  isListMetadataModel,
  isListWrapperModel,
  collectNonPaginatedResponseModelNames,
  collectReferencedListMetadataModels,
} from '../shared/model-utils.js';
export { isListMetadataModel, isListWrapperModel };
