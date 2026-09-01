// ---------------------------------------------------------------------------
// Shared acronym fixes
// ---------------------------------------------------------------------------

/**
 * Base set of acronym corrections applied after PascalCase conversion.
 * These are domain-specific terms that `toPascalCase` produces as e.g.
 * "Sso" but should be rendered as "SSO" in every SDK language.
 *
 * Language emitters can extend this with additional entries (e.g. Go adds
 * API, URL, HTTP, JSON, etc. per Go naming conventions).
 */
export const BASE_ACRONYM_FIXES: readonly [RegExp, string][] = [
  [/Workos/g, 'WorkOS'],
  [/Sso/g, 'SSO'],
  [/Mfa/g, 'MFA'],
  [/Jwt/g, 'JWT'],
  [/Cors/g, 'CORS'],
  [/Saml/g, 'SAML'],
  [/Scim/g, 'SCIM'],
  [/Rbac/g, 'RBAC'],
  [/Oauth/g, 'OAuth'],
  [/Oidc/g, 'OIDC'],
];

/**
 * Apply acronym corrections to a PascalCase string.
 * Uses the base set by default; pass extra entries for language-specific
 * conventions (e.g. Go's `[/Api(?=[A-Z]|$)/g, 'API']`).
 */
export function applyAcronymFixes(s: string, extra?: readonly [RegExp, string][]): string {
  let result = s;
  for (const [pattern, replacement] of BASE_ACRONYM_FIXES) {
    result = result.replace(pattern, replacement);
  }
  if (extra) {
    for (const [pattern, replacement] of extra) {
      result = result.replace(pattern, replacement);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// URN stripping
// ---------------------------------------------------------------------------

/** Strip URN OAuth grant-type prefixes from discriminator-derived schema names. */
export function stripUrnPrefix(name: string): string {
  // Handles both OAuth and Oauth casing from different PascalCase implementations
  return name.replace(/^Urn(?:IetfParams|Workos)O[Aa]uthGrantType/, '');
}

// ---------------------------------------------------------------------------
// Mount-noun trimming (Stripe-style method names)
// ---------------------------------------------------------------------------

/** Split a camelCase / PascalCase identifier into words, preserving casing. */
export function splitPascalWords(name: string): string[] {
  return name.match(/[A-Z]+(?:[a-z]+|(?=[A-Z]|$))|[A-Z]?[a-z]+|[0-9]+/g) ?? [name];
}

/** Naive singularizer sufficient for matching resource nouns. */
function singularizeWord(word: string): string {
  if (word.endsWith('ies') && word.length > 3) {
    return `${word.slice(0, -3)}y`;
  }
  if (word.endsWith('s') && !word.endsWith('ss')) {
    return word.slice(0, -1);
  }
  return word;
}

function mountWordsMatch(left: string, right: string): boolean {
  return singularizeWord(left.toLowerCase()) === singularizeWord(right.toLowerCase());
}

/**
 * Strip the mount-group resource noun when it directly follows the leading
 * verb, so `listOrganizations` on the `Organizations` resource becomes `list`
 * and `getOrganizationMembership` on `OrganizationMembership` becomes `get` —
 * but `listUserAuthFactors` on `MultiFactorAuth` is left alone (the words after
 * the verb don't start with the mount noun). Matching is case-insensitive and
 * singular/plural tolerant; untrimmed words keep their original casing.
 *
 * This is the single source of truth for the family-wide convention (Go,
 * Kotlin, Swift, .NET). `mountName` must already be canonicalized to the
 * language's PascalCase class/type name so word boundaries match the method.
 */
export function trimMountedResourceFromMethod(method: string, mountName: string): string {
  const methodWords = splitPascalWords(method);
  if (methodWords.length < 2) return method;

  const mountWords = splitPascalWords(mountName);
  if (mountWords.length === 0) return method;

  let matched = 0;
  while (
    matched < mountWords.length &&
    matched + 1 < methodWords.length &&
    mountWordsMatch(methodWords[matched + 1], mountWords[matched])
  ) {
    matched++;
  }

  if (matched === 0) return method;

  return [methodWords[0], ...methodWords.slice(matched + 1)].join('');
}

/**
 * Build the GoDoc prefix for a field comment.
 * If the description already starts with a verb (e.g., "Distinguishes...", "Indicates..."),
 * returns just the lowered description. Otherwise prepends "is ".
 *
 *   fieldDocComment("ID", "the unique identifier")   → "ID is the unique identifier"
 *   fieldDocComment("Object", "Distinguishes the X")  → "Object distinguishes the X"
 */
export function fieldDocComment(fieldName: string, description: string): string {
  const lowered = lowerFirstForDoc(description);
  if (startsWithVerb(lowered)) {
    return `${fieldName} ${lowered}`;
  }
  return `${fieldName} is ${lowered}`;
}

/** Known English 3rd-person-singular verbs that appear as OpenAPI description starters. */
const VERB_STARTERS = new Set([
  'distinguishes',
  'indicates',
  'represents',
  'contains',
  'specifies',
  'determines',
  'controls',
  'defines',
  'identifies',
  'describes',
  'returns',
  'creates',
  'deletes',
  'updates',
  'lists',
  'provides',
  'enables',
  'disables',
  'allows',
  'prevents',
  'triggers',
  'marks',
  'tracks',
  'stores',
  'holds',
  'maps',
  'links',
  'connects',
  'wraps',
  'denotes',
  'shows',
  'tells',
  'gives',
  'takes',
  'sets',
  'gets',
  'configures',
  'manages',
  'validates',
  'authenticates',
  'authorizes',
  'verifies',
  'limits',
  'restricts',
  'overrides',
  'applies',
]);

function startsWithVerb(desc: string): boolean {
  const firstWord = desc
    .split(/\s/)[0]
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  return VERB_STARTERS.has(firstWord);
}

/**
 * Words beginning with a vowel letter but a consonant /j/ or /w/ sound —
 * take "a", not "an".
 */
const CONSONANT_SOUND_INITIAL_VOWEL = new Set([
  'user',
  'unit',
  'unique',
  'united',
  'universal',
  'university',
  'european',
  'one',
  'once',
  'useful',
  'used',
  'usable',
  'ubiquitous',
]);

/**
 * Words beginning with a consonant letter but a vowel sound (silent h) —
 * take "an", not "a".
 */
const VOWEL_SOUND_INITIAL_CONSONANT = new Set(['hour', 'honest', 'honor', 'honorable', 'heir']);

/**
 * Select the correct indefinite article ("a" or "an") for a word.
 *
 * Matches English phonetics, not orthography: "a user" (consonant /j/ sound
 * despite leading 'u'), "an hour" (vowel sound despite leading 'h'). Falls
 * back to a vowel-letter regex for words not in either exception set.
 */
export function articleFor(word: string): string {
  const firstWord = word
    .split(/\s+/)[0]
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  if (CONSONANT_SOUND_INITIAL_VOWEL.has(firstWord)) return 'a';
  if (VOWEL_SOUND_INITIAL_CONSONANT.has(firstWord)) return 'an';
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

/**
 * Lowercase the first character of a string for doc comments/descriptions.
 * Handles acronyms: "SSO-specific" becomes "sso-specific" not "sSO-specific".
 * "JSONSchema" becomes "jsonSchema", "IP Address" becomes "ip Address".
 */
export function lowerFirstForDoc(s: string): string {
  if (!s) return s;
  const acronymMatch = s.match(/^[A-Z]{2,}/);
  if (acronymMatch) {
    const acronym = acronymMatch[0];
    const nextChar = s[acronym.length];
    // If followed by a lowercase letter (e.g. "SSOAuth"), keep the last
    // uppercase char as the start of the next camelCase word.
    if (nextChar && /[a-z]/.test(nextChar)) {
      return acronym.slice(0, -1).toLowerCase() + acronym.slice(-1) + s.slice(acronym.length);
    }
    return acronym.toLowerCase() + s.slice(acronym.length);
  }
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/**
 * Suffix `base` until it no longer collides with a reserved type name.
 *
 * Parameter-group type names are derived from the mount and group names, so in
 * languages that prefix the mount they can land on a name a model already owns:
 * mount `AuditLogs` + group `retention` yields `AuditLogsRetention`, which is
 * also the type generated for the `AuditLogsRetention` schema. Where models and
 * group types share one namespace that is a redeclaration error rather than a
 * shadow, so the group types have to step aside.
 *
 * `Group` reads naturally for parameter-group types; the numeric fallback only
 * matters if a schema is literally named `<Mount><Group>Group`. Every emitter
 * that guards its group names uses this, so a group renamed in one language is
 * renamed the same way in the others.
 */
export function avoidReservedTypeName(base: string, reserved: Set<string>): string {
  if (!reserved.has(base)) return base;
  let candidate = `${base}Group`;
  let suffix = 2;
  while (reserved.has(candidate)) candidate = `${base}Group${suffix++}`;
  return candidate;
}
