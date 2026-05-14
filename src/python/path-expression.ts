import { parsePathTemplate, type PathSegment } from '../shared/path-template.js';
import { fieldName } from './naming.js';

export interface PythonPathOptions {
  /** Raw OpenAPI param names whose runtime value is enum-typed. */
  enumParams?: ReadonlySet<string>;
}

/**
 * Build the Python tuple expression that the SDK passes to the request layer.
 *
 * The returned expression is a tuple of per-segment values. The request layer
 * (`_BaseWorkOSClient._encode_path`) URL-encodes each element with `safe=""`
 * before joining with "/", so a caller-supplied id containing "/" or "../"
 * cannot escape its intended segment. This is the structural fix that lets
 * the request layer make a real guarantee instead of inspecting an already-
 * concatenated path string.
 *
 *   "/orgs"                        → `("orgs",)`
 *   "/orgs/{id}"                   → `("orgs", str(id))`
 *   "/orgs/{id}/users/{uid}"       → `("orgs", str(id), "users", str(uid))`
 *   "/orgs/{id}" with id ∈ enums   → `("orgs", str(enum_value(id)))`
 *
 * Mixed segments (e.g. literal text adjacent to a placeholder within a single
 * path component) are emitted as a Python f-string element. Per-segment
 * encoding is still applied to the whole element by the request layer; this
 * is rare in WorkOS specs but is handled deterministically.
 */
export function buildPythonPathExpression(rawPath: string, options: PythonPathOptions = {}): string {
  const segments = parsePathTemplate(rawPath, { stripLeadingSlash: true });
  if (segments.length === 0) return '()';

  const components = splitIntoComponents(segments);
  const parts = components.map((c) => emitComponent(c, options.enumParams));
  return parts.length === 1 ? `(${parts[0]!},)` : `(${parts.join(', ')})`;
}

type Subpiece = { kind: 'literal'; value: string } | { kind: 'param'; name: string };

/**
 * Split a parsed path template into one component per "/"-separated piece.
 * Each component is a list of literal / param subpieces; multi-subpiece
 * components occur only for mixed segments like `foo{id}bar`.
 */
function splitIntoComponents(segments: PathSegment[]): Subpiece[][] {
  const components: Subpiece[][] = [[]];
  for (const seg of segments) {
    if (seg.kind === 'literal') {
      const parts = seg.value.split('/');
      const first = parts[0];
      if (first !== undefined && first !== '') {
        components[components.length - 1]!.push({ kind: 'literal', value: first });
      }
      for (let i = 1; i < parts.length; i++) {
        components.push([]);
        const part = parts[i];
        if (part !== undefined && part !== '') {
          components[components.length - 1]!.push({ kind: 'literal', value: part });
        }
      }
    } else {
      components[components.length - 1]!.push({ kind: 'param', name: seg.name });
    }
  }
  // Drop a trailing empty component if the path ended with a separator.
  while (components.length > 1 && components[components.length - 1]!.length === 0) {
    components.pop();
  }
  return components;
}

function emitComponent(component: Subpiece[], enumParams?: ReadonlySet<string>): string {
  if (component.length === 1) {
    const only = component[0]!;
    if (only.kind === 'literal') return `"${escapePyDoubleQuoted(only.value)}"`;
    const varName = fieldName(only.name);
    const inner = enumParams?.has(only.name) ? `enum_value(${varName})` : varName;
    return `str(${inner})`;
  }
  // Mixed component — fall back to an f-string. The request layer still
  // URL-encodes the resulting element as a single segment.
  let body = '';
  for (const piece of component) {
    if (piece.kind === 'literal') {
      body += escapeFStringLiteral(piece.value);
    } else {
      const varName = fieldName(piece.name);
      const inner = enumParams?.has(piece.name) ? `enum_value(${varName})` : varName;
      body += `{${inner}}`;
    }
  }
  return `f"${body}"`;
}

function escapePyDoubleQuoted(literal: string): string {
  return literal.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapeFStringLiteral(literal: string): string {
  return literal.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\{/g, '{{').replace(/\}/g, '}}');
}
