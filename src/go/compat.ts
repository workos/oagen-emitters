import type { Enum, Model, TypeRef } from '@workos/oagen';

/**
 * Go-only compatibility table for workos-go v10.5.0 symbols that later specs
 * renamed or deduplicated away. The spec carries no trace of these names, so
 * each entry is listed explicitly. Every entry applies only while its names
 * exist and its shapes still match, and is skipped silently otherwise.
 */

/**
 * Models folded into an older model: `into` gains the model's extra optional
 * fields, and the model becomes `type Model = Into`, so both names compile.
 */
const FOLDED_MODELS: { model: string; into: string }[] = [
  // v10.5.0: the six connected-account write methods returned *ConnectedAccount.
  // ConnectedAccount gains the always-empty-on-read `Warnings` field.
  { model: 'ConnectedAccountWriteResponse', into: 'ConnectedAccount' },
];

/** Extra `type Alias = Target` declarations for model names the spec dropped. */
const MODEL_ALIASES: { alias: string; target: string }[] = [
  // v10.5.0: DataIntegrationCredentialsResponse.Credential was
  // *DataIntegrationCredentialsResponseCredential.
  { alias: 'DataIntegrationCredentialsResponseCredential', target: 'DataIntegrationVendedCredential' },
];

/** Enums that keep their own typed constants even when deduplicated into an alias. */
const ALIAS_ENUMS_WITH_CONSTANTS = new Set([
  // v10.5.0: CreateDataIntegrationOwnershipUser / CreateDataIntegrationOwnershipOrganization.
  'CreateDataIntegrationOwnership',
  // v10.5.0: AgentInstanceCreatedDataTypeDelegated / AgentInstanceCreatedDataTypeAutonomous.
  'AgentInstanceCreatedDataType',
]);

/**
 * Apply FOLDED_MODELS: returns the models with each `into` model extended, and
 * the alias map (model -> into) for the folds that matched.
 */
export function foldCompatModels(models: Model[], enums: Enum[]): { models: Model[]; aliases: Map<string, string> } {
  const aliases = new Map<string, string>();
  const byName = new Map(models.map((m) => [m.name, m]));
  const replaced = new Map<string, Model>();
  for (const { model, into } of FOLDED_MODELS) {
    const from = byName.get(model);
    const base = byName.get(into);
    if (!from || !base || replaced.has(into)) continue;
    // Every base field must appear unchanged; anything extra must be optional.
    const fromFields = new Map(from.fields.map((f) => [f.name, f]));
    const matches = base.fields.every((f) => {
      const other = fromFields.get(f.name);
      return other && other.required === f.required && sameType(other.type, f.type, enums);
    });
    const baseNames = new Set(base.fields.map((f) => f.name));
    const extra = from.fields.filter((f) => !baseNames.has(f.name));
    if (!matches || extra.some((f) => f.required)) continue;
    replaced.set(into, { ...base, fields: [...base.fields, ...extra] });
    aliases.set(model, into);
  }
  return { models: models.map((m) => replaced.get(m.name) ?? m), aliases };
}

/** MODEL_ALIASES whose target exists and whose alias name is still free. */
export function compatModelAliases(models: Model[]): { alias: string; target: string }[] {
  const names = new Set(models.map((m) => m.name));
  return MODEL_ALIASES.filter(({ alias, target }) => names.has(target) && !names.has(alias));
}

export function keepsAliasEnumConstants(name: string): boolean {
  return ALIAS_ENUMS_WITH_CONSTANTS.has(name);
}

/** Type equality that treats enums with the same value set as the same type. */
function sameType(a: TypeRef, b: TypeRef, enums: Enum[]): boolean {
  const normalize = (ref: TypeRef): string =>
    JSON.stringify(ref, (_key, value) => {
      if (value?.kind !== 'enum') return value;
      const values = value.values ?? enums.find((e) => e.name === value.name)?.values.map((v) => v.value);
      return { kind: 'enum', values: values ? [...values].map(String).sort() : value.name };
    });
  return normalize(a) === normalize(b);
}
