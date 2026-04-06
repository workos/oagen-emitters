/**
 * Render a PHPDoc comment block from a description string.
 * Handles multiline descriptions by prefixing each line with ` * `.
 * Returns the lines with the given indent (default 0 spaces).
 */
export function phpDocComment(description: string, indent = 0): string[] {
  const pad = ' '.repeat(indent);
  const descLines = description.split('\n');
  if (descLines.length === 1) {
    return [`${pad}/** ${descLines[0]} */`];
  }
  const lines: string[] = [`${pad}/**`];
  for (const line of descLines) {
    lines.push(line === '' ? `${pad} *` : `${pad} * ${line}`);
  }
  lines.push(`${pad} */`);
  return lines;
}
