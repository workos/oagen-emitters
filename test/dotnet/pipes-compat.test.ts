import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { defaultSdkBehavior, parseSpec } from '@workos/oagen';
import type { ApiSpec, EmitterContext, Enum, GeneratedFile, Model, Operation } from '@workos/oagen';
import { dotnetEmitter } from '../../src/dotnet/index.js';
import { primeEnumAliases, resolveEnumName } from '../../src/dotnet/enums.js';
import { resolveRequestBodyModel } from '../../src/dotnet/request-body.js';
import { wireNameRoundTrips } from '../../src/dotnet/wire-name.js';

// Compatibility with WorkOS.net 6.4.0 Pipes callers (workos-dotnet#320 broke them).

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
  it('projects every alternative onto the options class with 6.4.0 names, types and wire names', () => {
    const ctx = context(spec);
    dotnetEmitter.generateEnums(spec.enums, ctx);
    const options = file(dotnetEmitter.generateResources(spec.services, ctx), 'PipesOptions.cs');

    const apiKey = properties(options, 'PipesUpdateDataIntegrationApiKeyOptions');
    expect(apiKey).toEqual({
      UserId: 'public string UserId { get; set; } = default!;',
      OrganizationId: 'public string? OrganizationId { get; set; }',
      ConnectionOwner: 'public CreateDataIntegrationOwnership? ConnectionOwner { get; set; }',
      Secret: 'public string Secret { get; set; } = default!;',
      ConnectionIntent: 'public string? ConnectionIntent { get; set; }',
      ConnectedAccountId: 'public string? ConnectedAccountId { get; set; }',
    });
    expect(properties(options, 'PipesUpdateDataIntegrationClientCredentialsOptions')).toEqual({
      UserId: 'public string UserId { get; set; } = default!;',
      OrganizationId: 'public string? OrganizationId { get; set; }',
      ConnectionOwner: 'public CreateDataIntegrationOwnership? ConnectionOwner { get; set; }',
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

    // Optional properties are nullable, so the SDK's null-ignoring serializer
    // omits unset ones (6.4.0's `{ UserId }` still sends `{"user_id": …}`); the
    // snake_case policy recovers each wire name without per-property pins.
    expect(options).not.toMatch(/NullValueHandling|JsonPropertyName\("(user_id|connected_account_id)"\)/);
    const body = resolveRequestBodyModel(op('updateDataIntegrationApiKey'), spec.models)!;
    for (const field of body.fields) {
      const csName = Object.keys(apiKey).find((k) => wireNameRoundTrips(k, field.name));
      expect(csName, field.name).toBeDefined();
    }
  });

  it('requires a field only when every alternative does and merges literal selectors', () => {
    const body = resolveRequestBodyModel(op('authorizeDataIntegration'), spec.models)!;
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
    expect(() => resolveRequestBodyModel(operation, conflicting)).toThrow(/conflicting types for x/);
    const arrays = {
      ...operation,
      requestBody: { kind: 'union' as const, variants: [{ kind: 'primitive' as const, type: 'string' as const }] },
    };
    expect(() => resolveRequestBodyModel(arrays, conflicting)).toThrow(/unsupported request body/);
  });
});

