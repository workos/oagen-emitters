import type { Enum, EmitterContext, GeneratedFile, Service } from '@workos/oagen';
import { walkTypeRef } from '@workos/oagen';
import { className, deprecationMessage, escapeCsAttributeString } from './naming.js';
import { setEnumAliases, setSingleValueEnumNames } from './type-map.js';

/**
 * Generate C# enum definitions from IR Enum definitions.
 * Each enum becomes a separate .cs file. Structurally-identical enums are
 * deduplicated: only the canonical (alphabetically-first) name is emitted,
 * and every reference to a duplicate enum is rewritten to the canonical one
 * by `mapTypeRef` via `setEnumAliases`.
 */
export function generateEnums(enums: Enum[], ctx: EmitterContext): GeneratedFile[] {
  if (enums.length === 0) return [];

  // Publish the alias map + single-value enum set so model/options/wrapper
  // emitters all resolve duplicate enum references to the canonical name and
  // rewrite 1-value enum refs to `string`.
  const aliasOf = collectEnumAliasOf(enums);
  setEnumAliases(aliasOf);
  setSingleValueEnumNames(enums.filter((e) => e.values.length === 1).map((e) => e.name));
  diagnoseDivergentEnums(enums);

  const files: GeneratedFile[] = [];

  for (const enumDef of enums) {
    const typeName = className(enumDef.name);

    // Skip duplicate enums — their references are retargeted to the canonical.
    if (aliasOf.has(enumDef.name)) continue;

    // Skip empty and single-value enums — the single-value case is a discriminator
    // masquerading as an enum, and mapTypeRef rewrites such refs to `string` with
    // a const initializer on the owning property.
    if (enumDef.values.length <= 1) continue;

    // Deduplicate values
    const seenValues = new Set<string>();
    const uniqueValues: typeof enumDef.values = [];
    for (const v of enumDef.values) {
      const vs = String(v.value);
      if (!seenValues.has(vs)) {
        seenValues.add(vs);
        uniqueValues.push(v);
      }
    }

    const lines: string[] = [];
    lines.push(`namespace ${ctx.namespacePascal}`);
    lines.push('{');
    lines.push('    using System.Runtime.Serialization;');
    lines.push('    using Newtonsoft.Json;');
    lines.push('    using STJS = System.Text.Json.Serialization;');
    lines.push('');
    lines.push(`    /// <summary>Represents ${humanize(enumDef.name)} values.</summary>`);
    lines.push('    [JsonConverter(typeof(WorkOSNewtonsoftStringEnumConverter))]');
    lines.push('    [STJS.JsonConverter(typeof(WorkOSStringEnumConverterFactory))]');
    lines.push(`    public enum ${typeName}`);
    lines.push('    {');
    // Unknown sentinel as first member (value 0) for forward-compatibility
    lines.push(`        [EnumMember(Value = "unknown")]`);
    lines.push(`        Unknown,`);
    lines.push('');

    const usedNames = new Set<string>();
    usedNames.add('Unknown');
    // Track used EnumMember wire values to avoid duplicates (sentinel uses "unknown")
    const usedWireValues = new Set<string>();
    usedWireValues.add('unknown');
    for (let i = 0; i < uniqueValues.length; i++) {
      const v = uniqueValues[i];
      // Skip values whose wire representation collides with the sentinel
      if (usedWireValues.has(String(v.value))) continue;
      usedWireValues.add(String(v.value));
      let memberName = className(String(v.value));
      // Avoid collision with the type itself or previously used names
      if (memberName === typeName || usedNames.has(memberName)) {
        let suffix = 2;
        while (usedNames.has(`${memberName}${suffix}`)) suffix++;
        memberName = `${memberName}${suffix}`;
      }
      usedNames.add(memberName);

      if (v.description) {
        lines.push(`        /// <summary>${escapeXml(v.description)}</summary>`);
      }
      if (v.deprecated) {
        const msg = escapeCsAttributeString(deprecationMessage(v.description, 'value'));
        lines.push(`        [System.Obsolete("${msg}")]`);
      }
      lines.push(`        [EnumMember(Value = "${v.value}")]`);
      const comma = i < uniqueValues.length - 1 ? ',' : ',';
      lines.push(`        ${memberName}${comma}`);
    }

    lines.push('    }');
    lines.push('}');

    files.push({
      path: `Enums/${typeName}.cs`,
      content: lines.join('\n'),
      overwriteExisting: true,
    });
  }

  return files;
}

