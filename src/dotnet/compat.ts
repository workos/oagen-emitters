import type { Model } from '@workos/oagen';
import { mapTypeRef } from './type-map.js';

/**
 * WorkOS.net 6.4.0 type names that the current spec no longer produces on its
 * own. Each entry names the 6.4.0 symbol it preserves and applies only while
 * the names it refers to exist and the shapes still match; otherwise the
 * generic output is left unchanged.
 */

/** Enum dedup canonicals: elected over the alphabetically-first name of their duplicate group. */
const PREFERRED_ENUM_CANONICALS: ReadonlyArray<{ name: string; values: readonly string[] }> = [
  // 6.4.0 `CreateDataIntegrationOwnership` (Pipes `Ownership` / `ConnectionOwner` options).
  { name: 'CreateDataIntegrationOwnership', values: ['organization', 'user'] },
  // 6.4.0 `AgentInstanceCreatedDataType` (`AgentInstance.Type`, `AgentInstanceCreatedData.Type`).
  { name: 'AgentInstanceCreatedDataType', values: ['autonomous', 'delegated'] },
];

/** The preserved 6.4.0 name among a group of duplicate enums sharing `sortedValues`, if any. */
export function preferredEnumCanonical(names: readonly string[], sortedValues: readonly string[]): string | undefined {
  return PREFERRED_ENUM_CANONICALS.find((e) => names.includes(e.name) && e.values.join('|') === sortedValues.join('|'))
    ?.name;
}

/**
 * Model base classes: `derived` extends `base`, so 6.4.0 code that names
 * `base` keeps compiling while `derived`'s extra members stay reachable.
 * `baseFields` synthesizes a 6.4.0 base the spec no longer declares from
 * those fields of `derived`.
 */
const MODEL_BASE_CLASSES: ReadonlyArray<{ derived: string; base: string; baseFields?: readonly string[] }> = [
  // 6.4.0 connected-account write methods returned `ConnectedAccount`; the response now adds `warnings`.
  { derived: 'ConnectedAccountWriteResponse', base: 'ConnectedAccount' },
  // 6.4.0 `DataIntegrationCredentialsResponseCredential` (the vended credential), now `DataIntegrationVendedCredential`.
  {
    derived: 'DataIntegrationVendedCredential',
    base: 'DataIntegrationCredentialsResponseCredential',
    baseFields: ['object', 'auth_method', 'value', 'expires_at', 'scopes', 'missing_scopes'],
  },
];

/**
 * The base-class entries that apply to `models`, plus any base models to
 * synthesize. An entry applies only when every base field exists on the
 * derived model with the same C# type and requiredness, so no property is
 * hidden or retyped.
 */
export function compatBaseClasses(models: readonly Model[]): {
  variantToBase: Map<string, string>;
  synthesized: Model[];
} {
  const byName = new Map(models.map((m) => [m.name, m]));
  const variantToBase = new Map<string, string>();
  const synthesized: Model[] = [];
  for (const entry of MODEL_BASE_CLASSES) {
    const derived = byName.get(entry.derived);
    if (!derived) continue;
    const declared = byName.get(entry.base);
    if (declared && entry.baseFields) continue; // the spec declares the 6.4.0 name again
    if (!declared && !entry.baseFields) continue; // the spec dropped the base model
    const base: Model = declared ?? {
      name: entry.base,
      description: `Base of ${entry.derived}, kept so WorkOS.net 6.4.0 code that names this type still compiles.`,
      fields: derived.fields.filter((f) => entry.baseFields!.includes(f.name)),
    };
    if (entry.baseFields && base.fields.length !== entry.baseFields.length) continue;
    const matches = base.fields.every((bf) => {
      const df = derived.fields.find((f) => f.name === bf.name);
      return df !== undefined && df.required === bf.required && mapTypeRef(df.type) === mapTypeRef(bf.type);
    });
    if (!matches) continue;
    variantToBase.set(entry.derived, entry.base);
    if (!declared) synthesized.push(base);
  }
  return { variantToBase, synthesized };
}
