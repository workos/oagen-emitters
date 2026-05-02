import { parsePathTemplate, hasPathParams, type PathSegment } from '../shared/path-template.js';
import { fieldName } from './naming.js';

/**
 * Build the TypeScript expression that the SDK passes as the request path.
 *
 * Every {paramName} placeholder becomes `${encodeURIComponent(name)}` inside a
 * template literal. encodeURIComponent is used (not encodeURI) because we want
 * "/" to be encoded too — otherwise a caller-supplied id containing "../" can
 * be normalized by the underlying HTTP transport (libcurl, fetch, etc.) into
 * a different endpoint of the WorkOS API while still authenticated with the
 * application's API key.
 *
 *   "/orgs"            → `'orgs'`
 *   "/orgs/{id}"       → `` `orgs/${encodeURIComponent(id)}` ``
 *   "/orgs/{id}/foo"   → `` `orgs/${encodeURIComponent(id)}/foo` ``
 */
export function buildNodePathExpression(rawPath: string): string {
  const segments = parsePathTemplate(rawPath);
  if (!hasPathParams(segments)) {
    return `'${rawPath}'`;
  }

  let body = '';
  for (const seg of segments) {
    body += renderSegment(seg);
  }
  return `\`${body}\``;
}

function renderSegment(seg: PathSegment): string {
  if (seg.kind === 'literal') {
    // Template-literal-safe escapes: backtick, backslash, ${
    return seg.value.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  }
  return `\${encodeURIComponent(${fieldName(seg.name)})}`;
}
