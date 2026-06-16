import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import {
  detectDiscriminatedShape,
  generateDiscriminatedFiles,
  type DiscriminatedPlan,
} from '../../src/node/discriminated-models.js';

const emptySpec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: '',
  services: [],
  models: [],
  enums: [],
  sdk: defaultSdkBehavior(),
};

const ctx: EmitterContext = { namespace: 'workos', namespacePascal: 'WorkOS', spec: emptySpec };

// A pure `oneOf` discriminated by a boolean `active` const — the Pipes token
// response shape that previously collapsed into a flat all-optional interface.
// `RawSchema` is internal to the emitter; the loose typing mirrors the raw
// `components.schemas` shape `detectDiscriminatedShape` consumes at runtime.
const rawSchemas: Record<string, any> = {
  DataIntegrationAccessTokenResponse: {
    oneOf: [
      {
        type: 'object',
        properties: {
          active: { type: 'boolean', const: true },
          access_token: {
            type: 'object',
            properties: {
              object: { type: 'string', const: 'access_token' },
              access_token: { type: 'string' },
              expires_at: { type: ['string', 'null'], format: 'date-time' },
              scopes: { type: 'array', items: { type: 'string' } },
              missing_scopes: { type: 'array', items: { type: 'string' } },
            },
            required: ['object', 'access_token', 'expires_at', 'scopes', 'missing_scopes'],
          },
        },
        required: ['active', 'access_token'],
      },
      {
        type: 'object',
        properties: {
          active: { type: 'boolean', const: false },
          error: { type: 'string', enum: ['not_installed', 'needs_reauthorization'] },
        },
        required: ['active', 'error'],
      },
    ],
  },
};

describe('detectDiscriminatedShape — pure oneOf with boolean discriminator', () => {
  it('detects a two-variant inline union keyed on the boolean `active`', () => {
    const shape = detectDiscriminatedShape('DataIntegrationAccessTokenResponse', rawSchemas);
    expect(shape).not.toBeNull();
    expect(shape!.inlineUnion).toBe(true);
    expect(shape!.discriminatorProperty).toBe('active');
    expect(shape!.variants).toHaveLength(2);
    expect(shape!.variants.map((v) => v.discriminatorValue).sort()).toEqual(['false', 'true']);
    expect(shape!.variants.every((v) => v.discriminatorIsBoolean)).toBe(true);
  });

  it('emits a discriminated union interface (not a flat optional bag)', () => {
    const shape = detectDiscriminatedShape('DataIntegrationAccessTokenResponse', rawSchemas)!;
    const plan: DiscriminatedPlan = { shape, modelDir: 'pipes', depDirMap: new Map() };
    const files = generateDiscriminatedFiles(new Map([['DataIntegrationAccessTokenResponse', plan]]), ctx);

    const iface = files.find((f) => f.path.endsWith('.interface.ts'))!;
    expect(iface).toBeDefined();
    // Union alias, two variants, boolean discriminator (unquoted), required fields.
    expect(iface.content).toContain('export type DataIntegrationAccessTokenResponse =');
    expect(iface.content).toContain('active: true');
    expect(iface.content).toContain('active: false');
    expect(iface.content).toContain('accessToken: DataIntegrationAccessTokenResponseAccessToken');
    expect(iface.content).toContain("error: 'not_installed' | 'needs_reauthorization'");
    // No optional discriminator — narrowing must work.
    expect(iface.content).not.toContain('active?: true');

    const ser = files.find((f) => f.path.endsWith('.serializer.ts'))!;
    expect(ser.content).toContain('switch (response.active)');
    expect(ser.content).toContain('case true:');
    expect(ser.content).toContain('case false:');
  });
});