function humanize(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase();
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Populate the module-level enum alias resolver from the given spec's enums.
 * Call from every emitter entrypoint that uses `mapTypeRef` so enum
 * references resolve to their canonical names regardless of which emitter
 * phase runs first.
 */
export function primeEnumAliases(enums: Enum[]): void {
  setEnumAliases(collectEnumAliasOf(enums));
  setSingleValueEnumNames(enums.filter((e) => e.values.length === 1).map((e) => e.name));
}

/**
 * Warn when two enums share a trailing stem (e.g., `ConnectionType`) but
 * carry divergent wire values. Such pairs usually mean the spec drifted:
 * one endpoint documents a different set of enum members than another for
 * the same concept. Catching this at generation time surfaces API/spec
 * mismatches that would otherwise ship quietly.
 */
export function diagnoseDivergentEnums(enums: Enum[]): void {
  const byStem = new Map<string, Enum[]>();
  for (const e of enums) {
    if (e.values.length < 2) continue;
    const stem = trailingPascalStem(e.name);
    if (!stem) continue;
    if (!byStem.has(stem)) byStem.set(stem, []);
    byStem.get(stem)!.push(e);
  }

  for (const [stem, group] of byStem) {
    if (group.length < 2) continue;
    const canonicalValues = valueSignature(group[0]);
    const divergent = group.filter((e) => valueSignature(e) !== canonicalValues);
    if (divergent.length === 0) continue;
    // Don't warn for pure dedupe (same values, different names) — that's
    // already handled by the alias pass.
    const valueSets = new Set(group.map(valueSignature));
    if (valueSets.size === 1) continue;
    const summary = group.map((e) => `${e.name}[${e.values.length}]`).join(', ');
    console.warn(`[oagen:dotnet] Divergent enums sharing stem "${stem}": ${summary}`);
  }
}

function trailingPascalStem(name: string): string | null {
  // Extract the last two PascalCase segments so that `SSOConnectionType`
  // and `ConnectionFindResponseConnectionType` both map to `ConnectionType`.
  const segments = name.match(/[A-Z]+[a-z0-9]*/g);
  if (!segments || segments.length < 2) return null;
  return segments.slice(-2).join('');
}

function valueSignature(e: Enum): string {
  return [...e.values]
    .map((v) => String(v.value))
    .sort()
    .join('|');
}

function collectEnumAliasOf(enums: Enum[]): Map<string, string> {
  const hashGroups = new Map<string, string[]>();
  for (const enumDef of enums) {
    const hash = [...enumDef.values]
      .map((v) => String(v.value))
      .sort()
      .join('|');
    if (!hashGroups.has(hash)) hashGroups.set(hash, []);
    hashGroups.get(hash)!.push(enumDef.name);
  }

  const aliasOf = new Map<string, string>();
  for (const [, names] of hashGroups) {
    if (names.length <= 1) continue;
    const sorted = [...names].sort();
    const canonical = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      aliasOf.set(sorted[i], canonical);
    }
  }
  return aliasOf;
}

/** Get the canonical enum name if the given enum is an alias. */
export function resolveEnumName(name: string, enums: Enum[]): string {
  const aliasOf = collectEnumAliasOf(enums);
  return aliasOf.get(name) ? className(aliasOf.get(name)!) : className(name);
}

export function assignEnumsToServices(enums: Enum[], services: Service[]): Map<string, string> {
  const enumToService = new Map<string, string>();
  const enumNames = new Set(enums.map((e) => e.name));

  for (const service of services) {
    for (const op of service.operations) {
      const refs = new Set<string>();
      const collect = (ref: any) => {
        walkTypeRef(ref, { enum: (r: any) => refs.add(r.name) });
      };
      if (op.requestBody) collect(op.requestBody);
      collect(op.response);
      for (const p of [...op.pathParams, ...op.queryParams, ...op.headerParams, ...(op.cookieParams ?? [])]) {
        collect(p.type);
      }
      for (const name of refs) {
        if (enumNames.has(name) && !enumToService.has(name)) {
          enumToService.set(name, service.name);
        }
      }
    }
  }

  return enumToService;
}
