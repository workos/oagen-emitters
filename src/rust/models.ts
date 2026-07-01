import type { Model, EmitterContext, GeneratedFile, Field, TypeRef } from '@workos/oagen';
import { typeName, domainFieldName, moduleName } from './naming.js';
import { mapTypeRef, makeOptional, UnionRegistry } from './type-map.js';
import { applySecretRedaction } from './secret.js';
import { isModelInScope, fileExistsAfterRun, priorManifestBasenames } from '../shared/resolved-ops.js';

const HEADER_PLACEHOLDER = ''; // engine prepends fileHeader()

const UNIONS_MODULE = '_unions';

/**
 * Generate one Rust source file per model under `src/models/`, plus a
 * `src/models/mod.rs` barrel that re-exports each module. Inline IR unions
 * encountered in field positions are synthesised into a single
 * `src/models/_unions.rs` module so the resulting Rust types are concrete.
 */
export function generateModels(models: Model[], ctx: EmitterContext, registry: UnionRegistry): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const moduleNames: string[] = [];
  const seen = new Set<string>();

  // Map of variant-model name -> discriminator wire-property for every model
  // that appears as an arm of an internally-tagged (`#[serde(tag = ...)]`)
  // union. serde consumes that property as the enum tag and strips it from the
  // variant body during deserialization, so a *required* field of the same
  // name can never be satisfied ("missing field `type`"). See renderField.
  const taggedVariantFields = collectTaggedVariantFields(models);

  for (const model of models) {
    // Empty-field, non-discriminator models still need to be emitted as an
    // empty struct so request bodies that reference them (e.g. an empty
    // `CreateApplicationSecretDto`) compile.
    const mod = moduleName(model.name);
    if (seen.has(mod)) continue;
    seen.add(mod);

    // renderModel registers inline unions into `registry` as a side effect, and
    // `_unions.rs` is rendered later (in generateClient) from that registry.
    // Register a model's unions ONLY when its own `.rs` file will exist on disk
    // after this run — in-scope (emitted just below) or already present from a
    // prior run (fileExistsAfterRun). A model that is NEITHER selected NOR on
    // disk (e.g. a service the spec recently gained but this SDK has never
    // generated, such as Agent) must NOT contribute: its variant model files
    // are never written, so the synthesised enum in `_unions.rs` would
    // reference dangling types and break the build (orphan class). On-disk
    // out-of-scope models DO register — their existing `.rs` files reference
    // those unions, so `_unions.rs` must keep them. A full run registers every
    // model (fileExistsAfterRun ⇒ true when scoping is inert).
    const inScope = isModelInScope(model.name, ctx);
    const hintPath = ctx.overlayLookup?.fileBySymbol?.get(model.name);
    const path = hintPath ?? `src/models/${mod}.rs`;
    if (!fileExistsAfterRun(path, inScope, ctx)) continue;

    const content = renderModel(model, registry, taggedVariantFields.get(model.name));
    if (inScope) {
      files.push({
        path,
        content,
        overwriteExisting: true,
      });
    }
    moduleNames.push(mod);
  }

  // Scoped runs: retain barrel entries for model files still on disk (prior
  // manifest) that the current spec no longer produces — e.g. a model renamed
  // for another service. Out-of-scope code we did not regenerate may still
  // reference them, so dropping the `mod` would break the build. De-duped
  // against the modules declared above; a full run yields nothing here.
  for (const base of priorManifestBasenames(ctx, 'src/models', '.rs', new Set([UNIONS_MODULE, 'mod']))) {
    if (!seen.has(base)) {
      seen.add(base);
      moduleNames.push(base);
    }
  }

  // Always include the unions module in the barrel so downstream stages
  // (resources, etc.) that register additional unions don't need to mutate
  // the barrel after the fact. The actual `_unions.rs` file is rendered in
  // generateClient once every stage has finished registering.
  moduleNames.push(UNIONS_MODULE);

  files.push({
    path: 'src/models/mod.rs',
    content: renderModelsBarrel(moduleNames),
    overwriteExisting: true,
  });

  return files;
}

/**
 * Walk every model field and record which models are arms of an
 * internally-tagged union, mapped to that union's discriminator property.
 */
function collectTaggedVariantFields(models: Model[]): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (ref: TypeRef): void => {
    switch (ref.kind) {
      case 'union':
        if (ref.discriminator?.property) {
          for (const variant of ref.variants) {
            const name = variantModelName(variant);
            if (name) out.set(name, ref.discriminator.property);
          }
        }
        ref.variants.forEach(visit);
        break;
      case 'array':
        visit(ref.items);
        break;
      case 'nullable':
        visit(ref.inner);
        break;
      case 'map':
        visit(ref.valueType);
        break;
      default:
        break;
    }
  };
  for (const model of models) for (const field of model.fields) visit(field.type);
  return out;
}

/** Resolve the underlying model name of a union arm, unwrapping a nullable. */
function variantModelName(ref: TypeRef): string | null {
  if (ref.kind === 'model') return ref.name;
  if (ref.kind === 'nullable') return variantModelName(ref.inner);
  return null;
}

