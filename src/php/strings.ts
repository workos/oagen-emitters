/** PHP single-quoted strings only interpret escaped quotes and backslashes. */
export function phpStringLiteral(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
