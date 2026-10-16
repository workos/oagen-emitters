/**
 * Emulations of the snake_case naming algorithms used by the two JSON
 * serializers the generated .NET SDK supports:
 *
 * - Newtonsoft.Json `SnakeCaseNamingStrategy` (`StringUtils.ToSnakeCase`),
 *   which the SDK's hand-maintained `RequestUtilities` installs globally.
 * - System.Text.Json `JsonNamingPolicy.SnakeCaseLower`
 *   (`JsonSeparatorNamingPolicy`), which STJ consumers configure themselves.
 *
 * Both policies derive the wire key from the C# property name at runtime, so
 * a property only maps correctly when that derivation lands on the spec's
 * wire key. Acronym-cased names break this: `OAuthTokens` becomes
 * `o_auth_tokens`, not `oauth_tokens`, and the field silently deserializes
 * as null. The emitter runs these ports at generation time to decide when a
 * property needs an explicit `[JsonProperty]` / `[JsonPropertyName]` pin.
 *
 * Only ASCII identifiers are handled; C# property names emitted by this
 * generator never contain anything else.
 */

const isUpper = (c: string): boolean => c >= 'A' && c <= 'Z';
const isLower = (c: string): boolean => c >= 'a' && c <= 'z';
const isDigit = (c: string): boolean => c >= '0' && c <= '9';

/** Port of Newtonsoft.Json's `StringUtils.ToSnakeCase` (Json.NET 13). */
export function newtonsoftSnakeCase(name: string): string {
  type State = 'start' | 'lower' | 'upper' | 'newWord';
  let state: State = 'start';
  let out = '';
  for (let i = 0; i < name.length; i++) {
    const c = name[i];
    if (c === ' ') {
      if (state !== 'start') state = 'newWord';
    } else if (isUpper(c)) {
      if (state === 'upper') {
        const hasNext = i + 1 < name.length;
        if (i > 0 && hasNext) {
          const next = name[i + 1];
          if (!isUpper(next) && next !== '_') out += '_';
        }
      } else if (state === 'lower' || state === 'newWord') {
        out += '_';
      }
      out += c.toLowerCase();
      state = 'upper';
    } else if (c === '_') {
      out += '_';
      state = 'start';
    } else {
      if (state === 'newWord') out += '_';
      out += c;
      state = 'lower';
    }
  }
  return out;
}

/**
 * Port of System.Text.Json's `JsonNamingPolicy.SnakeCaseLower`
 * (`JsonSeparatorNamingPolicy.ConvertNameCore`, .NET 8+).
 */
export function stjSnakeCaseLower(name: string): string {
  type State = 'notStarted' | 'lowerOrDigit' | 'upper' | 'space';
  let state: State = 'notStarted';
  let out = '';
  for (let i = 0; i < name.length; i++) {
    const c = name[i];
    if (isUpper(c)) {
      if (state === 'lowerOrDigit' || state === 'space') {
        out += '_';
      } else if (state === 'upper') {
        if (i + 1 < name.length && isLower(name[i + 1])) out += '_';
      }
      out += c.toLowerCase();
      state = 'upper';
    } else if (isLower(c) || isDigit(c)) {
      if (state === 'space') out += '_';
      out += c;
      state = 'lowerOrDigit';
    } else if (c === ' ') {
      if (state !== 'notStarted') state = 'space';
    } else {
      out += c;
      state = 'notStarted';
    }
  }
  return out;
}

/**
 * True when both serializers' snake_case policies map `csName` back to
 * exactly `wireName`, i.e. convention-based naming is sufficient and no
 * explicit wire-name attribute is required.
 */
export function wireNameRoundTrips(csName: string, wireName: string): boolean {
  return newtonsoftSnakeCase(csName) === wireName && stjSnakeCaseLower(csName) === wireName;
}
