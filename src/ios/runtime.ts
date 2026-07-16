import type { GeneratedFile } from '@workos/oagen';

/**
 * Static runtime support files for the generated Swift SDK. These are the same
 * for every spec (parameterized only by the module directory) and are emitted
 * via `generateClient`. Policy-derived files (Configuration, Transport) live in
 * `client.ts`.
 */
export function generateStaticRuntime(module: string): GeneratedFile[] {
  const prefix = `Sources/${module}/Internal`;
  return [
    { path: `${prefix}/AnyCodable.swift`, content: ANY_CODABLE },
    { path: `${prefix}/RequestBody.swift`, content: REQUEST_BODY },
    { path: `${prefix}/PathEncoding.swift`, content: PATH_ENCODING },
    { path: `${prefix}/Coding.swift`, content: CODING },
    { path: `${prefix}/Pagination.swift`, content: PAGINATION },
    { path: `Sources/${module}/RequestOptions.swift`, content: REQUEST_OPTIONS },
  ];
}

const ANY_CODABLE = `import Foundation

/// A type-erased JSON value used for schema fields whose shape is unknown at
/// generation time (\`unknown\`) and for raw error payloads.
public enum AnyCodable: Codable, Sendable, Equatable {
    case null
    case bool(Bool)
    case int(Int)
    case double(Double)
    case string(String)
    case array([AnyCodable])
    case object([String: AnyCodable])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Int.self) {
            self = .int(value)
        } else if let value = try? container.decode(Double.self) {
            self = .double(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([AnyCodable].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: AnyCodable].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .int(let value): try container.encode(value)
        case .double(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
}
`;

const REQUEST_BODY = `import Foundation

/// A dynamically-keyed, order-preserving JSON request-body builder. Optional
/// values that are \`nil\` are skipped so absent parameters are not serialized.
public struct EncodableBody: Encodable, Sendable {
    private var entries: [(String, any Encodable & Sendable)]

    public init() {
        entries = []
    }

    public mutating func set(_ key: String, _ value: (any Encodable & Sendable)?) {
        guard let value else { return }
        entries.append((key, value))
    }

    public var isEmpty: Bool { entries.isEmpty }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: DynamicCodingKey.self)
        for (key, value) in entries {
            try container.encode(AnyEncodable(value), forKey: DynamicCodingKey(stringValue: key))
        }
    }
}

/// Wraps an existential \`Encodable\` so it can be encoded through a concrete type.
struct AnyEncodable: Encodable {
    private let value: any Encodable
    init(_ value: any Encodable) { self.value = value }
    func encode(to encoder: Encoder) throws { try value.encode(to: encoder) }
}

/// A coding key created from an arbitrary string, for dynamic JSON objects.
struct DynamicCodingKey: CodingKey {
    let stringValue: String
    let intValue: Int?
    init(stringValue: String) {
        self.stringValue = stringValue
        self.intValue = nil
    }
    init?(intValue: Int) {
        self.stringValue = String(intValue)
        self.intValue = intValue
    }
}
`;

const PATH_ENCODING = `import Foundation

/// Per-segment path percent-encoding. Every path-parameter value MUST be routed
/// through this helper: without it a caller-supplied id containing "../" is
/// silently normalized before transmission, forging a request to a different
/// endpoint under the same credentials.
public enum PathEncoding {
    public static func segment(_ value: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }

    public static func segment(_ value: some CustomStringConvertible) -> String {
        segment(String(describing: value))
    }
}
`;

const CODING = `import Foundation

/// JSON encoder/decoder factories with an ISO-8601 date strategy that tolerates
/// fractional seconds and date-only values.
enum Coding {
    static func makeEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(iso8601Fractional.string(from: date))
        }
        return encoder
    }

    static func makeDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let string = try container.decode(String.self)
            if let date = iso8601Fractional.date(from: string) { return date }
            if let date = iso8601Plain.date(from: string) { return date }
            if let date = dateOnly.date(from: string) { return date }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid date: \\(string)")
        }
        return decoder
    }

    static let iso8601Fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    static let iso8601Plain: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    static let dateOnly: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter
    }()
}
`;

const PAGINATION = `import Foundation

/// A single page of a cursor-paginated list response.
public struct Page<Element: Codable & Sendable>: Codable, Sendable {
    public let data: [Element]
    public let listMetadata: PageMetadata

    public init(data: [Element], listMetadata: PageMetadata) {
        self.data = data
        self.listMetadata = listMetadata
    }

    private enum CodingKeys: String, CodingKey {
        case data
        case listMetadata = "list_metadata"
    }
}

/// Cursor metadata for a paginated list response. Named \`PageMetadata\` to avoid
/// colliding with a spec-defined \`ListMetadata\` model in the same module.
public struct PageMetadata: Codable, Sendable, Equatable {
    public let before: String?
    public let after: String?

    public init(before: String? = nil, after: String? = nil) {
        self.before = before
        self.after = after
    }
}

/// An \`AsyncSequence\` that transparently fetches successive pages until the
/// cursor is exhausted. Drive it with \`for try await item in ...\`.
public struct AutoPagingSequence<Element: Codable & Sendable>: AsyncSequence, Sendable {
    let fetch: @Sendable (String?) async throws -> Page<Element>

    public init(fetch: @escaping @Sendable (String?) async throws -> Page<Element>) {
        self.fetch = fetch
    }

    public func makeAsyncIterator() -> AsyncIterator {
        AsyncIterator(fetch: fetch)
    }

    public struct AsyncIterator: AsyncIteratorProtocol {
        let fetch: @Sendable (String?) async throws -> Page<Element>
        var buffer: [Element] = []
        var cursor: String?
        var finished = false

        public mutating func next() async throws -> Element? {
            if !buffer.isEmpty { return buffer.removeFirst() }
            if finished { return nil }
            let page = try await fetch(cursor)
            buffer = page.data
            cursor = page.listMetadata.after
            if cursor == nil || buffer.isEmpty { finished = true }
            return buffer.isEmpty ? nil : buffer.removeFirst()
        }
    }
}
`;

const REQUEST_OPTIONS = `import Foundation

/// Per-request overrides applied on top of the client configuration.
public struct RequestOptions: Sendable {
    /// Extra headers merged into (and overriding) the default request headers.
    public var additionalHeaders: [String: String]
    /// An explicit idempotency key for this request.
    public var idempotencyKey: String?
    /// A per-request timeout override, in seconds.
    public var timeout: TimeInterval?

    public init(
        additionalHeaders: [String: String] = [:],
        idempotencyKey: String? = nil,
        timeout: TimeInterval? = nil
    ) {
        self.additionalHeaders = additionalHeaders
        self.idempotencyKey = idempotencyKey
        self.timeout = timeout
    }
}
`;
