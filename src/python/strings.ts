/** Render spec data as an ordinary Python string, never an f-string. */
export function pythonStringLiteral(value: string): string {
  return JSON.stringify(value);
}

/** Escape triple-quoted docstring content while retaining readable line breaks. */
export function pythonDocstring(value: string): string {
  return value.replace(/[\\"\x00-\x1f\x7f]/g, (char) => (char === '\n' ? char : JSON.stringify(char).slice(1, -1)));
}
