import type { Enum, EnumValue, EmitterContext, GeneratedFile } from '@workos/oagen';
import { toSnakeCase } from '@workos/oagen';
import { fullModuleName, fileName, atomLiteral, escapeString, escapeDoc } from './naming.js';
import { isEnumInScope } from '../shared/resolved-ops.js';

/**
 * Generate one Elixir module per IR enum. String enums become atom unions with
 * `cast/1` (wire string → atom; unknown values pass through as strings for
 * forward compatibility) and `dump/1` (atom → wire string). Numeric enums keep
 * their raw values with identity cast/dump.
 */
export function generateEnums(enums: Enum[], ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const seen = new Set<string>();
  for (const enumDef of enums) {
    if (seen.has(enumDef.name)) continue;
    seen.add(enumDef.name);
    if (!isEnumInScope(enumDef.name, ctx)) continue;
    files.push({
      path: `lib/${ctx.namespace}/${fileName(enumDef.name)}.ex`,
      content: renderEnum(enumDef, ctx),
      integrateTarget: true,
      overwriteExisting: true,
    });
  }
  return files;
}

/** Dedupe enum values by wire value (keep first occurrence). */
function uniqueValues(enumDef: Enum): EnumValue[] {
  const seen = new Set<string | number>();
  const out: EnumValue[] = [];
  for (const v of enumDef.values) {
    if (seen.has(v.value)) continue;
    seen.add(v.value);
    out.push(v);
  }
  return out;
}

/**
 * Assign each string value a unique atom literal. Prefers the snake_cased
 * display name; falls back to a quoted raw-value atom on collision or when the
 * derived name is not a plain atom.
 */
function assignAtoms(values: EnumValue[]): Map<string, string> {
  const byValue = new Map<string, string>();
  const used = new Set<string>();
  for (const v of values) {
    const value = String(v.value);
    const derived = toSnakeCase(v.name);
    let atom: string;
    if (/^[a-z_][a-zA-Z0-9_]*$/.test(derived) && !used.has(`:${derived}`)) {
      atom = `:${derived}`;
    } else {
      atom = atomLiteral(value);
    }
    used.add(atom);
    byValue.set(value, atom);
  }
  return byValue;
}

function renderEnum(enumDef: Enum, ctx: EmitterContext): string {
  const values = uniqueValues(enumDef);
  const allStrings = values.every((v) => typeof v.value === 'string');
  const lines: string[] = [];

  lines.push(`defmodule ${fullModuleName(ctx, enumDef.name)} do`);
  lines.push('  @moduledoc """');
  lines.push(`  ${escapeDoc(enumDef.name)} enum.`);
  const documented = values.filter((v) => v.description || v.deprecated);
  if (documented.length > 0) {
    lines.push('');
    for (const v of documented) {
      const tag = v.deprecated ? '(deprecated)' : '';
      const doc = [tag, escapeDoc(v.description ?? '')].filter((s) => s.length > 0).join(' ');
      lines.push(`  - \`${String(v.value)}\` — ${doc}`);
    }
  }
  lines.push('  """');
  lines.push('');

  if (!allStrings || values.length === 0) {
    const literals = values.map((v) => (typeof v.value === 'string' ? `"${escapeString(v.value)}"` : String(v.value)));
    lines.push(`  @type t :: ${literals.length > 0 ? literals.join(' | ') : 'term()'}`);
    lines.push('');
    lines.push('  @doc "All known values."');
    lines.push('  @spec values() :: [t()]');
    lines.push(`  def values, do: [${literals.join(', ')}]`);
    lines.push('');
    lines.push('  @doc "Casts a wire value; non-string enums pass values through unchanged."');
    lines.push('  @spec cast(term()) :: term()');
    lines.push('  def cast(value), do: value');
    lines.push('');
    lines.push('  @doc "Dumps a value back to its wire form."');
    lines.push('  @spec dump(term()) :: term()');
    lines.push('  def dump(value), do: value');
    lines.push('end');
    return lines.join('\n');
  }

  const atoms = assignAtoms(values);
  const atomList = values.map((v) => atoms.get(String(v.value))!);

  lines.push(`  @type t :: ${atomList.join(' | ')}`);
  lines.push('');
  lines.push('  @doc "All known values."');
  lines.push('  @spec values() :: [t()]');
  lines.push(`  def values, do: [${atomList.join(', ')}]`);
  lines.push('');
  lines.push('  @doc "Casts a wire string to its atom; unknown values pass through unchanged."');
  lines.push('  @spec cast(String.t() | nil) :: t() | String.t() | nil');
  for (const v of values) {
    const value = String(v.value);
    lines.push(`  def cast("${escapeString(value)}"), do: ${atoms.get(value)!}`);
  }
  lines.push('  def cast(other), do: other');
  lines.push('');
  lines.push('  @doc "Dumps an atom back to its wire string."');
  lines.push('  @spec dump(t() | String.t()) :: String.t()');
  for (const v of values) {
    const value = String(v.value);
    lines.push(`  def dump(${atoms.get(value)!}), do: "${escapeString(value)}"`);
  }
  lines.push('  def dump(other) when is_binary(other), do: other');
  lines.push('end');

  return lines.join('\n');
}
