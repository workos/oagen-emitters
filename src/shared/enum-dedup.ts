import type { EmitterContext, Enum } from '@workos/oagen';

/**
 * Subset of `ApiSurface` that the dedup helper needs. We accept `unknown` for
 * the `enums` value type because `ApiEnum` isn't part of the public oagen
 * surface; only the keys (canonical class names) matter here.
 */
type SurfaceEnumContainer = { enums?: Record<string, unknown> };

/**
 * Options controlling how `buildEnumAliasMap` chooses a canonical enum within
 * a value-equivalent group.
 */
export interface EnumDedupOptions {
  /**
   * Output class names that were canonical in the previous build (typically
   * `Object.keys(ctx.apiSurface.enums)`). When any enum in a group's
   * `classNameOf(...)` lands in this set, that enum wins — making the
   * canonical choice stable across spec versions.
   *
   * Without this, adding a new enum whose values match an existing canonical
   * can flip the canonical (because the dedup tie-breaker — shortest name,
   * alphabetical, etc. — is computed from the current spec only). That
   * silently renames a previously-canonical enum to an alias, which dotnet
   * (which can't emit aliases) reports as a removal and Go/Ruby/Python/PHP
   * surface as a `Type` -> `OtherType` rename. All five are breaking.
   */
  baselineCanonicalNames?: ReadonlySet<string>;

  /**
   * Map an IR enum name to the language-specific class name stored in
   * `ApiSurface.enums`. Used to compare IR enums against
   * `baselineCanonicalNames`. Defaults to identity, which works when the IR
   * name and the emitted class name are identical (the common case for
   * PascalCase-preserving emitters).
   */
  classNameOf?: (irName: string) => string;

  /**
   * Tie-break among enums in a value-equivalent group when no baseline match
   * applies. The default picks the alphabetically-first IR name; emitters
   * with name-length preferences (PHP, Kotlin) pass their own.
   */
  selectCanonical?: (group: readonly Enum[]) => Enum;
}

/**
 * Group enums whose value sets are identical and pick one canonical per
 * group. Returns a `aliasName -> canonicalName` map keyed and valued by IR
 * enum name. Enums that are alone in their hash group don't appear in the
 * map (they're already canonical by virtue of being the only one).
 *
 * Selection order within a group:
 *   1. If `baselineCanonicalNames` is provided and any enum's
 *      `classNameOf(name)` is in it, the alphabetically-first such enum wins
 *      (preserves the previous build's canonical).
 *   2. Otherwise `selectCanonical(group)` is consulted.
 */
export function buildEnumAliasMap(enums: readonly Enum[], options: EnumDedupOptions = {}): Map<string, string> {
  const baseline = options.baselineCanonicalNames;
  const classNameOf = options.classNameOf ?? identity;
  const selectCanonical = options.selectCanonical ?? selectAlphabeticallyFirst;

  const groups = new Map<string, Enum[]>();
  for (const e of enums) {
    const hash = hashValues(e);
    let g = groups.get(hash);
    if (!g) {
      g = [];
      groups.set(hash, g);
    }
    g.push(e);
  }

  const aliasOf = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    const canonical = pickCanonical(group, baseline, classNameOf, selectCanonical);
    for (const e of group) {
      if (e.name !== canonical.name) aliasOf.set(e.name, canonical.name);
    }
  }
  return aliasOf;
}

/**
 * Extract the set of canonical enum class names from a previous build's
 * `ApiSurface`. `ApiSurface.enums` is keyed by the language-specific class
 * name, so the returned set is suitable for `EnumDedupOptions.baselineCanonicalNames`
 * provided the emitter's `classNameOf` produces the same form.
 *
 * Returns `undefined` when the surface is absent (e.g. first-ever build, or
 * the consumer didn't extract a baseline) so callers can branch on
 * "baseline-aware vs not" with a single check.
 */
export function baselineEnumNamesFrom(
  surface: EmitterContext['apiSurface'] | SurfaceEnumContainer | undefined,
): ReadonlySet<string> | undefined {
  const enums = surface?.enums;
  if (!enums) return undefined;
  const names = Object.keys(enums);
  if (names.length === 0) return undefined;
  return new Set(names);
}

function hashValues(e: Enum): string {
  return [...e.values]
    .map((v) => String(v.value))
    .sort()
    .join('|');
}

function pickCanonical(
  group: readonly Enum[],
  baseline: ReadonlySet<string> | undefined,
  classNameOf: (irName: string) => string,
  selectCanonical: (group: readonly Enum[]) => Enum,
): Enum {
  if (baseline) {
    const fromBaseline = group
      .filter((e) => baseline.has(classNameOf(e.name)))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (fromBaseline.length > 0) return fromBaseline[0];
  }
  return selectCanonical(group);
}

function selectAlphabeticallyFirst(group: readonly Enum[]): Enum {
  return [...group].sort((a, b) => a.name.localeCompare(b.name))[0];
}

function identity(s: string): string {
  return s;
}
