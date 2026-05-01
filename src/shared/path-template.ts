/**
 * Helpers for parsing OpenAPI path templates into structured segments that
 * each language emitter can render with proper per-segment URL encoding.
 *
 * SECURITY CONTEXT: every emitted path-parameter interpolation must wrap the
 * runtime value in a URL-encoding call (e.g. `rawurlencode` in PHP,
 * `encodeURIComponent` in TypeScript, `urllib.parse.quote(..., safe="")` in
 * Python, a path-segment helper in Kotlin). Without per-segment encoding, a
 * caller-supplied id containing "../" is silently normalized by libcurl
 * (RFC 3986 dot-segment removal) before transmission, so the request reaches a
 * different endpoint of the WorkOS API while still authenticated with the
 * application's bearer token — i.e. forged cross-resource API requests under
 * the application's API key. See workos-php HttpClient hardening for the
 * defense-in-depth runtime guard; this module is the structural fix.
 */

export type PathSegment = { kind: 'literal'; value: string } | { kind: 'param'; name: string };

export interface ParsePathOptions {
  /** When true, drop a single leading "/" before parsing. */
  stripLeadingSlash?: boolean;
}

/**
 * Parse an OpenAPI path template into an ordered list of literal and
 * parameter segments. Adjacent literals are coalesced into a single segment
 * (the only way two literals can be adjacent is if the input had `{}{}`
 * which is malformed; we still handle it deterministically).
 *
 * Examples:
 *   "/orgs/{id}/users/{uid}" → [
 *     { kind: 'literal', value: '/orgs/' },
 *     { kind: 'param',   name:  'id' },
 *     { kind: 'literal', value: '/users/' },
 *     { kind: 'param',   name:  'uid' },
 *   ]
 *   "/health"               → [{ kind: 'literal', value: '/health' }]
 *   ""                      → []
 */
export function parsePathTemplate(path: string, options: ParsePathOptions = {}): PathSegment[] {
  const normalized = options.stripLeadingSlash && path.startsWith('/') ? path.slice(1) : path;
  if (normalized === '') return [];

  const segments: PathSegment[] = [];
  const re = /\{([^{}]+)\}/g;
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(normalized)) !== null) {
    if (m.index > cursor) {
      segments.push({ kind: 'literal', value: normalized.slice(cursor, m.index) });
    }
    segments.push({ kind: 'param', name: m[1] });
    cursor = m.index + m[0].length;
  }
  if (cursor < normalized.length) {
    segments.push({ kind: 'literal', value: normalized.slice(cursor) });
  }
  return segments;
}

/** True when at least one segment is a parameter placeholder. */
export function hasPathParams(segments: PathSegment[]): boolean {
  return segments.some((s) => s.kind === 'param');
}
