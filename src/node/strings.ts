/** Render a single-quoted TypeScript string without changing its runtime value. */
export function tsStringLiteral(value: string): string {
  const escaped = value.replace(/['\\\x00-\x1f\u2028\u2029]/g, (char) =>
    char === "'"
      ? "\\'"
      : JSON.stringify(char)
          .slice(1, -1)
          .replace(/\u2028/g, '\\u2028')
          .replace(/\u2029/g, '\\u2029'),
  );
  return `'${escaped}'`;
}

/** Preserve ordinary property spelling and quote names that contain source syntax. */
export function tsPropertyName(value: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(value) ? value : tsStringLiteral(value);
}

export function tsPropertyAccess(value: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(value) ? `.${value}` : `[${tsStringLiteral(value)}]`;
}
