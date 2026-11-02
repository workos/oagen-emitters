import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSdkBehavior, type EmitterContext, type Field, type Model } from '@workos/oagen';
import { goEmitter } from '../../src/go/index.js';
import { restoreRequiredVariantFields } from '../../src/shared/model-utils.js';

// workos-go v10.5.0 exposed the vended credential's `Value` and `AuthMethod`
// as plain strings; v10.6.0 regenerated them as pointers because the parser
// merges a discriminated oneOf with every field optional.

const string = { kind: 'primitive', type: 'string' } as const;
const field = (name: string, required = false): Field => ({ name, type: string, required });

function context(models: Model[]): EmitterContext {
  return {
    namespace: 'workos',
    namespacePascal: 'WorkOS',
    spec: { name: 'Pipes', version: '1', baseUrl: '', models, enums: [], services: [], sdk: defaultSdkBehavior() },
  };
}

/** The `type Name struct { ... }` declaration starting at `marker`. */
function block(content: string, marker: string): string {
  const start = content.indexOf(marker);
  expect(start, `missing ${marker}`).toBeGreaterThanOrEqual(0);
  return content.slice(start, content.indexOf('\n}\n', start) + 2);
}

const variant = (method: string, extraRequired: string[] = []) => ({
  type: 'object',
  properties: {
    object: { type: 'string', const: 'credential' },
    auth_method: { type: 'string', const: method },
    value: { type: 'string' },
    expires_at: { type: ['string', 'null'] },
    config: { type: 'object', additionalProperties: { type: 'string' } },
  },
  required: ['object', 'auth_method', 'value', 'config', ...extraRequired],
});

const rawSpec = {
  openapi: '3.1.0',
  info: { title: 'fixture', version: '1' },
  paths: {},
  components: {
    schemas: {
      DataIntegrationVendedCredential: {
        discriminator: { propertyName: 'auth_method' },
        oneOf: [variant('oauth', ['expires_at']), { $ref: '#/components/schemas/ApiKeyCredential' }],
      },
      ApiKeyCredential: variant('api_key'),
      // Every discriminated oneOf gets the rule, not only the credential.
      OtherDiscriminated: {
        discriminator: { propertyName: 'kind' },
        oneOf: [
          { type: 'object', properties: { kind: { const: 'a' }, note: { type: 'string' } }, required: ['kind'] },
          {
            type: 'object',
            properties: { kind: { const: 'b' }, note: { type: 'string' } },
            required: ['kind', 'note'],
          },
        ],
      },
      // Undiscriminated oneOf: left alone (`Active *bool` as before).
      DataIntegrationCredentialsResponse: {
        oneOf: [
          { type: 'object', properties: { active: { const: true } }, required: ['active'] },
          { type: 'object', properties: { active: { const: false } }, required: ['active'] },
        ],
      },
      // A variant that is not an object schema: nothing is restored.
      Mixed: {
        discriminator: { propertyName: 'kind' },
        oneOf: [{ type: 'object', properties: { kind: { const: 'a' } }, required: ['kind'] }, { type: 'string' }],
      },
    },
  },
};

// The parser's output: every variant field merged in, all optional.
const models: Model[] = [
  {
    name: 'DataIntegrationVendedCredential',
    fields: [
      { name: 'object', type: { kind: 'literal', value: 'credential' }, required: false },
      { name: 'auth_method', type: { kind: 'literal', value: 'oauth' }, required: false },
      field('value'),
      { name: 'expires_at', type: { kind: 'nullable', inner: string }, required: false },
      { name: 'config', type: { kind: 'map', valueType: string }, required: false },
    ],
  },
  { name: 'OtherDiscriminated', fields: [field('kind'), field('note')] },
  { name: 'Mixed', fields: [field('kind')] },
  {
    name: 'DataIntegrationCredentialsResponse',
    fields: [
      { name: 'active', type: { kind: 'literal', value: true }, required: false },
      { name: 'credential', type: { kind: 'model', name: 'DataIntegrationVendedCredential' }, required: false },
    ],
  },
];

describe('fields every discriminated-oneOf variant requires', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'go-variant-required-'));
    writeFileSync(join(dir, 'spec.json'), JSON.stringify(rawSpec));
    process.env.OPENAPI_SPEC_PATH = join(dir, 'spec.json');
  });
  afterAll(() => {
    delete process.env.OPENAPI_SPEC_PATH;
    rmSync(dir, { recursive: true, force: true });
  });

  it('marks a field required only when every variant requires it', () => {
    const restored = restoreRequiredVariantFields(models);
    const required = (name: string) =>
      restored
        .find((m) => m.name === name)!
        .fields.filter((f) => f.required)
        .map((f) => f.name);
    expect(required('DataIntegrationVendedCredential')).toEqual(['object', 'auth_method', 'value', 'config']);
    expect(required('OtherDiscriminated')).toEqual(['kind']);
    expect(required('Mixed')).toEqual([]);
    expect(required('DataIntegrationCredentialsResponse')).toEqual([]);
    expect(models.flatMap((m) => m.fields).some((f) => f.required)).toBe(false); // input untouched
  });

  it('emits those fields as values, not pointers, in Go', () => {
    const content = goEmitter.generateModels(models, context(models))[0].content;
    const credential = block(content, 'type DataIntegrationVendedCredential struct');
    expect(credential).toContain('\tObject string `json:"object"`\n');
    expect(credential).toContain('\tAuthMethod string `json:"auth_method"`\n');
    expect(credential).toContain('\tValue string `json:"value"`\n');
    expect(credential).toContain('\tConfig map[string]string `json:"config"`\n');
    // Required by only one variant: still optional.
    expect(credential).toContain('\tExpiresAt *string `json:"expires_at,omitempty"`\n');
    expect(block(content, 'type OtherDiscriminated struct')).toContain('\tKind string `json:"kind"`\n');
    expect(block(content, 'type OtherDiscriminated struct')).toContain('\tNote *string `json:"note,omitempty"`\n');
    const response = block(content, 'type DataIntegrationCredentialsResponse struct');
    expect(response).toContain('\tActive *bool `json:"active,omitempty"`\n');
    expect(response).toContain('\tCredential *DataIntegrationVendedCredential `json:"credential,omitempty"`\n');
  });
});
