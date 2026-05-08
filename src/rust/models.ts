import type { Model, EmitterContext, GeneratedFile, Field } from '@workos/oagen';
import { typeName, fieldName, moduleName } from './naming.js';
import { mapTypeRef, makeOptional, UnionRegistry } from './type-map.js';

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

  for (const model of models) {
    // Empty-field, non-discriminator models still need to be emitted as an
    // empty struct so request bodies that reference them (e.g. an empty
    // `CreateApplicationSecretDto`) compile.
    const mod = moduleName(model.name);
    if (seen.has(mod)) continue;
    seen.add(mod);
    moduleNames.push(mod);

    const hintPath = ctx.overlayLookup?.fileBySymbol?.get(model.name);
    const path = hintPath ?? `src/models/${mod}.rs`;
    files.push({ path, content: renderModel(model, registry), overwriteExisting: true });
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

function renderModel(model: Model, registry: UnionRegistry): string {
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
  const fieldLines = model.fields.map((f, i) => renderField(f, resolvedNames[i]!, model.name, registry));

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
 * Resolve unique Rust identifiers for struct fields. Multiple wire names can
 * collide after `fieldName()` snake-cases them (e.g. `integration_type` and
 * `integrationType` both become `integration_type`). Subsequent collisions get
 * a numeric suffix so the struct compiles; serde `rename` preserves the
 * original wire name in every case.
 */
function resolveFieldNames(fields: Field[]): string[] {
  const used = new Set<string>();
  const out: string[] = [];
  for (const f of fields) {
    const base = fieldName(f.name);
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

function renderField(field: Field, rustField: string, modelName: string, registry: UnionRegistry): string {
  const lines: string[] = [];
  if (field.description) {
    for (const c of docComment(field.description)) lines.push(`    ${c}`);
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

  if (rename) lines.push(`    #[serde(rename = "${rename}")]`);
  if (baseType.startsWith('Option<')) {
    lines.push('    #[serde(skip_serializing_if = "Option::is_none", default)]');
  }
  if (field.deprecated) lines.push('    #[deprecated]');
  lines.push(`    pub ${rustField}: ${baseType},`);
  return lines.join('\n');
}

function renderModelsBarrel(modules: string[]): string {
  const sorted = [...new Set(modules)].sort();
  const lines: string[] = [];
  for (const m of sorted) lines.push(`pub mod ${m};`);
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
