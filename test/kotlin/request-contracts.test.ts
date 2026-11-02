import { beforeAll, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { parseSpec, type ApiSpec, type EmitterContext } from '@workos/oagen';
import type { ApiSurface } from '@workos/oagen/compat';
import { generateResources } from '../../src/kotlin/resources.js';
import { generateEnums } from '../../src/kotlin/enums.js';
import { baselineReordersArgs, generateTests } from '../../src/kotlin/tests.js';

const MOUNTS: Record<string, string> = {
  DataIntegrations: 'Pipes',
  UserManagement: 'Pipes',
  Organizations: 'Pipes',
  SSO: 'SSO',
  AdminPortal: 'AdminPortal',
  Agents: 'Agents',
};

// workos-kotlin v7.4.0 parameter slots, `?` marking a defaulted one: what
// sdk-generate.sh extracts from the shipped SDK and passes as --api-surface.
// The 7.5.0 regeneration inserted, moved or required parameters ahead of
// these, so positional callers compiled against the wrong fields.
const V74_SLOTS: Record<string, string[]> = {
  'Pipes.authorizeDataIntegration': [
    'slug',
    'userId',
    'organizationId?',
    'connectionOwner?',
    'returnTo?',
    'config?',
    'requestOptions?',
  ],
  'Pipes.updateDataIntegrationApiKey': [
    'slug',
    'userId',
    'secret',
    'organizationId?',
    'connectedAccountId?',
    'connectionOwner?',
    'requestOptions?',
  ],
  'Pipes.updateDataIntegrationClientCredentials': [
    'slug',
    'userId',
    'clientId',
    'clientSecret',
    'organizationId?',
    'connectedAccountId?',
    'connectionOwner?',
    'config?',
    'requestOptions?',
  ],
  'Pipes.createUserConnectedAccount': [
    'userId',
    'slug',
    'organizationId?',
    'accessToken?',
    'refreshToken?',
    'expiresAt?',
    'scopes?',
    'state?',
    'requestOptions?',
  ],
  'Pipes.updateUserConnectedAccount': [
    'userId',
    'slug',
    'organizationId?',
    'supportsMultipleConnections?',
    'connectedAccountId?',
    'accessToken?',
    'refreshToken?',
    'expiresAt?',
    'scopes?',
    'state?',
    'requestOptions?',
  ],
  'Pipes.createOrganizationConnectedAccount': [
    'organizationId',
    'slug',
    'accessToken?',
    'refreshToken?',
    'expiresAt?',
    'scopes?',
    'state?',
    'requestOptions?',
  ],
  'Pipes.updateOrganizationConnectedAccount': [
    'organizationId',
    'slug',
    'supportsMultipleConnections?',
    'connectedAccountId?',
    'accessToken?',
    'refreshToken?',
    'expiresAt?',
    'scopes?',
    'state?',
    'requestOptions?',
  ],
  'SSO.getProfileAndToken': ['code?', 'subjectToken?', 'subjectTokenType?', 'organizationId?', 'requestOptions?'],
  'AdminPortal.generateLink': [
    'organization',
    'returnUrl?',
    'successUrl?',
    'intent?',
    'itContactEmails?',
    'requestOptions?',
  ],
  'Agents.createBlueprint': [
    'name',
    'description?',
    'permissions?',
    'invocableBy?',
    'sessionSettings?',
    'requestOptions?',
  ],
  'Agents.updateBlueprint': [
    'agentBlueprintId',
    'name?',
    'description?',
    'permissions?',
    'invocableBy?',
    'sessionSettings?',
    'requestOptions?',
  ],
};

function surface(slots: Record<string, string[]> = V74_SLOTS): ApiSurface {
  const classes: ApiSurface['classes'] = {};
  for (const [key, params] of Object.entries(slots)) {
    const [cls, method] = key.split('.');
    classes[cls] ??= { name: cls, properties: {}, constructorParams: [], methods: {} };
    classes[cls].methods[method] = [
      {
        name: method,
        async: false,
        returnType: 'Any',
        params: params.map((p) => ({ name: p.replace(/\?$/, ''), optional: p.endsWith('?'), type: 'Any' })),
      },
    ];
  }
  return {
    language: 'kotlin',
    extractedFrom: 'v7.4.0',
    extractedAt: '',
    classes,
    interfaces: {},
    typeAliases: {},
    enums: {},
    exports: {},
  };
}

let spec: ApiSpec;
beforeAll(async () => {
  spec = await parseSpec(resolve('test/fixtures/kotlin-v74-compat.yaml'));
});

function context(input: ApiSpec = spec, baseline: ApiSurface | null = surface()): EmitterContext {
  const ctx: EmitterContext = {
    namespace: 'workos',
    namespacePascal: 'WorkOS',
    spec: input,
    apiSurface: baseline ?? undefined,
    resolvedOperations: input.services.flatMap((service) =>
      service.operations.map((operation) => ({
        service,
        operation,
        methodName: operation.name,
        mountOn: MOUNTS[service.name],
        defaults: {},
        inferFromClient: [],
        urlBuilder: false,
      })),
    ),
  };
  generateEnums(input.enums, ctx); // registers enum canonical names used by resources
  return ctx;
}

function source(cls: string, ctx = context()): string {
  const file = generateResources(ctx.spec.services, ctx).find((f) => f.path.endsWith(`/${cls}.kt`));
  if (!file) throw new Error(`no ${cls}.kt`);
  return file.content;
}

/** The blocking method's declaration block (annotations + signature). */
function declaration(src: string, method: string): string {
  const match = src.match(new RegExp(`((?:  @\\w+.*\\n)*)  fun ${method}\\(([\\s\\S]*?)\\n  \\)`));
  if (!match) throw new Error(`no fun ${method}`);
  return match[0];
}

/** Parameter slots of the blocking method, `?` marking defaulted ones. */
function slots(src: string, method: string): string[] {
  const params = declaration(src, method).split(`fun ${method}(`)[1];
  return [...params.matchAll(/^ {4}(\w+): ([^\n]*?),?$/gm)].map(([, name, rest]) =>
    rest.includes(' = ') ? `${name}?` : name,
  );
}

function withField(input: ApiSpec, model: string, field: string, change: { required?: boolean } | null): ApiSpec {
  const copy = structuredClone(input);
  const m = copy.models.find((x) => x.name === model)!;
  if (change === null) m.fields = m.fields.filter((f) => f.name !== field);
  else
    Object.assign(
      m.fields.find((f) => f.name === field)!,
      change,
    );
  return copy;
}

describe('kotlin request contracts', () => {
  it('projects union request bodies onto typed parameters and sends them, without mutating the spec', () => {
    const before = JSON.stringify(spec);
    const pipes = source('Pipes');
    const authorize = pipes.slice(pipes.indexOf('fun authorizeDataIntegration('));
    expect(authorize).not.toMatch(/^ {4}val body = linkedMapOf<String, Any\?>\(\)/m);
    for (const field of ['user_id', 'organization_id', 'connection_owner', 'return_to', 'config']) {
      expect(authorize.slice(0, authorize.indexOf('workos.baseClient.request'))).toContain(`"${field}" to`);
    }
    const apiKey = pipes.slice(pipes.indexOf('fun updateDataIntegrationApiKey('));
    expect(apiKey.slice(0, apiKey.indexOf('workos.baseClient.request'))).toMatch(
      /"user_id" to userId,\s+"secret" to secret,[\s\S]*"connected_account_id" to connectedAccountId/,
    );
    // Differing literal selectors widen to a plain optional String, never a hardcoded value.
    expect(declaration(pipes, 'authorizeDataIntegration')).toContain('connectionIntent: String? = null');
    expect(JSON.stringify(spec)).toBe(before);
  });

  it('uses the schema order when no baseline is passed', () => {
    expect(slots(source('Pipes', context(spec, null)), 'authorizeDataIntegration')).toEqual([
      'slug',
      'userId',
      'accountDisplayName?',
      'organizationId?',
      'connectionOwner?',
      'returnTo?',
      'config?',
      'connectionIntent?',
      'connectedAccountId?',
      'requestOptions?',
    ]);
  });

  it('keeps every baseline slot and appends newer parameters after them, including after requestOptions', () => {
    const ctx = context();
    for (const [key, expected] of Object.entries(V74_SLOTS)) {
      const [cls, method] = key.split('.');
      expect(slots(source(cls, ctx), method).slice(0, expected.length), key).toEqual(expected);
    }
    const pipes = source('Pipes', ctx);
    expect(slots(pipes, 'authorizeDataIntegration').slice(7)).toEqual([
      'accountDisplayName?',
      'connectionIntent?',
      'connectedAccountId?',
    ]);
    expect(slots(pipes, 'createUserConnectedAccount').slice(9)).toEqual([
      'accountDisplayName?',
      'accountIdentifier?',
      'connectionIntent?',
    ]);
    expect(slots(source('SSO', ctx), 'getProfileAndToken')).toEqual([
      'code?',
      'subjectToken?',
      'subjectTokenType?',
      'organizationId?',
      'requestOptions?',
      'codeVerifier?',
    ]);
    const link = declaration(source('AdminPortal', ctx), 'generateLink');
    expect(link).toMatch(/successUrl: String\? = null,\n {4}intent: \w+\? = null,\n {4}itContactEmails:/);
    expect(link).toMatch(/requestOptions: RequestOptions\? = null,\n {4}externalUserId: String\? = null/);
    expect(declaration(source('Agents', ctx), 'updateBlueprint')).toMatch(
      /invocableBy: PatchField<\w+> = PatchField.Absent,\n {4}sessionSettings: PatchField<\w+> = PatchField.Absent,\n {4}requestOptions: RequestOptions\? = null,\n {4}invocableAs:/,
    );
  });

  it('never lets a newly required parameter capture an old positional argument, from Kotlin or Java', () => {
    const pipes = source('Pipes');
    for (const method of ['createOrganizationConnectedAccount', 'updateOrganizationConnectedAccount']) {
      const decl = declaration(pipes, method);
      // Required userId sits after every baseline slot, so an old positional call fails to compile...
      expect(slots(pipes, method).indexOf('userId')).toBe(V74_SLOTS[`Pipes.${method}`].length);
      // ...and without @JvmOverloads, Java gets no short overload where userId fills an old slot.
      expect(decl).not.toContain('@JvmOverloads');
    }
    // Methods whose required parameters all lead keep their Java overloads.
    expect(declaration(pipes, 'createUserConnectedAccount')).toContain('@JvmOverloads');
    expect(declaration(pipes, 'authorizeDataIntegration')).toContain('@JvmOverloads');
  });

  it('keeps the slot of a baseline-optional parameter the schema made required', () => {
    const required = withField(spec, 'GenerateLinkRequest', 'intent', { required: true });
    const link = declaration(source('AdminPortal', context(required)), 'generateLink');
    expect(slots(link, 'generateLink').slice(0, 4)).toEqual(['organization', 'returnUrl?', 'successUrl?', 'intent']);
    expect(link).not.toContain('@JvmOverloads');
  });

  it('keeps the slot of a baseline-required parameter the schema made optional, with its new default', () => {
    const optional = withField(spec, 'GenerateLinkRequest', 'organization', { required: false });
    const link = declaration(source('AdminPortal', context(optional)), 'generateLink');
    expect(slots(link, 'generateLink').slice(0, 2)).toEqual(['organization?', 'returnUrl?']);
    expect(link).toContain('@JvmOverloads');
  });

  it('keeps @JvmOverloads for a required-after-defaulted order the baseline itself shipped', () => {
    // v7.4.0 shipped `generateLink(returnUrl?, organization, ...)` with Java overloads; restoring that order
    // keeps them, since no parameter became required or moved behind a new one.
    const shipped = surface({
      ...V74_SLOTS,
      'AdminPortal.generateLink': [
        'returnUrl?',
        'organization',
        'successUrl?',
        'intent?',
        'itContactEmails?',
        'requestOptions?',
      ],
    });
    const link = declaration(source('AdminPortal', context(spec, shipped)), 'generateLink');
    expect(slots(link, 'generateLink').slice(0, 3)).toEqual(['returnUrl?', 'organization', 'successUrl?']);
    expect(link).toContain('@JvmOverloads');
  });

  it('emits the schema signature and warns when a baseline parameter was removed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const removed = withField(spec, 'GetProfileAndTokenRequest', 'subject_token', null);
      expect(slots(source('SSO', context(removed)), 'getProfileAndToken')).toEqual([
        'code?',
        'codeVerifier?',
        'subjectTokenType?',
        'organizationId?',
        'requestOptions?',
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/\[oagen\] kotlin: SSO\.getProfileAndToken: /));
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/subjectToken was removed/));
    } finally {
      warn.mockRestore();
    }
  });

  it('names arguments in generated tests only where the baseline order would bind them differently', () => {
    const ctx = context();
    const pipesTest = generateTests(spec, ctx).find((f) => f.path.endsWith('/PipesTest.kt'))!.content;
    // userId sits after requestOptions, so a positional call cannot reach it.
    expect(pipesTest).toContain(
      'api().createOrganizationConnectedAccount(organizationId = "sample-arg", slug = "sample-arg", userId = "sample-arg")',
    );
    // The leading slots still match the schema order: positional, as without a baseline.
    expect(pipesTest).toContain('api().authorizeDataIntegration("sample-arg", "sample-arg")');
    expect(pipesTest).toContain('api().updateDataIntegrationApiKey("sample-arg", "sample-arg", "sample-arg")');
    expect(pipesTest).toMatch(/matchingJsonPath\("\\\$\.secret"\)/);
    // A baseline that leads with a parameter the schema orders later: every argument by name.
    const reordered = context(
      spec,
      surface({ ...V74_SLOTS, 'Pipes.authorizeDataIntegration': ['userId', 'slug', 'requestOptions?'] }),
    );
    expect(generateTests(spec, reordered).find((f) => f.path.endsWith('/PipesTest.kt'))!.content).toContain(
      'api().authorizeDataIntegration(slug = "sample-arg", userId = "sample-arg")',
    );
  });

  it('passes path arguments in URL template order, so a spec that lists them differently stays positional', () => {
    const input = structuredClone(spec);
    const op = input.services.flatMap((s) => s.operations).find((o) => o.name === 'createUserConnectedAccount')!;
    op.pathParams.reverse(); // spec order (slug, user_id); the path is /users/{user_id}/connected_accounts/{slug}
    const pipesTest = generateTests(input, context(input)).find((f) => f.path.endsWith('/PipesTest.kt'))!.content;
    expect(pipesTest).toContain('api().createUserConnectedAccount("sample-arg", "sample-arg")');
  });

  it('names every test argument when a parameter group is passed under a baseline', () => {
    const baseline = (...names: string[]) =>
      names.map((n) => ({ name: n.replace(/\?$/, ''), optional: n.endsWith('?'), type: 'Any' }));
    // A group the schema now requires is built ahead of the positional body argument, but the
    // baseline keeps it in a later slot: `create(createUserPassword = ..., "sample-arg")` would not compile.
    expect(baselineReordersArgs(baseline('email', 'createUserPassword?', 'requestOptions?'), ['', 'email'])).toBe(true);
    // Positional leading slots that match the baseline stay positional; a trailing named group is fine
    // on its own, but any group under a baseline names everything to stay valid.
    expect(baselineReordersArgs(baseline('slug', 'userId', 'requestOptions?'), ['slug', 'userId'])).toBe(false);
    expect(baselineReordersArgs(baseline('slug', 'userId', 'requestOptions?'), ['slug', 'userId', ''])).toBe(true);
    expect(baselineReordersArgs(baseline('userId', 'slug', 'requestOptions?'), ['slug', 'userId'])).toBe(true);
    expect(baselineReordersArgs(baseline('slug', 'requestOptions?'), ['slug', 'userId'])).toBe(true);
    expect(baselineReordersArgs(undefined, ['', 'email'])).toBe(false);
  });

  it('refuses a request body it cannot represent instead of sending {}', () => {
    const input = structuredClone(spec);
    const op = input.services.flatMap((s) => s.operations).find((o) => o.name === 'authorizeDataIntegration')!;
    input.models
      .find((m) => m.name === 'AddAuthorizeDataIntegrationRequest')!
      .fields.find((f) => f.name === 'return_to')!.type = { kind: 'primitive', type: 'integer' };
    expect(() => source('Pipes', context(input))).toThrow(
      /Kotlin POST \/data-integrations\/\{slug\}\/authorize.*return_to/,
    );
    op.requestBody = { kind: 'primitive', type: 'string' };
    expect(() => source('Pipes', context(input))).toThrow(/unsupported request body \(primitive\)/);
  });
});
