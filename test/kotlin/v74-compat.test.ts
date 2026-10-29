import { beforeAll, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { parseSpec, type ApiSpec, type EmitterContext, type Model } from '@workos/oagen';
import { generateResources } from '../../src/kotlin/resources.js';
import { generateModels } from '../../src/kotlin/models.js';
import { generateEnums } from '../../src/kotlin/enums.js';
import { generateTests } from '../../src/kotlin/tests.js';
import { V74_METHOD_SLOTS } from '../../src/kotlin/v74-compat.js';

const MOUNTS: Record<string, string> = {
  DataIntegrations: 'Pipes',
  UserManagement: 'Pipes',
  Organizations: 'Pipes',
  SSO: 'SSO',
  AdminPortal: 'AdminPortal',
  Agents: 'Agents',
};

let spec: ApiSpec;
beforeAll(async () => {
  spec = await parseSpec(resolve('test/fixtures/kotlin-v74-compat.yaml'));
});

function context(input: ApiSpec = spec): EmitterContext {
  const ctx: EmitterContext = {
    namespace: 'workos',
    namespacePascal: 'WorkOS',
    spec: input,
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

/** Parameter slots of the blocking method, `?` marking defaulted ones (the table's notation). */
function slots(src: string, method: string): string[] {
  const params = declaration(src, method).split(`fun ${method}(`)[1];
  return [...params.matchAll(/^ {4}(\w+): ([^\n]*?),?$/gm)].map(([, name, rest]) =>
    rest.includes(' = ') ? `${name}?` : name,
  );
}

function withoutField(input: ApiSpec, model: string, field: string): ApiSpec {
  const copy = structuredClone(input);
  const m = copy.models.find((x) => x.name === model)!;
  m.fields = m.fields.filter((f) => f.name !== field);
  return copy;
}

describe('kotlin v7.4.0 compatibility', () => {
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

  it('restores the v7.4.0 slots of every table entry and appends newer parameters after them', () => {
    const ctx = context();
    for (const [key, expected] of Object.entries(V74_METHOD_SLOTS)) {
      const [cls, method] = key.split('.');
      const actual = slots(source(cls, ctx), method);
      expect(actual.slice(0, expected.length), key).toEqual(expected);
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
  });

  it('restores positional generateLink intent and blueprint session settings slots', () => {
    const ctx = context();
    const link = declaration(source('AdminPortal', ctx), 'generateLink');
    expect(link).toMatch(/successUrl: String\? = null,\n {4}intent: \w+\? = null,\n {4}itContactEmails:/);
    expect(link).toMatch(/requestOptions: RequestOptions\? = null,\n {4}externalUserId: String\? = null/);
    const agents = source('Agents', ctx);
    expect(declaration(agents, 'createBlueprint')).toMatch(
      /invocableBy: \w+\? = null,\n {4}sessionSettings: \w+\? = null,\n {4}requestOptions: RequestOptions\? = null,\n {4}invocableAs:/,
    );
    expect(declaration(agents, 'updateBlueprint')).toMatch(
      /invocableBy: PatchField<\w+> = PatchField.Absent,\n {4}sessionSettings: PatchField<\w+> = PatchField.Absent,\n {4}requestOptions: RequestOptions\? = null,\n {4}invocableAs:/,
    );
  });

  it('never lets the newly required userId capture an old positional argument, from Kotlin or Java', () => {
    const pipes = source('Pipes');
    for (const method of ['createOrganizationConnectedAccount', 'updateOrganizationConnectedAccount']) {
      const decl = declaration(pipes, method);
      const params = slots(pipes, method);
      // Required userId sits after every v7.4.0 slot, so an old positional call fails to compile...
      expect(params.indexOf('userId')).toBe(V74_METHOD_SLOTS[`Pipes.${method}`].length);
      // ...and without @JvmOverloads, Java gets no short overload where userId fills an old slot.
      expect(decl).not.toContain('@JvmOverloads');
    }
    // Methods whose required parameters all lead keep their Java overloads.
    expect(declaration(pipes, 'createUserConnectedAccount')).toContain('@JvmOverloads');
    expect(declaration(pipes, 'authorizeDataIntegration')).toContain('@JvmOverloads');
  });

  it('skips an entry whose shape changed instead of pinning a stale signature', () => {
    // A v7.4.0 slot no longer exists: fall back to the emitter's normal order.
    const removed = slots(
      source('SSO', context(withoutField(spec, 'GetProfileAndTokenRequest', 'subject_token'))),
      'getProfileAndToken',
    );
    expect(removed).toEqual(['code?', 'codeVerifier?', 'subjectTokenType?', 'organizationId?', 'requestOptions?']);
    // A v7.4.0 slot changed requiredness.
    const required = structuredClone(spec);
    required.models
      .find((m) => m.name === 'GenerateLinkRequest')!
      .fields.find((f) => f.name === 'intent')!.required = true;
    expect(slots(source('AdminPortal', context(required)), 'generateLink').slice(0, 3)).toEqual([
      'organization',
      'intent',
      'returnUrl?',
    ]);
  });

  it('keeps ConnectedAccountWriteResponse as a typealias of ConnectedAccount with readable warnings', () => {
    const files = generateModels(spec.models, context());
    const file = (name: string) => files.find((f) => f.path.endsWith(`/models/${name}.kt`))?.content;
    expect(file('ConnectedAccountWriteResponse')).toContain(
      'typealias ConnectedAccountWriteResponse = ConnectedAccount',
    );
    expect(file('ConnectedAccount')).toMatch(
      /@JsonProperty\("warnings"\)\n {2}val warnings: List<ConnectedAccountWriteResponseWarning>\? = null\n\)/,
    );
    expect(file('ConnectedAccountWriteResponseWarning')).toContain('data class ConnectedAccountWriteResponseWarning(');
    expect(file('DataIntegrationCredentialsResponseCredential')).toContain(
      'typealias DataIntegrationCredentialsResponseCredential = DataIntegrationVendedCredential',
    );
    // Write methods still compile against either name.
    expect(source('Pipes')).toContain('ConnectedAccountWriteResponse::class.java');
  });

  it('does not fold a write response that gained a required field', () => {
    const input = structuredClone(spec);
    input.models
      .find((m) => m.name === 'ConnectedAccountWriteResponse')!
      .fields.push({ name: 'etag', type: { kind: 'primitive', type: 'string' }, required: true });
    const files = generateModels(input.models, context(input));
    const file = (name: string) => files.find((f) => f.path.endsWith(`/models/${name}.kt`))!.content;
    expect(file('ConnectedAccountWriteResponse')).toContain('data class ConnectedAccountWriteResponse(');
    expect(file('ConnectedAccount')).not.toContain('warnings');
  });

  it('pins the upsert API key request constructor so an old positional connected-account id cannot compile', () => {
    const model: Model = {
      name: 'DataIntegrationsUpsertApiKeyRequest',
      fields: [
        {
          name: 'account_display_name',
          type: { kind: 'nullable', inner: { kind: 'primitive', type: 'string' } },
          required: false,
        },
        {
          name: 'account_identifier',
          type: { kind: 'nullable', inner: { kind: 'primitive', type: 'string' } },
          required: false,
        },
        { name: 'user_id', type: { kind: 'primitive', type: 'string' }, required: true },
        { name: 'organization_id', type: { kind: 'primitive', type: 'string' }, required: false },
        {
          name: 'connection_owner',
          type: { kind: 'enum', name: 'Owner', values: ['user', 'organization'] },
          required: false,
        },
        { name: 'secret', type: { kind: 'primitive', type: 'string' }, required: true },
      ],
    };
    const ctorSlots = (m: Model) => {
      const content = generateModels([m], context({ ...spec, models: [m] }))[0].content;
      return [...content.matchAll(/^ {2}val (\w+): (\S+)/gm)].map(([, name, type]) => `${name}: ${type}`);
    };
    // v7.4.0: (userId, secret, organizationId, connectedAccountId, connectionOwner). Slot 4 is now an enum.
    expect(ctorSlots(model)).toEqual([
      'userId: String,',
      'secret: String,',
      'organizationId: String?',
      'connectionOwner: Owner?',
      'accountDisplayName: String?',
      'accountIdentifier: String?',
    ]);
    // Shape changed (organization_id gone): the entry is skipped.
    const changed = { ...model, fields: model.fields.filter((f) => f.name !== 'organization_id') };
    expect(ctorSlots(changed).slice(0, 3)).toEqual([
      'userId: String,',
      'secret: String,',
      'accountDisplayName: String?',
    ]);
  });

  it('calls pinned methods by name in generated tests and asserts the projected body fields', () => {
    const ctx = context();
    const pipesTest = generateTests(spec, ctx).find((f) => f.path.endsWith('/PipesTest.kt'))!.content;
    expect(pipesTest).toContain('api().authorizeDataIntegration(slug = "sample-arg", userId = "sample-arg")');
    expect(pipesTest).toContain(
      'api().createOrganizationConnectedAccount(organizationId = "sample-arg", slug = "sample-arg", userId = "sample-arg")',
    );
    expect(pipesTest).toMatch(/matchingJsonPath\("\\\$\.secret"\)/);
  });

  it('refuses a request body it cannot represent instead of sending {}', () => {
    const input = structuredClone(spec);
    const op = input.services.flatMap((s) => s.operations).find((o) => o.name === 'authorizeDataIntegration')!;
    input.models
      .find((m) => m.name === 'AddAuthorizeDataIntegrationRequest')!
      .fields.find((f) => f.name === 'return_to')!.type = { kind: 'primitive', type: 'integer' };
    expect(() => source('Pipes', context(input))).toThrow(/POST \/data-integrations\/\{slug\}\/authorize.*return_to/);
    op.requestBody = { kind: 'primitive', type: 'string' };
    expect(() => source('Pipes', context(input))).toThrow(/unsupported request body \(primitive\)/);
  });
});
