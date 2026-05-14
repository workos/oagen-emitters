import type { Enum, EmitterContext, GeneratedFile } from '@workos/oagen';
import { typeName, moduleName, variantName } from './naming.js';

/**
 * Generate one Rust source file per enum under `src/enums/`, plus a
 * `src/enums/mod.rs` barrel.
 *
 * Each enum is emitted as a string-backed, forward-compatible Rust enum:
 *   - `#[non_exhaustive]` so callers can't write exhaustive matches that
 *     break when WorkOS adds a new value server-side.
 *   - A fallback variant (`Unknown(String)` by default, or `Unrecognized` /
 *     `Other` / `OagenUnknown` if the spec already defines a variant by that
 *     name) captures any wire value the SDK doesn't yet recognize, preserving
 *     the original string instead of failing deserialization.
 *   - Manual `Serialize`/`Deserialize` map between the canonical wire string
 *     and the Rust variant; alias wire values deserialize into the canonical
 *     variant and re-serialize as the canonical wire string.
 *   - `Display`, `FromStr`, and `AsRef<str>` are implemented for ergonomics.
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
      overwriteExisting: true,
    });
  }

  files.push({
    path: 'src/enums/mod.rs',
    content: renderEnumsBarrel(moduleNames),
    overwriteExisting: true,
  });

  return files;
}

function renderEnum(e: Enum): string {
  const lines: string[] = [];
  const tname = typeName(e.name);

  // Collapse wire values that map to the same Rust variant. The first wire
  // value for a variant is the canonical one (used for serialization); the
  // remaining ones are aliases (accepted on deserialization).
  const order: string[] = [];
  const wireByVariant = new Map<string, string[]>();
  const descByVariant = new Map<string, string | undefined>();
  const deprecatedByVariant = new Map<string, boolean>();
  for (const v of e.values) {
    const variant = variantName(v.value);
    if (!wireByVariant.has(variant)) {
      wireByVariant.set(variant, []);
      order.push(variant);
      descByVariant.set(variant, v.description);
      deprecatedByVariant.set(variant, !!v.deprecated);
    }
    wireByVariant.get(variant)!.push(String(v.value));
  }

  // Pick a fallback-variant name that doesn't collide with an existing one.
  // Prefer `Unknown` for ergonomics; fall back to less-likely names for the
  // (rare) enums whose spec already defines `Unknown`/`Unrecognized`/`Other`.
  const taken = new Set(order);
  const FB = ['Unknown', 'Unrecognized', 'Other', 'OagenUnknown'].find((c) => !taken.has(c)) ?? 'OagenUnknown';

  lines.push('use serde::{Deserialize, Serialize};');
  lines.push('use std::fmt;');
  lines.push('use std::str::FromStr;');
  lines.push('');

  lines.push('#[derive(Debug, Clone, PartialEq, Eq, Hash)]');
  lines.push('#[non_exhaustive]');
  lines.push(`pub enum ${tname} {`);
  for (const variant of order) {
    const desc = descByVariant.get(variant);
    if (desc) {
      for (const c of docComment(desc)) lines.push(`    ${c}`);
    }
    if (deprecatedByVariant.get(variant)) lines.push('    #[allow(deprecated)]');
    lines.push(`    ${variant},`);
  }
  lines.push('    /// Wire value not recognized by this SDK version. The original');
  lines.push('    /// string is preserved verbatim. WorkOS may add new enum values');
  lines.push('    /// server-side; matching on this variant lets callers handle');
  lines.push('    /// forward-compatible values without panicking.');
  lines.push(`    ${FB}(String),`);
  lines.push('}');
  lines.push('');

  // as_str(): canonical wire value for known variants, inner string for fallback.
  lines.push(`impl ${tname} {`);
  lines.push(`    /// Canonical wire string for this value. For [\`Self::${FB}\`] returns the`);
  lines.push('    /// original wire value as received from the API.');
  lines.push('    #[allow(deprecated)]');
  lines.push('    pub fn as_str(&self) -> &str {');
  lines.push('        match self {');
  for (const variant of order) {
    const canonical = wireByVariant.get(variant)![0]!;
    lines.push(`            Self::${variant} => ${JSON.stringify(canonical)},`);
  }
  lines.push(`            Self::${FB}(s) => s.as_str(),`);
  lines.push('        }');
  lines.push('    }');
  lines.push('}');
  lines.push('');

  // Display via as_str().
  lines.push(`impl fmt::Display for ${tname} {`);
  lines.push("    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {");
  lines.push('        f.write_str(self.as_str())');
  lines.push('    }');
  lines.push('}');
  lines.push('');

  // AsRef<str>.
  lines.push(`impl AsRef<str> for ${tname} {`);
  lines.push('    fn as_ref(&self) -> &str {');
  lines.push('        self.as_str()');
  lines.push('    }');
  lines.push('}');
  lines.push('');

  // FromStr — infallible (fallback variant captures anything else).
  lines.push(`impl FromStr for ${tname} {`);
  lines.push('    type Err = std::convert::Infallible;');
  lines.push('    #[allow(deprecated)]');
  lines.push('    fn from_str(s: &str) -> Result<Self, Self::Err> {');
  lines.push('        Ok(match s {');
  for (const variant of order) {
    const wires = wireByVariant.get(variant)!;
    for (const w of wires) {
      lines.push(`            ${JSON.stringify(w)} => Self::${variant},`);
    }
  }
  lines.push(`            other => Self::${FB}(other.to_string()),`);
  lines.push('        })');
  lines.push('    }');
  lines.push('}');
  lines.push('');

  // From<String>/From<&str>.
  lines.push(`impl From<String> for ${tname} {`);
  lines.push('    fn from(s: String) -> Self {');
  lines.push('        // Reuse the original `String` allocation in the fallback branch.');
  lines.push('        match Self::from_str(&s) {');
  lines.push(`            Ok(Self::${FB}(_)) => Self::${FB}(s),`);
  lines.push('            Ok(other) => other,');
  lines.push('        }');
  lines.push('    }');
  lines.push('}');
  lines.push('');
  lines.push(`impl From<&str> for ${tname} {`);
  lines.push('    fn from(s: &str) -> Self {');
  lines.push(`        Self::from_str(s).unwrap_or_else(|_| Self::${FB}(s.to_string()))`);
  lines.push('    }');
  lines.push('}');
  lines.push('');

  // Manual Serialize / Deserialize.
  lines.push(`impl Serialize for ${tname} {`);
  lines.push('    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {');
  lines.push('        serializer.serialize_str(self.as_str())');
  lines.push('    }');
  lines.push('}');
  lines.push('');
  lines.push(`impl<'de> Deserialize<'de> for ${tname} {`);
  lines.push("    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {");
  lines.push('        let s = String::deserialize(deserializer)?;');
  lines.push('        Ok(Self::from(s))');
  lines.push('    }');
  lines.push('}');

  return lines.join('\n') + '\n';
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
