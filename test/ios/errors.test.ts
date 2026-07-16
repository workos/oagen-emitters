import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateErrors } from '../../src/ios/errors.js';

const spec: ApiSpec = {
  name: 'WorkOS',
  version: '1.0.0',
  baseUrl: 'https://api.workos.com',
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

describe('ios/errors', () => {
  it('emits the APIError payload and error enum from the error policy', () => {
    const files = generateErrors(ctx);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('Sources/WorkOS/Errors/WorkOSError.swift');
    const content = files[0].content;
    expect(content).toContain('public struct APIError: Error, Sendable, Equatable {');
    expect(content).toContain('public let statusCode: Int');
    expect(content).toContain('public enum WorkOSError: Error, Sendable {');
    expect(content).toContain('case network(URLError)');
    expect(content).toContain('case decoding(any Error)');
    expect(content).toContain('case invalidResponse');
    expect(content).toContain('public static func from(statusCode: Int, apiError: APIError) -> WorkOSError {');
    expect(content).toContain('case 500...599: return');
  });

  it('generates a case for each status-code-map entry', () => {
    const content = generateErrors(ctx)[0].content;
    // defaultSdkBehavior maps at least these statuses.
    const statuses = Object.keys(ctx.spec.sdk.errors.statusCodeMap);
    expect(statuses.length).toBeGreaterThan(0);
    for (const status of statuses) {
      expect(content).toContain(`case ${status}: return .`);
    }
  });
});
