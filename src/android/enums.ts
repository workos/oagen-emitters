import type { Enum, EnumValue, EmitterContext, GeneratedFile } from '@workos/oagen';
import { toPascalCase } from '@workos/oagen';
import { isEnumInScope } from '../shared/resolved-ops.js';
import { typeName, fileName, mainSourcePath, subPackage, ktStringLiteral } from './naming.js';
import { renderImportBlock } from './imports.js';
import { renderDocComment } from './doc-comments.js';

/**
 * Generate one forward-compatible sealed-class file per IR enum.
 *
 * A Kotlin `enum class` cannot carry an unrecognized wire value, so an unknown
 * server value would have to re-serialize as the wrong token — breaking wire
 * parity on round-trip. A sealed class preserves it in `Unknown(value)`, which
 * matches the iOS emitter's `case unknown(String)` and still gives `when`
 * exhaustiveness checking at the call site.
 */
export function generateEnums(enums: Enum[], ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  for (const e of enums) {
    // Scoped (`--services`) runs leave out-of-scope enum files untouched on disk.
    if (!isEnumInScope(e.name, ctx)) continue;
    files.push({
      path: mainSourcePath(ctx, 'enums', fileName(e.name)),
      content: renderEnum(e, ctx),
    });
  }
  return files;
}

interface RenderedCase {
  id: string;
  value: string | number;
  description?: string;
  deprecated?: boolean;
}

/**
 * Derive a unique, valid Kotlin object name from an enum value. `Unknown`,
 * `Serializer`, and `Companion` are reserved so a real wire value with one of
 * those names is suffixed rather than colliding with generated members.
 */
function caseIdentifier(source: string, seen: Set<string>): string {
  let base = toPascalCase(source);
  if (base === '' || /^[0-9]/.test(base)) base = `Value${base}`;
  let candidate = base;
  let n = 2;
  while (seen.has(candidate)) {
    candidate = `${base}${n++}`;
  }
  seen.add(candidate);
  return candidate;
}

function renderEnum(e: Enum, ctx: EmitterContext): string {
  const name = typeName(e.name);
  const pkg = subPackage(ctx, 'enums');
  const isNumeric = e.values.length > 0 && e.values.every((v) => typeof v.value === 'number');
  const rawType = isNumeric ? 'Int' : 'String';
  const primitiveKind = isNumeric ? 'PrimitiveKind.INT' : 'PrimitiveKind.STRING';
  const decodeCall = isNumeric ? 'decoder.decodeInt()' : 'decoder.decodeString()';
  const encodeCall = isNumeric ? 'encoder.encodeInt(value.rawValue)' : 'encoder.encodeString(value.rawValue)';

  const seen = new Set<string>(['Unknown', 'Serializer', 'Companion']);
  const cases: RenderedCase[] = e.values.map((ev: EnumValue) => ({
    id: caseIdentifier(String(ev.name ?? ev.value), seen),
    value: ev.value,
    description: ev.description,
    deprecated: ev.deprecated,
  }));

  const literal = (v: string | number): string => (isNumeric ? String(v) : ktStringLiteral(String(v)));

  const imports = [
    'kotlinx.serialization.KSerializer',
    'kotlinx.serialization.Serializable',
    'kotlinx.serialization.descriptors.PrimitiveKind',
    'kotlinx.serialization.descriptors.PrimitiveSerialDescriptor',
    'kotlinx.serialization.descriptors.SerialDescriptor',
    'kotlinx.serialization.encoding.Decoder',
    'kotlinx.serialization.encoding.Encoder',
  ];

  const lines: string[] = [];
  lines.push(`package ${pkg}`);
  lines.push('');
  lines.push(...renderImportBlock(imports, pkg));
  lines.push('');
  lines.push(...renderDocComment(`Enumeration of valid ${name} values.`, ''));
  lines.push(`@Serializable(with = ${name}.Serializer::class)`);
  lines.push(`public sealed class ${name}(public val rawValue: ${rawType}) {`);

  for (const c of cases) {
    lines.push(...renderDocComment(c.description, '    '));
    if (c.deprecated) lines.push('    @Deprecated("This value is deprecated.")');
    lines.push(`    public data object ${c.id} : ${name}(${literal(c.value)})`);
  }

  lines.push('');
  lines.push('    /** A value not known at SDK generation time. */');
  lines.push(`    public data class Unknown(public val value: ${rawType}) : ${name}(value)`);
  lines.push('');

  // Companion: the known-value list plus a total raw-value parser.
  lines.push('    public companion object {');
  if (cases.length === 0) {
    lines.push(`        public val allKnownValues: List<${name}> = emptyList()`);
  } else {
    const known = cases.map((c) => c.id).join(', ');
    const singleLine = `        public val allKnownValues: List<${name}> = listOf(${known})`;
    if (singleLine.length <= 120) {
      lines.push(singleLine);
    } else {
      lines.push(`        public val allKnownValues: List<${name}> =`);
      lines.push('            listOf(');
      for (const c of cases) lines.push(`                ${c.id},`);
      lines.push('            )');
    }
  }
  lines.push('');
  lines.push(`        /** Parse a wire value, mapping anything unrecognized to [Unknown]. */`);
  lines.push(`        public fun fromRawValue(rawValue: ${rawType}): ${name} =`);
  if (cases.length === 0) {
    lines.push('            Unknown(rawValue)');
  } else {
    lines.push('            when (rawValue) {');
    for (const c of cases) {
      lines.push(`                ${literal(c.value)} -> ${c.id}`);
    }
    lines.push('                else -> Unknown(rawValue)');
    lines.push('            }');
  }
  lines.push('    }');
  lines.push('');

  // Generated serializer: emitted explicitly rather than relying on any implicit
  // conformance, so encoding always round-trips `rawValue` verbatim.
  lines.push(`    internal object Serializer : KSerializer<${name}> {`);
  lines.push('        override val descriptor: SerialDescriptor =');
  lines.push(`            PrimitiveSerialDescriptor(${ktStringLiteral(name)}, ${primitiveKind})`);
  lines.push('');
  lines.push(`        override fun deserialize(decoder: Decoder): ${name} = fromRawValue(${decodeCall})`);
  lines.push('');
  lines.push(`        override fun serialize(encoder: Encoder, value: ${name}) {`);
  lines.push(`            ${encodeCall}`);
  lines.push('        }');
  lines.push('    }');
  lines.push('}');
  return lines.join('\n');
}
