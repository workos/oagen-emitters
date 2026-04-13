import type { Enum, EmitterContext, GeneratedFile, Service } from '@workos/oagen';
import { walkTypeRef } from '@workos/oagen';
import { className, deprecationMessage, escapeCsAttributeString } from './naming.js';
import { setEnumAliases } from './type-map.js';

/**
 * Generate C# enum definitions from IR Enum definitions.
 * Each enum becomes a separate .cs file. Structurally-identical enums are
 * deduplicated: only the canonical (alphabetically-first) name is emitted,
 * and every reference to a duplicate enum is rewritten to the canonical one
 * by `mapTypeRef` via `setEnumAliases`.
 */
export function generateEnums(enums: Enum[], ctx: EmitterContext): GeneratedFile[] {
  if (enums.length === 0) return [];

  // Publish the alias map so model/options/wrapper emitters all resolve
  // duplicate enum references to the canonical name.
  const aliasOf = collectEnumAliasOf(enums);
  setEnumAliases(aliasOf);

  const files: GeneratedFile[] = [];

  for (const enumDef of enums) {
    const typeName = className(enumDef.name);

    // Skip duplicate enums — their references are retargeted to the canonical.
    if (aliasOf.has(enumDef.name)) continue;

    // Skip empty enums (use string in type-map)
    if (enumDef.values.length === 0) continue;

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