function renderModel(model: Model, registry: UnionRegistry, tagField?: string): string {
  const lines: string[] = [];
  lines.push(HEADER_PLACEHOLDER);
  // Match rustfmt's canonical grouping: keyword-rooted paths (`super`,
  // `crate`) sort before external-crate paths (`serde`). Pre-emit in that
  // order so `cargo fmt --check` does not reshuffle the file.
  lines.push('#[allow(unused_imports)]');
  lines.push('use super::*;');
  lines.push('#[allow(unused_imports)]');
  lines.push('use crate::enums::*;');
  lines.push('use serde::{Deserialize, Serialize};');
  lines.push('');

  if (model.description) lines.push(...docComment(model.description));

  lines.push('#[derive(Debug, Clone, Serialize, Deserialize)]');

  const resolvedNames = resolveFieldNames(model.fields);
  const fieldLines = model.fields.map((f, i) => renderField(f, resolvedNames[i]!, model.name, registry, tagField));

  // rustfmt collapses zero-field structs to `pub struct Foo {}` on a single
  // line. Match that shape so `cargo fmt --check` passes.
  if (fieldLines.length === 0) {
    lines.push(`pub struct ${typeName(model.name)} {}`);
  } else {
    lines.push(`pub struct ${typeName(model.name)} {`);
    lines.push(...fieldLines);
    lines.push('}');
  }
  return lines.filter((l) => l !== HEADER_PLACEHOLDER).join('\n') + '\n';
}

/**
 * Resolve unique Rust identifiers for struct fields. The domain identifier
 * honors a `fieldHints` override (`domainName`, e.g. wire `connection_type` →
 * domain `type`); the wire name (and the `#[serde(rename = ...)]` key emitted
 * in `renderField`) still derives from `f.name`. Multiple names can collide
 * after snake-casing (e.g. `integration_type` and `integrationType` both
 * become `integration_type`). Subsequent collisions get a numeric suffix so
 * the struct compiles; serde `rename` preserves the original wire name in every
 * case.
 */
function resolveFieldNames(fields: Field[]): string[] {
  const used = new Set<string>();
  const out: string[] = [];
  for (const f of fields) {
    const base = domainFieldName(f);
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = `${base}_${suffix}`;
      suffix++;
    }
    used.add(candidate);
    out.push(candidate);
  }
  return out;
}

function renderField(
  field: Field,
  rustField: string,
  modelName: string,
  registry: UnionRegistry,
  tagField?: string,
): string {
  const lines: string[] = [];
  const hasDescription = !!field.description;
  if (hasDescription) {
    for (const c of docComment(field.description!)) lines.push(`    ${c}`);
  }
  if (field.default != null) {
    if (hasDescription) lines.push('    ///');
    lines.push(`    /// Defaults to \`${formatDefault(field.default)}\`.`);
  }

  const rename = rustField !== field.name ? field.name : null;

  let baseType = mapTypeRef(field.type, {
    hint: `${typeName(modelName)}${typeName(field.name)}`,
    registry,
  });
  const isOptional = !field.required || field.type.kind === 'nullable';
  if (isOptional && !baseType.startsWith('Option<')) {
    baseType = makeOptional(baseType);
  }
  // Wrap String / Option<String> in SecretString when the field name implies
  // the value is a credential or token. Wire format is unchanged.
  baseType = applySecretRedaction(baseType, field.name);

  if (tagField === field.name) {
    // This field is the discriminator of an internally-tagged union it belongs
    // to. serde reads it as the enum tag and strips it from the variant body,
    // so `default` lets the struct deserialize without it; `skip_serializing`
    // stops the struct from re-emitting it (serde injects the tag itself,
    // which would otherwise produce a duplicate key). Standalone uses of the
    // struct still deserialize the value normally because the key is present.
    const args = rename ? `rename = "${rename}", default, skip_serializing` : 'default, skip_serializing';
    lines.push(`    #[serde(${args})]`);
  } else {
    if (rename) lines.push(`    #[serde(rename = "${rename}")]`);
    if (baseType.startsWith('Option<')) {
      lines.push('    #[serde(skip_serializing_if = "Option::is_none", default)]');
    }
  }
  if (field.deprecated) lines.push('    #[deprecated]');
  lines.push(`    pub ${rustField}: ${baseType},`);
  return lines.join('\n');
}

function renderModelsBarrel(modules: string[]): string {
  const sorted = [...new Set(modules)].sort();
  const lines: string[] = [];
  // Declare the modules privately so `pub use crate::models::*` in lib.rs only
  // re-exports the struct names, not the module names themselves. Otherwise a
  // module like `models::organization_membership` collides with the same-named
  // `resources::organization_membership` when both barrels are glob-re-exported.
  for (const m of sorted) lines.push(`mod ${m};`);
  lines.push('');
  for (const m of sorted) lines.push(`pub use ${m}::*;`);
  return lines.join('\n') + '\n';
}

function docComment(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => `/// ${l}`);
}

/**
 * Render a spec-level default value for inclusion in a doc comment. Strings
 * render bare (e.g. `desc`) so they nest naturally inside the surrounding
 * backticks; numbers/booleans use JSON encoding.
 */
function formatDefault(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}
