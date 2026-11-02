import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { parseSpec } from '@workos/oagen';
import type { ApiSpec, EmitterContext, Enum, GeneratedFile, Model, Operation } from '@workos/oagen';
import { dotnetEmitter } from '../../src/dotnet/index.js';
import { primeEnumAliases } from '../../src/dotnet/enums.js';
import { resolveRequestBodyModel } from '../../src/shared/request-body.js';
import { wireNameRoundTrips } from '../../src/dotnet/wire-name.js';

// WorkOS.net 6.5.0 emitted empty options classes for the Pipes upserts whose
// request bodies became a oneOf (workos-dotnet#320), so 6.4.0 callers failed
// to compile and the regenerated methods sent `{}`.

let spec: ApiSpec;
const OLD_METHOD_NAMES: Record<string, string> = {
  dataIntegrationsControllerCreateDataIntegration: 'createDataIntegration',
  dataIntegrationsControllerUpsertApiKey: 'updateDataIntegrationApiKey',
  dataIntegrationsControllerGetDataIntegrationAuthorizeUrl: 'authorizeDataIntegration',
  dataIntegrationsControllerUpsertClientCredentials: 'updateDataIntegrationClientCredentials',
};
beforeAll(async () => {
  spec = await parseSpec(resolve('test/fixtures/dotnet-pipes-compat.yaml'));
  for (const op of spec.services.flatMap((s) => s.operations)) op.name = OLD_METHOD_NAMES[op.name] ?? op.name;
  spec.services = [{ name: 'Pipes', operations: spec.services.flatMap((s) => s.operations) }];
});

function context(s: ApiSpec): EmitterContext {
  return { namespace: 'workos', namespacePascal: 'WorkOS', spec: s };
}

function op(name: string): Operation {
  return spec.services[0].operations.find((o) => o.name === name)!;
}

/** `{ csName: declaration }` for every property of `class` in `content`. */
function properties(content: string, cls: string): Record<string, string> {
  const body = content.split(new RegExp(`public class ${cls}\\b[^\\n]*\\n\\s*\\{`))[1].split(/\n {4}\}/)[0];
  return Object.fromEntries(
    [...body.matchAll(/public (.+?) (\w+) \{ get; (?:internal )?set; \}[^\n]*/g)].map((m) => [m[2], m[0]]),
  );
}

function file(files: GeneratedFile[], suffix: string): string {
  const found = files.find((f) => f.path.endsWith(suffix));
  if (!found) throw new Error(`no ${suffix} in ${files.map((f) => f.path).join(', ')}`);
  return found.content;
}

