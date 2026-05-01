import { parsePathTemplate, hasPathParams } from '../shared/path-template.js';
import { fieldName } from './naming.js';

export interface PythonPathOptions {
  /** Raw OpenAPI param names whose runtime value is enum-typed. */
  enumParams?: ReadonlySet<string>;
}

/**
 * Build the Python f-string that the SDK passes to the request layer.
 *
 * Every {paramName} placeholder is wrapped in
 * `urllib.parse.quote(str(...), safe="")` so that an unencoded "/" or "../"
 * in a caller-supplied id cannot be normalized by the underlying HTTP
 * transport into a different endpoint of the WorkOS API while still
 * authenticated with the application's API key. `safe=""` is critical:
 * the stdlib default of `safe="/"` does NOT encode "/" and would leave the
 * traversal vector open.
 *
 * Generated files using this helper must import `quote` (e.g.
 * `from urllib.parse import quote`).
 *
 *   "/orgs"                        → `"orgs"`
 *   "/orgs/{id}"                   → `f"orgs/{quote(str(id), safe='')}"`
 *   "/orgs/{id}" with id ∈ enums   → `f"orgs/{quote(str(enum_value(id)), safe='')}"`
 */
export function buildPythonPathExpression(rawPath: string, options: PythonPathOptions = {}): string {
  const segments = parsePathTemplate(rawPath, { stripLeadingSlash: true });
  if (segments.length === 0) return '""';
  if (!hasPathParams(segments)) {
    const literal = (segments[0] as { value: string }).value;
    return `"${escapePyDoubleQuoted(literal)}"`;
  }

  const enums = options.enumParams;
  let body = '';
  for (const seg of segments) {
    if (seg.kind === 'literal') {
      body += escapePyDoubleQuoted(seg.value);
    } else {
      const varName = fieldName(seg.name);
      const inner = enums?.has(seg.name) ? `enum_value(${varName})` : varName;
      body += `{quote(str(${inner}), safe='')}`;
    }
  }
  return `f"${body}"`;
}

function escapePyDoubleQuoted(literal: string): string {
  // f-strings: backslash, double-quote, and "{"/"}" all need escaping
  return literal.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\{/g, '{{').replace(/\}/g, '}}');
}
