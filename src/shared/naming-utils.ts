/** Strip URN OAuth grant-type prefixes from discriminator-derived schema names. */
export function stripUrnPrefix(name: string): string {
  // Handles both OAuth and Oauth casing from different PascalCase implementations
  return name.replace(/^Urn(?:IetfParams|Workos)O[Aa]uthGrantType/, '');
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
 * Select the correct indefinite article ("a" or "an") for a word.
 */
export function articleFor(word: string): string {
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
