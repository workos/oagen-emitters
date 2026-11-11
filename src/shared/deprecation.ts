/**
 * Distill a deprecation message from a spec description. Looks for common
 * WorkOS patterns ("Deprecated. Use X.", "Use X instead.", etc.) and falls
 * back to a generic message scoped to the item kind.
 *
 * Output is a single line suitable for inlining into a language attribute
 * (`[System.Obsolete("...")]`, `#[deprecated(note = "...")]`).
 */
export function deprecationMessage(
  description: string | undefined | null,
  kind: 'field' | 'parameter' | 'operation' | 'value',
): string {
  const generic = `This ${kind} is deprecated.`;
  if (!description) return generic;

  const text = description.replace(/\s+/g, ' ').trim();
  if (!text) return generic;

  // Match: "Deprecated. Use `foo` instead." / "Deprecated: use Foo." — the
  // clause runs to the end of the sentence, where a period inside backticks
  // or inside a token (`https://api.workos.com/v2`, `v1.2`) does not end it.
  const deprecatedClause = text.match(/Deprecated[.:]\s*((?:`[^`]*`|\.(?!\s|$)|[^.])*)/i);
  if (deprecatedClause?.[1]?.trim()) {
    return `Deprecated. ${deprecatedClause[1].trim()}.`;
  }

  // Match: "Use `foo` instead." anywhere in the description
  const useInstead = text.match(/Use\s+(`[^`]+`|[^`.\s]+)\s+instead/i);
  if (useInstead) {
    return `${generic} Use \`${useInstead[1].replace(/^`|`$/g, '')}\` instead.`;
  }

  return generic;
}
