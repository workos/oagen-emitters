import type { Enum, EnumValue, EmitterContext, GeneratedFile } from '@workos/oagen';
import { toCamelCase } from '@workos/oagen';
import { typeName, fileName, escapeReserved, swiftStringLiteral, moduleName } from './naming.js';

/**
 * Generate one forward-compatible Swift enum file per IR enum.
 *
 * Enums conform to `RawRepresentable`, `Codable`, `Sendable`, `Hashable` with a
 * NON-failable `init(rawValue:)` that maps unknown wire values to `.unknown`,
 * so a server-added value never crashes decoding. Explicit `init(from:)` /
 * `encode(to:)` are emitted rather than relying on stdlib conditional
 * conformance.
 */
export function generateEnums(enums: Enum[], ctx: EmitterContext): GeneratedFile[] {
  const module = moduleName(ctx);
  return enums.map((e) => ({
    path: `Sources/${module}/Enums/${fileName(e.name)}.swift`,
    content: renderEnum(e),
  }));
}

function docComment(description: string | undefined, indent: string): string {
  if (!description) return '';
  return description
    .trim()
    .split('\n')
    .map((line) => (line.trim() ? `${indent}/// ${line.trim()}` : `${indent}///`))
    .join('\n');
}

interface RenderedCase {
  id: string;
  value: string | number;
  isNumeric: boolean;
  description?: string;
  deprecated?: boolean;
}

/** Derive a unique, valid Swift case identifier from an enum value. */
function caseIdentifier(source: string, seen: Set<string>): string {
  let base = toCamelCase(source);
  if (base === '' || /^[0-9]/.test(base)) base = `value${base ? base.charAt(0).toUpperCase() + base.slice(1) : ''}`;
  let candidate = base;
  let n = 2;
  while (seen.has(candidate)) {
    candidate = `${base}${n++}`;
  }
  seen.add(candidate);
  return escapeReserved(candidate);
}

function renderEnum(e: Enum): string {
  const name = typeName(e.name);
  const isNumeric = e.values.length > 0 && e.values.every((v) => typeof v.value === 'number');
  const rawType = isNumeric ? 'Int' : 'String';
  const unknownType = rawType;

  // Reserve the forward-compat sentinel name so a real `unknown` wire value
  // (which some specs define) is suffixed instead of redeclaring `case unknown`.
  const seen = new Set<string>(['unknown']);
  const cases: RenderedCase[] = e.values.map((ev: EnumValue) => ({
    id: caseIdentifier(String(ev.name ?? ev.value), seen),
    value: ev.value,
    isNumeric: typeof ev.value === 'number',
    description: ev.description,
    deprecated: ev.deprecated,
  }));

  const literal = (v: string | number, numeric: boolean): string =>
    numeric ? String(v) : swiftStringLiteral(String(v));

  const lines: string[] = [];
  lines.push('import Foundation');
  lines.push('');
  const doc = docComment(`Enumeration of valid ${name} values.`, '');
  if (doc) lines.push(doc);
  lines.push(`public enum ${name}: RawRepresentable, Codable, Sendable, Hashable {`);

  for (const c of cases) {
    const cdoc = docComment(c.description, '    ');
    if (cdoc) lines.push(cdoc);
    if (c.deprecated) lines.push('    @available(*, deprecated)');
    lines.push(`    case ${c.id}`);
  }
  lines.push('    /// A value not known at SDK generation time.');
  lines.push(`    case unknown(${unknownType})`);
  lines.push('');

  // init(rawValue:) — non-failable.
  lines.push(`    public init(rawValue: ${rawType}) {`);
  lines.push('        switch rawValue {');
  for (const c of cases) {
    lines.push(`        case ${literal(c.value, isNumeric)}: self = .${c.id}`);
  }
  lines.push('        default: self = .unknown(rawValue)');
  lines.push('        }');
  lines.push('    }');
  lines.push('');

  // rawValue.
  lines.push(`    public var rawValue: ${rawType} {`);
  lines.push('        switch self {');
  for (const c of cases) {
    lines.push(`        case .${c.id}: return ${literal(c.value, isNumeric)}`);
  }
  lines.push('        case .unknown(let value): return value');
  lines.push('        }');
  lines.push('    }');
  lines.push('');

  // Codable.
  lines.push('    public init(from decoder: Decoder) throws {');
  lines.push(`        let raw = try decoder.singleValueContainer().decode(${rawType}.self)`);
  lines.push('        self.init(rawValue: raw)');
  lines.push('    }');
  lines.push('');
  lines.push('    public func encode(to encoder: Encoder) throws {');
  lines.push('        var container = encoder.singleValueContainer()');
  lines.push('        try container.encode(rawValue)');
  lines.push('    }');
  lines.push('');

  // allKnownCases convenience (CaseIterable can't synthesize with associated values).
  // Multiline (with trailing commas) when the single-line form would exceed the
  // 100-column swift-format lineLength.
  const known = cases.map((c) => `.${c.id}`).join(', ');
  const singleLine = `    public static let allKnownCases: [${name}] = [${known}]`;
  if (singleLine.length <= 100) {
    lines.push(singleLine);
  } else {
    lines.push(`    public static let allKnownCases: [${name}] = [`);
    for (const c of cases) {
      lines.push(`        .${c.id},`);
    }
    lines.push('    ]');
  }

  lines.push('}');
  return lines.join('\n');
}
