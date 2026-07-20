import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Enum } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateEnums } from '../../src/ios/enums.js';

const spec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: '',
  services: [],
  models: [],
  enums: [],
  sdk: defaultSdkBehavior(),
};

const ctx: EmitterContext = {
  namespace: 'workos',
  namespacePascal: 'WorkOS',
  spec,
};

describe('ios/enums', () => {
  it('returns empty for no enums', () => {
    expect(generateEnums([], ctx)).toEqual([]);
  });

  it('generates a forward-compatible string enum', () => {
    const enums: Enum[] = [
      {
        name: 'ConnectionState',
        values: [
          { name: 'active', value: 'active' },
          { name: 'inactive', value: 'inactive' },
        ],
      },
    ];
    const files = generateEnums(enums, ctx);
    expect(files[0].path).toBe('Sources/WorkOS/Enums/ConnectionState.swift');
    const content = files[0].content;
    expect(content).toContain('public enum ConnectionState: RawRepresentable, Codable, Sendable, Hashable {');
    expect(content).toContain('case active');
    expect(content).toContain('case inactive');
    // forward-compat sentinel + non-failable init
    expect(content).toContain('case unknown(String)');
    expect(content).toContain('public init(rawValue: String) {');
    expect(content).toContain('case "active": self = .active');
    expect(content).toContain('default: self = .unknown(rawValue)');
    // explicit Codable
    expect(content).toContain('public init(from decoder: Decoder) throws {');
    expect(content).toContain('public func encode(to encoder: Encoder) throws {');
    expect(content).toContain('public static let allKnownCases: [ConnectionState] = [.active, .inactive]');
  });

  it('generates an Int-backed enum', () => {
    const enums: Enum[] = [
      {
        name: 'Priority',
        values: [
          { name: 'low', value: 1 },
          { name: 'high', value: 2 },
        ],
      },
    ];
    const content = generateEnums(enums, ctx)[0].content;
    expect(content).toContain('public init(rawValue: Int) {');
    expect(content).toContain('case unknown(Int)');
    expect(content).toContain('case 1: self = .low');
    expect(content).toContain('case .low: return 1');
  });

  it('matches the expected enum output', () => {
    const enums: Enum[] = [
      {
        name: 'SortOrder',
        values: [
          { name: 'asc', value: 'asc' },
          { name: 'desc', value: 'desc' },
        ],
      },
    ];
    expect(generateEnums(enums, ctx)[0].content).toMatchInlineSnapshot(`
      "import Foundation

      /// Enumeration of valid SortOrder values.
      public enum SortOrder: RawRepresentable, Codable, Sendable, Hashable {
          case asc
          case desc
          /// A value not known at SDK generation time.
          case unknown(String)

          public init(rawValue: String) {
              switch rawValue {
              case "asc": self = .asc
              case "desc": self = .desc
              default: self = .unknown(rawValue)
              }
          }

          public var rawValue: String {
              switch self {
              case .asc: return "asc"
              case .desc: return "desc"
              case .unknown(let value): return value
              }
          }

          public init(from decoder: Decoder) throws {
              let raw = try decoder.singleValueContainer().decode(String.self)
              self.init(rawValue: raw)
          }

          public func encode(to encoder: Encoder) throws {
              var container = encoder.singleValueContainer()
              try container.encode(rawValue)
          }

          public static let allKnownCases: [SortOrder] = [.asc, .desc]
      }"
    `);
  });
});