describe('dotnet 6.4.0 enum names', () => {
  const values = (...v: string[]) => v.map((value) => ({ name: value, value }));
  const owner = (name: string, ...extra: string[]): Enum => ({
    name,
    values: values('user', 'organization', ...extra),
  });

  beforeEach(() => primeEnumAliases([]));

  it('keeps CreateDataIntegrationOwnership as the canonical over an alphabetically earlier duplicate', () => {
    const ctx = context(spec);
    const enumFiles = dotnetEmitter.generateEnums(spec.enums, ctx).map((f) => f.path);
    expect(enumFiles).toContain('src/WorkOS.net/Enums/CreateDataIntegrationOwnership.cs');
    expect(
      enumFiles.some((p) => p.includes('AddDataIntegrationsGetDataIntegrationAuthorizeUrlRequestConnectionOwner')),
    ).toBe(false);
    const options = file(dotnetEmitter.generateResources(spec.services, ctx), 'PipesOptions.cs');
    expect(properties(options, 'PipesCreateDataIntegrationOptions').Ownership).toContain(
      'CreateDataIntegrationOwnership?',
    );
    expect(properties(options, 'PipesAuthorizeDataIntegrationOptions').ConnectionOwner).toContain(
      'CreateDataIntegrationOwnership?',
    );
  });

  it('keeps AgentInstanceCreatedDataType as the canonical of the agent instance type group', () => {
    const enums: Enum[] = [
      { name: 'AgentBlueprintCreatedDataInvocableAsInstanceTypes', values: values('delegated', 'autonomous') },
      { name: 'AgentInstanceCreatedDataType', values: values('delegated', 'autonomous') },
    ];
    expect(resolveEnumName('AgentBlueprintCreatedDataInvocableAsInstanceTypes', enums)).toBe(
      'AgentInstanceCreatedDataType',
    );
  });

  it('writes the preserved canonical when a scoped run only covers one of its aliases', () => {
    const instanceTypes: Enum[] = [
      { name: 'AgentBlueprintCreatedDataInvocableAsInstanceTypes', values: values('delegated', 'autonomous') },
      { name: 'AgentInstanceCreatedDataType', values: values('delegated', 'autonomous') },
    ];
    const models: Model[] = [
      {
        name: 'AgentBlueprintCreatedDataInvocableAs',
        fields: [
          {
            name: 'instance_types',
            type: { kind: 'array', items: { kind: 'enum', name: instanceTypes[0].name } },
            required: true,
          },
        ],
      },
    ];
    const s: ApiSpec = { ...spec, services: [], models, enums: instanceTypes };
    const paths = dotnetEmitter
      .generateEnums(instanceTypes, {
        ...context(s),
        scopedServices: new Set(['Agents']),
        scopedModelNames: new Set([models[0].name]),
        scopedEnumNames: new Set([instanceTypes[0].name]),
      })
      .map((f) => f.path);
    expect(paths).toEqual(['src/WorkOS.net/Enums/AgentInstanceCreatedDataType.cs']);
  });

  it('falls back to the alphabetical canonical once the preserved enum changes shape', () => {
    const unchanged = [owner('AddConnectionOwner'), owner('CreateDataIntegrationOwnership')];
    expect(resolveEnumName('AddConnectionOwner', unchanged)).toBe('CreateDataIntegrationOwnership');
    const changed = [owner('AddConnectionOwner', 'team'), owner('CreateDataIntegrationOwnership', 'team')];
    expect(resolveEnumName('CreateDataIntegrationOwnership', changed)).toBe('AddConnectionOwner');
  });
});

