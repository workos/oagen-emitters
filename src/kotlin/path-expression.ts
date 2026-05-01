import { parsePathTemplate, hasPathParams } from '../shared/path-template.js';
import { ktLiteral, propertyName } from './naming.js';

/**
 * The fully-qualified runtime helper that the generated code calls. Kotlin
 * doesn't ship a path-segment URL encoder out of the box (java.net.URLEncoder
 * is form-encoding — it encodes space as "+", which is wrong for path
 * segments). The runtime helper lives in workos-kotlin at
 * com.workos.common.http.encodePathSegment.
 */
export const KOTLIN_PATH_ENCODE_IMPORT = 'com.workos.common.http.encodePathSegment';

export interface KotlinPathExpression {
  /** The Kotlin expression to splice in as the `path = ...` argument. */
  expression: string;
  /** Whether the caller must add `KOTLIN_PATH_ENCODE_IMPORT` to its import set. */
  requiresEncodeImport: boolean;
}

/**
 * Build the Kotlin string-template that the SDK passes as the request path.
 *
 * Every {paramName} placeholder is wrapped in `encodePathSegment(...)` so a
 * caller-supplied id containing "../" cannot be normalized by the underlying
 * HTTP transport into a different endpoint of the WorkOS API while still
 * authenticated with the application's API key.
 *
 *   "/orgs"            → `"orgs"`
 *   "/orgs/{id}"       → `"orgs/${encodePathSegment(id)}"`
 *   "/orgs/{id}/foo"   → `"orgs/${encodePathSegment(id)}/foo"`
 */
export function buildKotlinPathExpression(rawPath: string): KotlinPathExpression {
  const segments = parsePathTemplate(rawPath);
  if (!hasPathParams(segments)) {
    return { expression: ktLiteral(rawPath), requiresEncodeImport: false };
  }

  let body = '';
  for (const seg of segments) {
    if (seg.kind === 'literal') {
      body += escapeKotlinStringLiteral(seg.value);
    } else {
      body += `\${encodePathSegment(${propertyName(seg.name)})}`;
    }
  }
  return { expression: `"${body}"`, requiresEncodeImport: true };
}

function escapeKotlinStringLiteral(literal: string): string {
  return literal.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$');
}
