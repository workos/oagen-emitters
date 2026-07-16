import type { ApiSpec, EmitterContext, GeneratedFile } from '@workos/oagen';
import { groupByMount } from '../shared/resolved-ops.js';
import { generateStaticRuntime } from './runtime.js';
import { generateSmokePlan } from './smoke-plan.js';
import {
  moduleName,
  clientClassName,
  errorTypeName,
  resourceTypeName,
  accessorName,
  withResolvedOps,
  swiftStringLiteral,
} from './naming.js';

/**
 * Generate the client entry point plus the full generated runtime: the
 * `{Namespace}Client` class, `Configuration`, `Transport`, and the static
 * support files. Everything is emitted with `overwriteExisting` so the
 * generated surface is fully generator-owned (Go pattern). Repo resources
 * (`Package.swift`, `.swift-format`, `script/ci`, `.gitignore`) are
 * hand-maintained in the SDK repo and never generated.
 */
export function generateClient(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const module = moduleName(ctx);
  const files: GeneratedFile[] = [
    {
      path: `Sources/${module}/${clientClassName(ctx)}.swift`,
      content: renderClientClass(ctx),
      overwriteExisting: true,
    },
    { path: `Sources/${module}/Configuration.swift`, content: renderConfiguration(ctx), overwriteExisting: true },
    { path: `Sources/${module}/Internal/Transport.swift`, content: renderTransport(ctx), overwriteExisting: true },
    ...generateStaticRuntime(module).map((f) => ({ ...f, overwriteExisting: true })),
    generateSmokePlan(ctx),
  ];
  return files;
}

/** Format a number as a Swift `Double` literal (always with a decimal point). */
function swiftDouble(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : String(n);
}

/** The default base URL from the spec, falling back to a placeholder. */
function baseUrlLiteral(spec: ApiSpec): string {
  const url = spec.baseUrl || spec.servers?.[0]?.url || 'https://api.example.com';
  return swiftStringLiteral(url);
}

/** Build the User-Agent string from the SdkBehavior template. */
function userAgentLiteral(ctx: EmitterContext): string {
  const template = ctx.spec.sdk.userAgent.sdkIdentifierTemplate || '{name} {lang}/{version}';
  const ua = template
    .split('{name}')
    .join(ctx.spec.name || ctx.namespacePascal)
    .split('{lang}')
    .join('swift')
    .split('{version}')
    .join(ctx.spec.version || '0.0.0');
  return swiftStringLiteral(ua);
}

function authLine(ctx: EmitterContext): string {
  const auth = ctx.spec.auth?.[0];
  if (auth?.kind === 'apiKey' && auth.in === 'header') {
    return `        request.setValue(configuration.apiKey, forHTTPHeaderField: ${swiftStringLiteral(auth.name)})`;
  }
  return '        request.setValue("Bearer \\(configuration.apiKey)", forHTTPHeaderField: "Authorization")';
}

function idempotencyBlock(ctx: EmitterContext): string {
  const header = swiftStringLiteral(ctx.spec.sdk.idempotency.headerName);
  if (ctx.spec.sdk.idempotency.autoGenerateForPost) {
    return [
      '        if method == "POST" {',
      `            request.setValue(options?.idempotencyKey ?? UUID().uuidString, forHTTPHeaderField: ${header})`,
      '        }',
    ].join('\n');
  }
  return [
    '        if let idempotencyKey = options?.idempotencyKey {',
    `            request.setValue(idempotencyKey, forHTTPHeaderField: ${header})`,
    '        }',
  ].join('\n');
}

