import { parsePathTemplate, hasPathParams } from '../shared/path-template.js';
import { fieldName } from './naming.js';

export interface PhpPathOptions {
  /**
   * Raw OpenAPI param names whose runtime value is enum- or model-valued and
   * therefore needs `->value` accessed before encoding. Mirrors the legacy
   * resources.ts behavior that treated `kind === 'enum'` and `kind === 'model'`
   * the same way.
   */
  valueAccessorParams?: ReadonlySet<string>;
}

/**
 * Build the PHP expression that the SDK passes to HttpClient as `path:`.
 *
 * Concatenation, not interpolation: PHP does not allow function calls inside
 * "..." strings, and every parameter must be wrapped in `rawurlencode(...)` so
 * that an unencoded "../" in a caller-supplied id cannot be normalized by
 * libcurl into a different endpoint of the WorkOS API while still
 * authenticated with the application's API key.
 *
 *   "/orgs"            → `'orgs'`
 *   "/orgs/{id}"       → `'orgs/' . rawurlencode($id)`
 *   "/orgs/{id}/users" → `'orgs/' . rawurlencode($id) . '/users'`
 *   "/orgs/{id}" with id ∈ valueAccessorParams → `'orgs/' . rawurlencode($id->value)`
 */
export function buildPhpPathExpression(rawPath: string, options: PhpPathOptions = {}): string {
  const segments = parsePathTemplate(rawPath, { stripLeadingSlash: true });
  if (segments.length === 0) return "''";

  if (!hasPathParams(segments)) {
    return phpSingleQuoted((segments[0] as { value: string }).value);
  }

  const valueAccessor = options.valueAccessorParams;
  const parts: string[] = [];
  for (const seg of segments) {
    if (seg.kind === 'literal') {
      parts.push(phpSingleQuoted(seg.value));
    } else {
      const varName = fieldName(seg.name);
      const accessor = valueAccessor?.has(seg.name) ? `$${varName}->value` : `$${varName}`;
      parts.push(`rawurlencode(${accessor})`);
    }
  }
  return parts.join(' . ');
}

function phpSingleQuoted(literal: string): string {
  return `'${literal.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