describe('dotnet union request bodies', () => {
  beforeEach(() => primeEnumAliases([]));

  it('projects every alternative onto the options class with 6.4.0 names, types and wire names', () => {
    const ctx = context(spec);
    dotnetEmitter.generateEnums(spec.enums, ctx);
    const options = file(dotnetEmitter.generateResources(spec.services, ctx), 'PipesOptions.cs');

    const apiKey = properties(options, 'PipesUpdateDataIntegrationApiKeyOptions');
    expect(apiKey).toEqual({
      UserId: 'public string UserId { get; set; } = default!;',
      OrganizationId: 'public string? OrganizationId { get; set; }',
      ConnectionOwner: expect.stringMatching(/^public \w+\? ConnectionOwner \{ get; set; \}$/),
      Secret: 'public string Secret { get; set; } = default!;',
      ConnectionIntent: 'public string? ConnectionIntent { get; set; }',
      ConnectedAccountId: 'public string? ConnectedAccountId { get; set; }',
    });
    expect(properties(options, 'PipesUpdateDataIntegrationClientCredentialsOptions')).toEqual({
      UserId: 'public string UserId { get; set; } = default!;',
      OrganizationId: 'public string? OrganizationId { get; set; }',
      ConnectionOwner: expect.stringMatching(/^public \w+\? ConnectionOwner \{ get; set; \}$/),
      ClientId: 'public string ClientId { get; set; } = default!;',
      ClientSecret: 'public string ClientSecret { get; set; } = default!;',
      Config: 'public Dictionary<string, string>? Config { get; set; }',
      ConnectionIntent: 'public string? ConnectionIntent { get; set; }',
      ConnectedAccountId: 'public string? ConnectedAccountId { get; set; }',
    });
    const authorize = properties(options, 'PipesAuthorizeDataIntegrationOptions');
    expect(Object.keys(authorize)).toEqual([
      'UserId',
      'ConnectionOwner',
      'ReturnTo',
      'ConnectionIntent',
      'ConnectedAccountId',
    ]);
    expect(authorize.UserId).toContain('public string UserId');
    expect(authorize.ConnectionIntent).toContain('public string? ConnectionIntent');
    // Every alternative's owner enum is the same type: one canonical, no per-alternative copies.
    expect(apiKey.ConnectionOwner).toBe(authorize.ConnectionOwner);

    // Optional properties are nullable, so the SDK's null-ignoring serializer
    // omits unset ones (6.4.0's `{ UserId }` still sends `{"user_id": …}`); the
    // snake_case policy recovers each wire name without per-property pins.
    expect(options).not.toMatch(/NullValueHandling|JsonPropertyName\("(user_id|connected_account_id)"\)/);
    const body = resolveRequestBodyModel(op('updateDataIntegrationApiKey'), spec.models, '.NET')!;
    for (const field of body.fields) {
      const csName = Object.keys(apiKey).find((k) => wireNameRoundTrips(k, field.name));
      expect(csName, field.name).toBeDefined();
    }
  });

  it('requires a field only when every alternative does and merges literal selectors', () => {
    const body = resolveRequestBodyModel(op('authorizeDataIntegration'), spec.models, '.NET')!;
    const byName = Object.fromEntries(body.fields.map((f) => [f.name, f]));
    expect(Object.keys(byName)).toEqual([
      'user_id',
      'connection_owner',
      'return_to',
      'connection_intent',
      'connected_account_id',
    ]);
    expect(body.fields.filter((f) => f.required).map((f) => f.name)).toEqual(['user_id']);
    expect(byName.connection_intent.type).toEqual({
      kind: 'union',
      variants: [
        { kind: 'literal', value: 'add' },
        { kind: 'literal', value: 'reauthorize' },
      ],
    });
  });

  it('fails generation for a union it cannot project instead of emitting an empty options class', () => {
    const conflicting: Model[] = [
      { name: 'A', fields: [{ name: 'x', type: { kind: 'primitive', type: 'string' }, required: true }] },
      { name: 'B', fields: [{ name: 'x', type: { kind: 'primitive', type: 'integer' }, required: true }] },
    ];
    const operation = {
      ...op('updateDataIntegrationApiKey'),
      requestBody: {
        kind: 'union' as const,
        variants: [
          { kind: 'model' as const, name: 'A' },
          { kind: 'model' as const, name: 'B' },
        ],
      },
    };
    expect(() =>
      dotnetEmitter.generateResources(
        [{ name: 'Pipes', operations: [operation] }],
        context({ ...spec, models: conflicting }),
      ),
    ).toThrow(
      /^\.NET PUT \/data-integrations\/\{slug\}\/api-key: unsupported request body \(conflicting types for x\)/,
    );
  });
});

describe('dotnet enum dedup under a scoped run', () => {
  const values = (...v: string[]) => v.map((value) => ({ name: value, value }));

  beforeEach(() => primeEnumAliases([]));

  it('writes the canonical when a scoped run only covers one of its aliases', () => {
    // Alphabetical dedup makes `Alpha` the canonical; `Beta`'s references are
    // rewritten to it, so a run scoped to `Beta` must still write Alpha.cs.
    const enums: Enum[] = [
      { name: 'Alpha', values: values('delegated', 'autonomous') },
      { name: 'Beta', values: values('delegated', 'autonomous') },
    ];
    const models: Model[] = [
      {
        name: 'BetaHolder',
        fields: [{ name: 'kinds', type: { kind: 'array', items: { kind: 'enum', name: 'Beta' } }, required: true }],
      },
    ];
    const s: ApiSpec = { ...spec, services: [], models, enums };
    const paths = dotnetEmitter
      .generateEnums(enums, {
        ...context(s),
        scopedServices: new Set(['Agents']),
        scopedModelNames: new Set(['BetaHolder']),
        scopedEnumNames: new Set(['Beta']),
      })
      .map((f) => f.path);
    expect(paths).toEqual(['src/WorkOS.net/Enums/Alpha.cs']);
  });
});
