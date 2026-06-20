import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Enum, Model } from '@workos/oagen';
import { enrichModelsFromSpec, getSyntheticEnums } from '../../src/shared/model-utils.js';

// Regression: an inline oneOf enum whose synthetic name (`Parent_field`)
// snake-collapses onto an existing IR enum must NOT spawn a duplicate
// synthetic. `DataIntegrationAccessTokenResponse.error` (-> synthetic
// `DataIntegrationAccessTokenResponse_error`) and the parser-emitted IR enum
// `DataIntegrationAccessTokenResponseError` both snake to
// `data_integration_access_token_response_error`. When both exist, every
// PascalCase-normalizing emitter (PHP, Ruby, Go, ...) collapses them onto the
// SAME file path, and which one wins is decided by array order — which differs
// between a full and a scoped (`--services`) generation, yielding a
// non-deterministic enum-case order. Seeding `enrichModelsFromSpec` with the
// IR enum names suppresses the duplicate so the real enum always wins.
const SPEC = {
  openapi: '3.0.0',
  info: { title: 'fixture', version: '1.0.0' },
  paths: {},
  components: {
    schemas: {
      DataIntegrationAccessTokenResponse: {
        oneOf: [
          {
            type: 'object',
            properties: {
              error: {
                type: 'string',
                enum: ['not_installed', 'needs_reauthorization'],
              },
            },
          },
        ],
      },
    },
  },
};

const SYNTHETIC_NAME = 'DataIntegrationAccessTokenResponse_error';
const models: Model[] = [{ name: 'DataIntegrationAccessTokenResponse', fields: [] }];
const collidingEnum: Enum = {
  name: 'DataIntegrationAccessTokenResponseError',
  values: [
    { name: 'NOT_INSTALLED', value: 'not_installed' },
    { name: 'NEEDS_REAUTHORIZATION', value: 'needs_reauthorization' },
  ],
};

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'synthetic-enum-seed-'));
  const specPath = join(dir, 'spec.yaml');
  // `loadRawSpec` accepts JSON too (js-yaml parses JSON), so write JSON.
  writeFileSync(specPath, JSON.stringify(SPEC));
  process.env.OPENAPI_SPEC_PATH = specPath;
});

afterAll(() => {
  delete process.env.OPENAPI_SPEC_PATH;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('enrichModelsFromSpec — synthetic enum seed', () => {
  it('emits the inline synthetic enum when no IR enum names are seeded', () => {
    enrichModelsFromSpec(models);
    const names = getSyntheticEnums().map((e) => e.name);
    expect(names).toContain(SYNTHETIC_NAME);
  });

  it('suppresses the duplicate synthetic when the colliding IR enum is seeded', () => {
    enrichModelsFromSpec(models, [collidingEnum]);
    const names = getSyntheticEnums().map((e) => e.name);
    expect(names).not.toContain(SYNTHETIC_NAME);
  });
});
