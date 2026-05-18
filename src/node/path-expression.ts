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
 *
 * `paramNameMap` lets a caller override the local variable name used for a
 * spec parameter — used by the options-object code path so the URL template
 * references the SDK's public field name (e.g. `organizationMembershipId`)
 * instead of the spec's path-param name (e.g. `omId`), avoiding a
 * destructure rename in the method body.
 */
export function buildNodePathExpression(rawPath: string, paramNameMap?: Map<string, string>): string {
  const segments = parsePathTemplate(rawPath);
  if (!hasPathParams(segments)) {
    return `'${rawPath}'`;
  }

  let body = '';
  for (const seg of segments) {
    body += renderSegment(seg, paramNameMap);
  }
  return `\`${body}\``;
}

function renderSegment(seg: PathSegment, paramNameMap?: Map<string, string>): string {
  if (seg.kind === 'literal') {
    // Template-literal-safe escapes: backtick, backslash, ${
    return seg.value.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  }
  const localName = paramNameMap?.get(seg.name) ?? fieldName(seg.name);
  return `\${encodeURIComponent(${localName})}`;
}