function renderClientClass(ctx: EmitterContext): string {
  const module = moduleName(ctx);
  const clientName = clientClassName(ctx);
  const groups = [...groupByMount(withResolvedOps(ctx)).values()].sort((a, b) => a.name.localeCompare(b.name));

  const lines: string[] = [];
  lines.push('import Foundation');
  lines.push('');
  lines.push(`/// The ${module} API client.`);
  lines.push('///');
  lines.push('/// ```swift');
  lines.push(`/// let client = ${clientName}(apiKey: "sk_...")`);
  lines.push('/// ```');
  lines.push(`public final class ${clientName}: Sendable {`);
  lines.push('    /// The configuration this client was created with.');
  lines.push('    public let configuration: Configuration');
  lines.push('    let transport: Transport');
  lines.push('');
  lines.push('    init(configuration: Configuration, transport: Transport) {');
  lines.push('        self.configuration = configuration');
  lines.push('        self.transport = transport');
  lines.push('    }');
  lines.push('');
  lines.push('    /// Create a client from a full configuration.');
  lines.push('    public convenience init(configuration: Configuration) {');
  lines.push('        self.init(configuration: configuration, transport: Transport(configuration: configuration))');
  lines.push('    }');
  lines.push('');
  lines.push('    /// Create a client with an API key and an optional base URL override.');
  lines.push('    public convenience init(apiKey: String, baseURL: URL? = nil) {');
  lines.push('        self.init(configuration: Configuration(apiKey: apiKey, baseURL: baseURL))');
  lines.push('    }');
  for (const group of groups) {
    const resource = resourceTypeName(group.name, ctx);
    const accessor = accessorName(group.name);
    lines.push('');
    lines.push(`    /// Operations for the ${resource} API.`);
    lines.push(`    public var ${accessor}: ${resource} { ${resource}(transport: transport) }`);
  }
  lines.push('}');
  return lines.join('\n');
}

function renderConfiguration(ctx: EmitterContext): string {
  const retry = ctx.spec.sdk.retry;
  const codes = retry.retryableStatusCodes.join(', ');
  const lines: string[] = [];
  lines.push('import Foundation');
  lines.push('');
  lines.push('/// Client configuration: credentials, endpoint, and request-policy defaults.');
  lines.push('public struct Configuration: Sendable {');
  lines.push('    /// The API key sent as a bearer token on every request.');
  lines.push('    public var apiKey: String');
  lines.push('    /// The base URL all request paths are resolved against.');
  lines.push('    public var baseURL: URL');
  lines.push('    /// The default per-request timeout, in seconds.');
  lines.push('    public var timeout: TimeInterval');
  lines.push('    /// The maximum number of retries for retryable failures.');
  lines.push('    public var maxRetries: Int');
  lines.push('    /// HTTP status codes that trigger a retry.');
  lines.push('    public var retryableStatusCodes: Set<Int>');
  lines.push('    /// An optional client identifier used by some operations.');
  lines.push('    public var clientID: String?');
  lines.push('');
  lines.push(`    public static let defaultBaseURL = URL(string: ${baseUrlLiteral(ctx.spec)})!`);
  lines.push('');
  lines.push('    public init(');
  lines.push('        apiKey: String,');
  lines.push('        baseURL: URL? = nil,');
  lines.push(`        timeout: TimeInterval = ${swiftDouble(ctx.spec.sdk.timeout.defaultTimeoutSeconds)},`);
  lines.push(`        maxRetries: Int = ${retry.maxRetries},`);
  lines.push(`        retryableStatusCodes: Set<Int> = [${codes}],`);
  lines.push('        clientID: String? = nil');
  lines.push('    ) {');
  lines.push('        self.apiKey = apiKey');
  lines.push('        self.baseURL = baseURL ?? Configuration.defaultBaseURL');
  lines.push('        self.timeout = timeout');
  lines.push('        self.maxRetries = maxRetries');
  lines.push('        self.retryableStatusCodes = retryableStatusCodes');
  lines.push('        self.clientID = clientID');
  lines.push('    }');
  lines.push('}');
  return lines.join('\n');
}

