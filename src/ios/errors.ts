import type { EmitterContext, GeneratedFile } from '@workos/oagen';
import { toCamelCase } from '@workos/oagen';
import { moduleName, errorTypeName } from './naming.js';

/**
 * Generate the SDK error hierarchy from `ctx.spec.sdk.errors`.
 *
 * Emits `Errors/{Namespace}Error.swift` containing:
 *  - `APIError` — the structured error payload (status, message, code, requestID).
 *  - `{Namespace}Error` — an enum with one case per `ErrorPolicy.statusCodeMap`
 *    kind, plus server/api/network/decoding/invalidResponse cases.
 *  - a `from(statusCode:apiError:)` factory that maps HTTP status → case, used
 *    by the transport.
 */
export function generateErrors(ctx: EmitterContext): GeneratedFile[] {
  const module = moduleName(ctx);
  const errorName = errorTypeName(ctx);
  const policy = ctx.spec.sdk.errors;

  // Distinct status -> kind entries, sorted by status.
  const entries = Object.entries(policy.statusCodeMap)
    .map(([code, kind]) => ({ code: Number(code), kind, caseName: toCamelCase(kind) }))
    .sort((a, b) => a.code - b.code);

  const serverCase = toCamelCase(policy.serverErrorKind || 'Server');
  const apiCase = toCamelCase(policy.clientErrorKind || 'Api');

  // Unique case names (statusCodeMap may map several codes to one kind), keeping
  // server/api reserved for the catch-alls.
  const caseDocs = new Map<string, string>();
  for (const e of entries) {
    if (!caseDocs.has(e.caseName)) caseDocs.set(e.caseName, `${e.code} — ${e.kind} error.`);
  }
  caseDocs.delete(serverCase);
  caseDocs.delete(apiCase);

  const lines: string[] = [];
  lines.push('import Foundation');
  lines.push('');
  lines.push('/// The structured error payload returned by the API on a non-2xx response.');
  lines.push('public struct APIError: Error, Sendable, Equatable {');
  lines.push('    /// The HTTP status code of the response.');
  lines.push('    public let statusCode: Int');
  lines.push('    /// A human-readable error message.');
  lines.push('    public let message: String');
  lines.push('    /// A machine-readable error code, when provided.');
  lines.push('    public let code: String?');
  lines.push('    /// The request identifier, useful when contacting support.');
  lines.push('    public let requestID: String?');
  lines.push('    /// The raw decoded error body, when available.');
  lines.push('    public let raw: AnyCodable?');
  lines.push('');
  lines.push(
    '    public init(statusCode: Int, message: String, code: String? = nil, requestID: String? = nil, raw: AnyCodable? = nil) {',
  );
  lines.push('        self.statusCode = statusCode');
  lines.push('        self.message = message');
  lines.push('        self.code = code');
  lines.push('        self.requestID = requestID');
  lines.push('        self.raw = raw');
  lines.push('    }');
  lines.push('}');
  lines.push('');
  lines.push(`/// The error type thrown by ${module} SDK operations.`);
  lines.push(`public enum ${errorName}: Error, Sendable {`);
  for (const [caseName, doc] of caseDocs) {
    lines.push(`    /// ${doc}`);
    lines.push(`    case ${caseName}(APIError)`);
  }
  lines.push('    /// A 5xx server error.');
  lines.push(`    case ${serverCase}(APIError)`);
  lines.push('    /// A non-2xx response that did not match a known status.');
  lines.push(`    case ${apiCase}(APIError)`);
  lines.push('    /// A transport-level networking failure.');
  lines.push('    case network(URLError)');
  lines.push('    /// The response body could not be decoded into the expected type.');
  lines.push('    case decoding(any Error)');
  lines.push('    /// The response was not a valid HTTP response.');
  lines.push('    case invalidResponse');
  lines.push('');
  lines.push('    /// Map an HTTP status code and decoded payload to the appropriate case.');
  lines.push(`    public static func from(statusCode: Int, apiError: APIError) -> ${errorName} {`);
  lines.push('        switch statusCode {');
  for (const e of entries) {
    lines.push(`        case ${e.code}: return .${e.caseName}(apiError)`);
  }
  lines.push(`        case 500...599: return .${serverCase}(apiError)`);
  lines.push(`        default: return .${apiCase}(apiError)`);
  lines.push('        }');
  lines.push('    }');
  lines.push('}');

  return [
    {
      path: `Sources/${module}/Errors/${errorName}.swift`,
      content: lines.join('\n'),
    },
  ];
}
