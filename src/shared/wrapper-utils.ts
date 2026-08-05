import type { EmitterContext, Field, ResolvedWrapper } from '@workos/oagen';
import { toPascalCase, toSnakeCase } from '@workos/oagen';
import { enrichModelsFromSpec } from './model-utils.js';

/**
 * A resolved wrapper parameter with its variant model field and optional status.
 * Pre-computed once per wrapper so emitters don't repeat the lookup.
 */
export interface ResolvedWrapperParam {
  /** Wire name of the param (e.g., "email", "grant_type"). */
  paramName: string;
  /** The field from the variant model, or null if not found in the spec. */
  field: Field | null;
  /** Whether this param should be optional in the generated SDK. */
  isOptional: boolean;
}

/**
 * Resolve the variant model's fields for a wrapper's exposed params.
 *
 * Encapsulates the three-step lookup every emitter needs:
 * 1. Find the variant model via wrapper.targetVariant in ctx.spec.models
 * 2. Match each exposed param to its field in the variant
 * 3. Classify as required or optional using wrapper.optionalParams + field.required
 *
 * Field matching uses exact name first, then falls back to snake_case normalization
 * to handle cases where wire names and model field names differ in casing.
 */
export function resolveWrapperParams(wrapper: ResolvedWrapper, ctx: EmitterContext): ResolvedWrapperParam[] {
  let variantModel = ctx.spec.models.find((m) => m.name === wrapper.targetVariant);

  // If the variant model has no fields, try enriching from the raw spec.
  // Some oneOf variants have 0 IR fields until enrichModelsFromSpec backfills them.
  if (!variantModel || variantModel.fields.length === 0) {
    const enriched = enrichModelsFromSpec(ctx.spec.models);
    variantModel = enriched.find((m) => m.name === wrapper.targetVariant) ?? variantModel;
  }

  const variantFields = variantModel?.fields ?? [];
  const optionalSet = new Set(wrapper.optionalParams);

  return wrapper.exposedParams.map((paramName) => {
    const field =
      variantFields.find((f) => f.name === paramName || toSnakeCase(f.name) === toSnakeCase(paramName)) ?? null;
    // Default to required: a wrapper exists to make a specific call shape work,
    // and exposedParams is the contract for that shape. Mark optional only when
    // (a) the wrapper hint explicitly says so, or (b) the IR variant model
    // resolves and reports the field as not required.
    let isOptional: boolean;
    if (optionalSet.has(paramName)) {
      isOptional = true;
    } else if (field) {
      isOptional = !field.required;
    } else {
      isOptional = false;
    }
    return { paramName, field, isOptional };
  });
}

/**
 * Format a snake_case wrapper name into a human-readable description.
 * "authenticate_with_password" → "Authenticate with password"
 *
 * Each `_`-separated segment is recased through `toPascalCase`, so acronyms
 * inherit oagen's `ACRONYM_SET` — the same source of truth the emitted method
 * name uses. Lower-casing the raw segments instead produced a doc line that
 * contradicted the symbol directly below it ("Create oauth application" over
 * `createOAuthApplication`).
 *
 * Segments are kept at their original boundaries rather than re-split out of the
 * camelCased whole: `splitPascalWords` mis-splits digit-adjacent acronyms
 * (`M2M` → `2` + `MApplication`), and it also drives public method naming, so it
 * is not the place to absorb a doc-formatting concern.
 *
 * A recased segment is preserved when `toPascalCase` marked it as an acronym
 * (interior capitals, or a capital adjacent to a digit); otherwise it is
 * lower-cased. The first word is capitalized to open the sentence.
 */
export function formatWrapperDescription(name: string): string {
  return name
    .split('_')
    .map((segment, i) => {
      const cased = toPascalCase(segment);
      const isAcronym = /[A-Z].*[A-Z]|[A-Z][0-9]|[0-9][A-Z]/.test(cased);
      const word = isAcronym ? cased : segment.toLowerCase();
      return i === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word;
    })
    .join(' ');
}
