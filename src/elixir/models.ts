import type { Model, Field, EmitterContext, GeneratedFile } from '@workos/oagen';
import { mapTypeRef, addNil } from './type-map.js';
import { fullModuleName, moduleName, fileName, fieldName, escapeDoc, escapeString, nsPascal } from './naming.js';
import { castExpr, dumpExpr, type CastNames } from './casting.js';
import { isModelInScope } from '../shared/resolved-ops.js';
import { getSyntheticEnums } from '../shared/model-utils.js';

/**
 * Generate one Elixir module per IR model: `defstruct` + `@type t` +
 * `from_map/1` (wire → struct, recursive) + `to_map/1` (struct → wire).
 */
export function generateModels(models: Model[], ctx: EmitterContext): GeneratedFile[] {
  const enumNames = new Set([...ctx.spec.enums.map((e) => e.name), ...getSyntheticEnums().map((e) => e.name)]);
  const modelNames = new Set(models.map((m) => m.name));

  const files: GeneratedFile[] = [];
  for (const model of models) {
    if (!isModelInScope(model.name, ctx)) continue;
    files.push({
      path: `lib/${ctx.namespace}/${fileName(model.name)}.ex`,
      content: renderModel(model, ctx, { modelNames, enumNames }),
      integrateTarget: true,
      overwriteExisting: true,
    });
  }
  return files;
}

/** Required fields first (stable order within each partition). */
function orderedFields(model: Model): Field[] {
  // Deduplicate fields that map to the same snake_case struct key (e.g. a spec
  // exposing both `created_at` and `createdAt`) — first occurrence in spec
  // order wins, matching the Python emitter. Elixir rejects duplicate
  // defstruct keys outright.
  const seenFieldNames = new Set<string>();
  const fields = model.fields.filter((f) => {
    const name = fieldName(f.name);
    if (seenFieldNames.has(name)) return false;
    seenFieldNames.add(name);
    return true;
  });
  return [...fields.filter((f) => f.required), ...fields.filter((f) => !f.required)];
}

function renderModel(model: Model, ctx: EmitterContext, baseNames: CastNames): string {
  const ns = nsPascal(ctx);
  const names: CastNames = {
    ...baseNames,
    typeParamNames: new Set((model.typeParams ?? []).map((p) => p.name)),
  };
  const fields = orderedFields(model);
  const lines: string[] = [];

  lines.push(`defmodule ${fullModuleName(ctx, model.name)} do`);
  lines.push('  @moduledoc """');
  // The fallback names the module, not the raw IR schema name: acronym fixes and
  // URN stripping mean those differ (`MfaTotp…` vs `MFATotp…`), and a doc that
  // names a symbol the SDK does not define is worse than no doc at all.
  lines.push(
    `  ${escapeDoc(model.description ?? `${moduleName(model.name)} model.`)
      .split('\n')
      .join('\n  ')}`,
  );
  // Elixir has no struct-field @deprecated attribute — surface spec
  // deprecations as a moduledoc section instead.
  const deprecatedFields = fields.filter((f) => f.deprecated);
  if (deprecatedFields.length > 0) {
    lines.push('');
    lines.push('  ## Deprecated fields');
    lines.push('');
    for (const field of deprecatedFields) {
      const note = field.description ? ` — ${escapeDoc(field.description).split('\n').join(' ')}` : '';
      lines.push(`    * \`:${fieldName(field.name)}\`${note}`);
    }
  }
  lines.push('  """');
  lines.push('');

  if (fields.length === 0) {
    lines.push('  defstruct []');
    lines.push('');
    lines.push('  @type t :: %__MODULE__{}');
    lines.push('');
    lines.push('  @doc false');
    lines.push('  @spec from_map(map()) :: t()');
    lines.push('  def from_map(map) when is_map(map), do: %__MODULE__{}');
    lines.push('');
    lines.push('  @doc false');
    lines.push('  @spec to_map(t()) :: map()');
    lines.push('  def to_map(%__MODULE__{}), do: %{}');
    lines.push('end');
    return lines.join('\n');
  }

  lines.push('  defstruct [');
  for (const field of fields) {
    lines.push(`    :${fieldName(field.name)},`);
  }
  // Trailing commas are invalid in Elixir lists — strip from the last entry.
  lines[lines.length - 1] = lines[lines.length - 1].replace(/,$/, '');
  lines.push('  ]');
  lines.push('');

  lines.push('  @type t :: %__MODULE__{');
  for (const field of fields) {
    const spec = mapTypeRef(field.type, {
      nsPascal: ns,
      typeParamNames: names.typeParamNames,
    });
    const finalSpec = field.required ? spec : addNil(spec);
    lines.push(`          ${fieldName(field.name)}: ${finalSpec},`);
  }
  lines[lines.length - 1] = lines[lines.length - 1].replace(/,$/, '');
  lines.push('        }');
  lines.push('');

  lines.push('  @doc false');
  lines.push('  @spec from_map(map()) :: t()');
  lines.push('  def from_map(map) when is_map(map) do');
  lines.push('    %__MODULE__{');
  for (const field of fields) {
    const expr = castExpr(field.type, `map["${escapeString(field.name)}"]`, ctx, names);
    lines.push(`      ${fieldName(field.name)}: ${expr},`);
  }
  lines[lines.length - 1] = lines[lines.length - 1].replace(/,$/, '');
  lines.push('    }');
  lines.push('  end');
  lines.push('');

  lines.push('  @doc false');
  lines.push('  @spec to_map(t()) :: map()');
  lines.push('  def to_map(%__MODULE__{} = struct) do');
  lines.push(`    ${ns}.Cast.drop_nils(%{`);
  for (const field of fields) {
    const expr = dumpExpr(field.type, `struct.${fieldName(field.name)}`, ctx, names);
    lines.push(`      "${escapeString(field.name)}" => ${expr},`);
  }
  lines[lines.length - 1] = lines[lines.length - 1].replace(/,$/, '');
  lines.push('    })');
  lines.push('  end');
  lines.push('end');

  return lines.join('\n');
}