describe('dotnet 6.4.0 model base classes', () => {
  const str = { kind: 'primitive' as const, type: 'string' as const };
  const strings = { kind: 'array' as const, items: str };
  const account: Model = {
    name: 'ConnectedAccount',
    fields: [
      { name: 'id', type: str, required: true },
      { name: 'scopes', type: strings, required: true },
    ],
  };
  const warning: Model = {
    name: 'ConnectedAccountWriteResponseWarning',
    fields: [{ name: 'code', type: str, required: true }],
  };
  const writeResponse: Model = {
    name: 'ConnectedAccountWriteResponse',
    fields: [
      ...account.fields,
      { name: 'warnings', type: { kind: 'array', items: { kind: 'model', name: warning.name } }, required: false },
    ],
  };
  const vended: Model = {
    name: 'DataIntegrationVendedCredential',
    fields: [
      { name: 'object', type: str, required: false },
      { name: 'auth_method', type: str, required: false },
      { name: 'value', type: str, required: false },
      { name: 'expires_at', type: { kind: 'nullable', inner: str }, required: false },
      { name: 'scopes', type: strings, required: false },
      { name: 'missing_scopes', type: strings, required: false },
      { name: 'config', type: { kind: 'map', valueType: str }, required: false },
    ],
  };
  const credentialsResponse: Model = {
    name: 'DataIntegrationCredentialsResponse',
    fields: [{ name: 'credential', type: { kind: 'model', name: vended.name }, required: false }],
  };

  function generate(models: Model[], extra: Partial<EmitterContext> = {}): GeneratedFile[] {
    const s: ApiSpec = {
      name: 'Test',
      version: '1.0.0',
      baseUrl: '',
      services: [],
      models,
      enums: [],
      sdk: defaultSdkBehavior(),
    };
    return dotnetEmitter.generateModels(models, { ...context(s), ...extra });
  }

  beforeEach(() => primeEnumAliases([]));

  it('derives ConnectedAccountWriteResponse from ConnectedAccount and keeps Warnings', () => {
    const files = generate([account, warning, writeResponse]);
    const content = file(files, '/ConnectedAccountWriteResponse.cs');
    expect(content).toContain('public class ConnectedAccountWriteResponse : ConnectedAccount');
    expect(Object.keys(properties(content, 'ConnectedAccountWriteResponse'))).toEqual(['Warnings']);
    expect(file(files, '/ConnectedAccount.cs')).toContain('public class ConnectedAccount\n');
  });

  it('also writes the base when a scoped run only covers the write response', () => {
    const files = generate([account, warning, writeResponse], {
      scopedServices: new Set(['Pipes']),
      scopedModelNames: new Set([writeResponse.name, warning.name]),
    });
    expect(files.map((f) => f.path)).toContain('src/WorkOS.net/Entities/ConnectedAccount.cs');
  });

  it('restores DataIntegrationCredentialsResponseCredential as the base of DataIntegrationVendedCredential', () => {
    const files = generate([credentialsResponse, vended]);
    const old = properties(
      file(files, '/DataIntegrationCredentialsResponseCredential.cs'),
      'DataIntegrationCredentialsResponseCredential',
    );
    expect(Object.keys(old)).toEqual(['Object', 'AuthMethod', 'Value', 'ExpiresAt', 'Scopes', 'MissingScopes']);
    expect(old.Value).toContain('public string? Value');
    expect(old.AuthMethod).toContain('public string? AuthMethod');
    const current = file(files, '/DataIntegrationVendedCredential.cs');
    expect(current).toContain(
      'public class DataIntegrationVendedCredential : DataIntegrationCredentialsResponseCredential',
    );
    expect(Object.keys(properties(current, 'DataIntegrationVendedCredential'))).toEqual(['Config']);
    // The response keeps the 6.5.0 type, which 6.4.0 code reads through the base.
    expect(file(files, '/DataIntegrationCredentialsResponse.cs')).toContain(
      'public DataIntegrationVendedCredential? Credential',
    );
  });

  it('skips an entry whose shape changed instead of hiding or retyping members', () => {
    const retyped: Model = {
      ...writeResponse,
      fields: writeResponse.fields.map((f) =>
        f.name === 'id' ? { ...f, type: { kind: 'primitive', type: 'integer' } } : f,
      ),
    };
    const withoutValue: Model = { ...vended, fields: vended.fields.filter((f) => f.name !== 'value') };
    const files = generate([account, warning, retyped, credentialsResponse, withoutValue]);
    expect(file(files, '/ConnectedAccountWriteResponse.cs')).toContain('public class ConnectedAccountWriteResponse\n');
    expect(file(files, '/DataIntegrationVendedCredential.cs')).toContain(
      'public class DataIntegrationVendedCredential\n',
    );
    expect(files.some((f) => f.path.endsWith('/DataIntegrationCredentialsResponseCredential.cs'))).toBe(false);
  });
});
