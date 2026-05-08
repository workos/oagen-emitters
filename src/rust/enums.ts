import type { Enum, EmitterContext, GeneratedFile } from '@workos/oagen';
import { toSnakeCase } from '@workos/oagen';
import { typeName, moduleName, variantName } from './naming.js';

/**
 * Generate one Rust source file per enum under `src/enums/`, plus a
 * `src/enums/mod.rs` barrel.
 */
export function generateEnums(enums: Enum[], _ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const seen = new Set<string>();
  const moduleNames: string[] = [];

  for (const e of enums) {
    if (!e.values || e.values.length === 0) continue;
    const mod = moduleName(e.name);
    if (seen.has(mod)) continue;
    seen.add(mod);
    moduleNames.push(mod);

    files.push({
      path: `src/enums/${mod}.rs`,
      content: renderEnum(e),
    });
  }

  files.push({
    path: 'src/enums/mod.rs',
    content: renderEnumsBarrel(moduleNames),
  });

  return files;
}

function renderEnum(e: Enum): string {
  const lines: string[] = [];
  lines.push('use serde::{Deserialize, Serialize};');
  lines.push('');

  // Decide whether to derive Copy: only when every variant is a unit string
  // small enough to be Copy-cheap (always true for unit variants here).
  lines.push('#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]');

  const allDefaultRename = e.values.every(
    (v) => typeof v.value === 'string' && variantToSnakeCase(v.value) === v.value,
  );
  if (allDefaultRename) {
    lines.push('#[serde(rename_all = "snake_case")]');
  }

  lines.push(`pub enum ${typeName(e.name)} {`);

  // Multiple wire values can collapse to the same Rust variant (e.g. "sign-up",
  // "sign_up", "sign up" -> SignUp). Keep the first occurrence and emit
  // serde alias entries for subsequent variants so all wire values still
  // deserialize without producing duplicate Rust variants.
  const emitted = new Map<string, string[]>();
  const variantOrder: string[] = [];
  for (const v of e.values) {
    const variant = variantName(v.value);
    if (!emitted.has(variant)) {
      emitted.set(variant, []);
      variantOrder.push(variant);
    }
    emitted.get(variant)!.push(String(v.value));
  }

  const valuesByVariant = new Map<string, Enum['values'][number]>();
  for (const v of e.values) {
    const variant = variantName(v.value);
    if (!valuesByVariant.has(variant)) valuesByVariant.set(variant, v);
  }

  for (const variant of variantOrder) {
    const v = valuesByVariant.get(variant)!;
    const wireValues = emitted.get(variant)!;
    if (v.description) {
      for (const c of docComment(v.description)) lines.push(`    ${c}`);
    }
    if (v.deprecated) lines.push('    #[deprecated]');
    if (!allDefaultRename) {
      lines.push(`    #[serde(rename = ${JSON.stringify(wireValues[0])})]`);
    }
    for (const alias of wireValues.slice(1)) {
      lines.push(`    #[serde(alias = ${JSON.stringify(alias)})]`);
    }
    lines.push(`    ${variant},`);
  }
  lines.push('}');

  return lines.join('\n') + '\n';
}

function variantToSnakeCase(value: string): string {
  // Match how serde's `rename_all = "snake_case"` would convert the variant
  // name back to the wire string. Variant names come from `variantName(value)`
  // which is PascalCase; converting back to snake_case via `toSnakeCase`
  // should round-trip to the original wire value when it was already
  // snake_case.
  return toSnakeCase(value);
}

function renderEnumsBarrel(modules: string[]): string {
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
