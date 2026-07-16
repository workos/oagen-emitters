import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Model } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateModels } from '../../src/ios/models.js';

const emptySpec: ApiSpec = {
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
  spec: emptySpec,
};

describe('ios/models', () => {
  it('returns empty for no models', () => {
    expect(generateModels([], ctx)).toEqual([]);
  });

  it('generates a Codable struct with required and optional fields', () => {
    const models: Model[] = [
      {
        name: 'Organization',
        description: 'An organization.',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'created_at', type: { kind: 'primitive', type: 'string', format: 'date-time' }, required: false },
        ],
      },
    ];
    const files = generateModels(models, ctx);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('Sources/WorkOS/Models/Organization.swift');
    const content = files[0].content;
    expect(content).toContain('public struct Organization: Codable, Sendable, Equatable {');
    expect(content).toContain('public let id: String');
    expect(content).toContain('public let name: String');
    expect(content).toContain('public let createdAt: Date?');
    // wire-key mapping in CodingKeys
    expect(content).toContain('case createdAt = "created_at"');
    // public initializer with optional defaulted to nil
    expect(content).toContain('public init(');
    expect(content).toContain('createdAt: Date? = nil');
  });

  it('maps arrays, maps, model refs and enum refs', () => {
    const models: Model[] = [
      {
        name: 'User',
        fields: [
          { name: 'roles', type: { kind: 'array', items: { kind: 'primitive', type: 'string' } }, required: true },
          {
            name: 'metadata',
            type: { kind: 'map', valueType: { kind: 'primitive', type: 'string' } },
            required: false,
          },
          { name: 'profile', type: { kind: 'model', name: 'Profile' }, required: true },
          { name: 'state', type: { kind: 'enum', name: 'UserState' }, required: true },
        ],
      },
    ];
    const content = generateModels(models, ctx)[0].content;
    expect(content).toContain('public let roles: [String]');
    expect(content).toContain('public let metadata: [String: String]?');
    expect(content).toContain('public let profile: Profile');
    expect(content).toContain('public let state: UserState');
  });

  it('generates an empty struct with an empty init', () => {
    const models: Model[] = [{ name: 'Empty', fields: [] }];
    const content = generateModels(models, ctx)[0].content;
    expect(content).toContain('public struct Empty: Codable, Sendable, Equatable {');
    expect(content).toContain('public init() {}');
  });

  it('matches the expected struct output', () => {
    const models: Model[] = [
      {
        name: 'Note',
        fields: [{ name: 'body', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ];
    expect(generateModels(models, ctx)[0].content).toMatchInlineSnapshot(`
      "import Foundation

      public struct Note: Codable, Sendable, Equatable {
          public let body: String

          public init(
              body: String
          ) {
              self.body = body
          }

          private enum CodingKeys: String, CodingKey {
              case body
          }
      }"
    `);
  });
});