function renderTransport(ctx: EmitterContext): string {
  const errorName = errorTypeName(ctx);
  const backoff = ctx.spec.sdk.retry.backoff;
  const requestIdHeader = swiftStringLiteral(ctx.spec.sdk.telemetry.requestIdHeader);

  return `import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// The HTTP transport: request assembly, retries with backoff, and error mapping.
public struct Transport: Sendable {
    public let configuration: Configuration
    let session: URLSession

    public init(configuration: Configuration, session: URLSession = .shared) {
        self.configuration = configuration
        self.session = session
    }

    func request<T: Decodable>(
        method: String,
        path: String,
        query: [URLQueryItem],
        body: (any Encodable & Sendable)?,
        options: RequestOptions?,
        as type: T.Type
    ) async throws -> T {
        let data = try await perform(method: method, path: path, query: query, body: body, options: options)
        do {
            return try Coding.makeDecoder().decode(T.self, from: data)
        } catch {
            throw ${errorName}.decoding(error)
        }
    }

    func requestVoid(
        method: String,
        path: String,
        query: [URLQueryItem],
        body: (any Encodable & Sendable)?,
        options: RequestOptions?
    ) async throws {
        _ = try await perform(method: method, path: path, query: query, body: body, options: options)
    }

    private func perform(
        method: String,
        path: String,
        query: [URLQueryItem],
        body: (any Encodable & Sendable)?,
        options: RequestOptions?
    ) async throws -> Data {
        var urlString = configuration.baseURL.absoluteString
        if urlString.hasSuffix("/") { urlString.removeLast() }
        urlString += "/" + path
        guard var components = URLComponents(string: urlString) else {
            throw ${errorName}.invalidResponse
        }
        if !query.isEmpty {
            components.queryItems = (components.queryItems ?? []) + query
        }
        guard let url = components.url else {
            throw ${errorName}.invalidResponse
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(${userAgentLiteral(ctx)}, forHTTPHeaderField: "User-Agent")
${authLine(ctx)}
        request.timeoutInterval = options?.timeout ?? configuration.timeout

        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try Coding.makeEncoder().encode(AnyEncodable(body))
        }

${idempotencyBlock(ctx)}

        if let options {
            for (name, value) in options.additionalHeaders {
                request.setValue(value, forHTTPHeaderField: name)
            }
        }

        var attempt = 0
        while true {
            do {
                let (data, response) = try await session.data(for: request)
                guard let http = response as? HTTPURLResponse else {
                    throw ${errorName}.invalidResponse
                }
                if (200..<300).contains(http.statusCode) {
                    return data
                }
                if configuration.retryableStatusCodes.contains(http.statusCode), attempt < configuration.maxRetries {
                    attempt += 1
                    let delay = backoffNanoseconds(attempt: attempt, retryAfter: http.value(forHTTPHeaderField: "Retry-After"))
                    try await Task.sleep(nanoseconds: delay)
                    continue
                }
                throw makeError(
                    statusCode: http.statusCode,
                    data: data,
                    requestID: http.value(forHTTPHeaderField: ${requestIdHeader})
                )
            } catch let error as URLError {
                if attempt < configuration.maxRetries {
                    attempt += 1
                    let delay = backoffNanoseconds(attempt: attempt, retryAfter: nil)
                    try await Task.sleep(nanoseconds: delay)
                    continue
                }
                throw ${errorName}.network(error)
            }
        }
    }

    private func backoffNanoseconds(attempt: Int, retryAfter: String?) -> UInt64 {
        if let retryAfter, let seconds = Double(retryAfter) {
            return UInt64(max(0, seconds) * 1_000_000_000)
        }
        let base = ${swiftDouble(backoff.initialDelay)} * pow(${swiftDouble(backoff.multiplier)}, Double(attempt - 1))
        let capped = min(base, ${swiftDouble(backoff.maxDelay)})
        let jitter = capped * ${swiftDouble(backoff.jitterFactor)} * Double.random(in: -1...1)
        let delay = max(0, capped + jitter)
        return UInt64(delay * 1_000_000_000)
    }

    private func makeError(statusCode: Int, data: Data, requestID: String?) -> ${errorName} {
        let decoder = Coding.makeDecoder()
        let body = try? decoder.decode(APIErrorBody.self, from: data)
        let raw = try? decoder.decode(AnyCodable.self, from: data)
        let message = body?.message ?? body?.errorDescription ?? body?.error ?? "HTTP \\(statusCode)"
        let apiError = APIError(
            statusCode: statusCode,
            message: message,
            code: body?.code,
            requestID: requestID ?? body?.requestID,
            raw: raw
        )
        return ${errorName}.from(statusCode: statusCode, apiError: apiError)
    }
}

private struct APIErrorBody: Decodable {
    let message: String?
    let error: String?
    let errorDescription: String?
    let code: String?
    let requestID: String?

    enum CodingKeys: String, CodingKey {
        case message
        case error
        case code
        case errorDescription = "error_description"
        case requestID = "request_id"
    }
}
`;
}
