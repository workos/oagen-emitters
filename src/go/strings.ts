/** Render an interpreted Go string literal, including control characters. */
export function goStringLiteral(value: string): string {
  return JSON.stringify(value);
}

/** Quote tag values separately from the source literal that contains the tags. */
export function goStructTag(tags: Record<string, string>): string {
  const content = Object.entries(tags)
    .map(([key, value]) => `${key}:${goStringLiteral(value)}`)
    .join(' ');
  // Preserve idiomatic raw tags where possible; backticks require an
  // interpreted literal with a second layer of escaping.
  return content.includes('`') ? goStringLiteral(content) : `\`${content}\``;
}
