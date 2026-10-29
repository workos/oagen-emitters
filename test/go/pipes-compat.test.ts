import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultSdkBehavior,
  type EmitterContext,
  type Enum,
  type Field,
  type Model,
  type Operation,
} from '@workos/oagen';
import { generateResources } from '../../src/go/resources.js';
import { generateModels } from '../../src/go/models.js';
import { generateEnums } from '../../src/go/enums.js';
import { goEmitter } from '../../src/go/index.js';

// Regressions for workos-go v10.5.0 Pipes callers that v10.6.0 broke at compile
// time. Shapes mirror the current spec (openapi-spec 4d0cf5f).

const string = { kind: 'primitive', type: 'string' } as const;
const field = (name: string, required = false): Field => ({ name, type: string, required });
const label: Field = { name: 'account_display_name', type: { kind: 'nullable', inner: string }, required: false };
const owner = (name: string): Field => ({
  name: 'connection_owner',
  type: { kind: 'enum', name, values: ['user', 'organization'] },
  required: false,
});
const intent = (value: string): Field => ({
  name: 'connection_intent',
  type: { kind: 'literal', value },
  required: true,
});

function context(models: Model[], operations: Operation[] = [], enums: Enum[] = []): EmitterContext {
  return {
    namespace: 'workos',
    namespacePascal: 'WorkOS',
    spec: {
      name: 'Pipes compatibility',
      version: '1',
      baseUrl: '',
      models,
      enums,
      services: [{ name: 'Pipes', operations }],
      sdk: defaultSdkBehavior(),
    },
  };
}

function unionOp(name: string, variants: string[], response = 'ConnectedAccountWriteResponse'): Operation {
  return {
    name,
    httpMethod: 'post',
    path: `/data-integrations/{slug}/${name}`,
    pathParams: [{ name: 'slug', type: string, required: true }],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: 'union', variants: variants.map((v) => ({ kind: 'model' as const, name: v })) },
    response: { kind: 'model', name: response },
    errors: [],
    injectIdempotencyKey: false,
  };
}

/** The `type Name struct { ... }` declaration (or the method/func) starting at `marker`. */
function block(content: string, marker: string): string {
  const start = content.indexOf(marker);
  expect(start, `missing ${marker}`).toBeGreaterThanOrEqual(0);
  return content.slice(start, content.indexOf('\n}\n', start) + 2);
}

// The authorize request: compatibility, add, and exact-account reauthorize
// branches. Each branch names its own (same-valued) owner enum.
const authorizeBase = [label, field('user_id', true), field('organization_id'), field('return_to')];
const authorizeModels: Model[] = [
  { name: 'AuthorizeRequest', fields: [...authorizeBase, owner('AuthorizeRequestConnectionOwner')] },
  {
    name: 'AddAuthorizeRequest',
    fields: [...authorizeBase, owner('AddAuthorizeRequestConnectionOwner'), intent('add')],
  },
  {
    name: 'ReauthorizeAuthorizeRequest',
    fields: [
      ...authorizeBase,
      owner('ReauthorizeAuthorizeRequestConnectionOwner'),
      intent('reauthorize'),
      field('connected_account_id', true),
    ],
  },
  { name: 'DataIntegrationAuthorizeURLResponse', fields: [field('url', true)] },
];

describe('Go Pipes compatibility', () => {
  describe('object-union request bodies keep typed params fields (fix 1)', () => {
    const ctx = context(authorizeModels, [
      unionOp(
        'authorizeDataIntegration',
        ['AuthorizeRequest', 'AddAuthorizeRequest', 'ReauthorizeAuthorizeRequest'],
        'DataIntegrationAuthorizeURLResponse',
      ),
    ]);
    const content = generateResources(ctx.spec.services, ctx)[0].content;

    it('restores the v10.5.0 fields with their JSON tags next to Body', () => {
      const struct = block(content, 'type PipesAuthorizeDataIntegrationParams struct');
      const fields = struct
        .split('\n')
        .filter((l) => l.startsWith('\t') && !l.trim().startsWith('//'))
        .map((l) => l.trim());
      expect(fields).toEqual([
        'AccountDisplayName *string `json:"account_display_name,omitempty" url:"-"`',
        // Required in every branch -> a value without omitempty, as in v10.5.0.
        'UserID string `json:"user_id" url:"-"`',
        'OrganizationID *string `json:"organization_id,omitempty" url:"-"`',
        'ReturnTo *string `json:"return_to,omitempty" url:"-"`',
        // Same-valued branch enums merge onto the first branch's type.
        'ConnectionOwner *AuthorizeRequestConnectionOwner `json:"connection_owner,omitempty" url:"-"`',
        // Branch-only requirements stay optional; the two intent literals merge.
        'ConnectionIntent *string `json:"connection_intent,omitempty" url:"-"`',
        'ConnectedAccountID *string `json:"connected_account_id,omitempty" url:"-"`',
        'Body interface{} `json:"-"`',
      ]);
    });

    it('builds the request body from the params, sending Body as-is and rejecting a mix', () => {
      const method = block(content, 'func (s *PipeService) AuthorizeDataIntegration(');
      expect(method).toContain('"POST", fmt.Sprintf("/data-integrations/%s/authorizeDataIntegration"');
      expect(method).toContain(', nil, params, &result, opts)');
      expect(method).not.toContain('params.Body');

      const marshal = block(content, 'func (p PipesAuthorizeDataIntegrationParams) MarshalJSON()');
      expect(marshal).toContain(
        [
          '\tif p.Body != nil {',
          '\t\tbody := p.Body',
          '\t\tp.Body = nil',
          '\t\tif !reflect.ValueOf(p).IsZero() {',
          '\t\t\treturn nil, fmt.Errorf("PipesAuthorizeDataIntegrationParams: set either Body or the individual body fields, not both")',
          '\t\t}',
          '\t\treturn json.Marshal(body)',
          '\t}',
          '\ttype Alias PipesAuthorizeDataIntegrationParams',
          '\treturn json.Marshal(Alias(p))',
          '}',
        ].join('\n'),
      );
      expect(content).toMatch(/import \(\n\t"context"\n\t"encoding\/json"\n\t"fmt"\n\t"net\/url"\n\t"reflect"\n\)/);
    });

    it('keeps the API key params comparable, as in v10.5.0: no NullFields, slices, or maps', () => {
      const base = [
        label,
        { ...label, name: 'account_identifier' },
        field('user_id', true),
        field('organization_id'),
        owner('UpsertAPIKeyRequestConnectionOwner'),
        field('secret', true),
      ];
      const ctx = context(
        [
          { name: 'UpsertAPIKeyRequest', fields: base },
          {
            name: 'ReauthorizeUpsertAPIKeyRequest',
            fields: [...base, intent('reauthorize'), field('connected_account_id', true)],
          },
        ],
        [unionOp('updateDataIntegrationApiKey', ['UpsertAPIKeyRequest', 'ReauthorizeUpsertAPIKeyRequest'])],
      );
      const content = generateResources(ctx.spec.services, ctx)[0].content;
      const struct = block(content, 'type PipesUpdateDataIntegrationAPIKeyParams struct');
      expect(struct).toContain('\tAccountIdentifier *string `json:"account_identifier,omitempty" url:"-"`\n');
      expect(struct).not.toContain('NullFields');
      expect(struct).not.toMatch(/^\t\w+ (\[\]|map\[)/m);
      // Clearing a label goes through Body, which is marshaled untouched, so
      // Body: map[string]any{"account_display_name": nil} still sends JSON null.
      const marshal = block(content, 'func (p PipesUpdateDataIntegrationAPIKeyParams) MarshalJSON()');
      expect(marshal).toContain('\t\tbody := p.Body\n\t\tp.Body = nil\n');
      expect(marshal).toContain('\t\treturn json.Marshal(body)\n');
    });

    it('keeps the Body-only struct for unions that do not flatten unambiguously', () => {
      const ctx = context(
        [
          { name: 'A', fields: [field('user_id', true)] },
          { name: 'B', fields: [{ name: 'user_id', type: { kind: 'primitive', type: 'integer' }, required: true }] },
        ],
        [unionOp('updateApiKey', ['A', 'B'])],
      );
      const content = generateResources(ctx.spec.services, ctx)[0].content;
      expect(block(content, 'type PipesUpdateAPIKeyParams struct')).toBe(
        'type PipesUpdateAPIKeyParams struct {\n\tBody interface{} `json:"-"`\n}',
      );
      expect(content).toContain(', nil, params.Body, &result, opts)');
      expect(content).not.toContain('"reflect"');
    });
  });

  describe('connected-account write methods keep returning ConnectedAccount (fix 2)', () => {
    const accountFields: Field[] = [
      field('id', true),
      {
        name: 'connection_role',
        type: { kind: 'enum', name: 'ConnectedAccountConnectionRole', values: ['a', 'b'] },
        required: true,
      },
      label,
    ];
    const warnings: Field = {
      name: 'warnings',
      type: { kind: 'array', items: { kind: 'model', name: 'ConnectedAccountWriteResponseWarning' } },
      required: false,
    };
    const writeResponse = (extra: Field): Model => ({
      name: 'ConnectedAccountWriteResponse',
      fields: [
        field('id', true),
        // The write response names its own same-valued enum.
        {
          name: 'connection_role',
          type: { kind: 'enum', name: 'ConnectedAccountWriteResponseConnectionRole', values: ['b', 'a'] },
          required: true,
        },
        label,
        extra,
      ],
    });
    const models = (extra: Field): Model[] => [
      { name: 'ConnectedAccount', fields: accountFields },
      writeResponse(extra),
      { name: 'ConnectedAccountWriteResponseWarning', fields: [field('code', true), field('message', true)] },
    ];

    it('aliases ConnectedAccountWriteResponse to ConnectedAccount, which gains Warnings', () => {
      const ctx = context(models(warnings), [{ ...unionOp('updateApiKey', []), requestBody: undefined }]);
      const content = generateModels(ctx.spec.models, ctx)[0].content;
      expect(content).toContain(
        '// ConnectedAccountWriteResponse is an alias for ConnectedAccount.\ntype ConnectedAccountWriteResponse = ConnectedAccount\n',
      );
      expect(block(content, 'type ConnectedAccount struct')).toContain(
        '\tWarnings []*ConnectedAccountWriteResponseWarning `json:"warnings,omitempty"`\n}',
      );
      expect(content).not.toContain('type ConnectedAccountWriteResponse struct');
      // The methods keep naming the write response, which is now the same type.
      const resources = generateResources(ctx.spec.services, ctx)[0].content;
      expect(resources).toContain('opts ...RequestOption) (*ConnectedAccountWriteResponse, error) {');
    });

    it('skips the fold when the write response is no longer a superset with optional extras', () => {
      const ctx = context(models({ ...warnings, required: true }));
      const content = generateModels(ctx.spec.models, ctx)[0].content;
      expect(content).toContain('type ConnectedAccountWriteResponse struct');
      expect(content).not.toContain('= ConnectedAccount\n');
      expect(block(content, 'type ConnectedAccount struct')).not.toContain('Warnings');
    });
  });

  describe('vended credential keeps its v10.5.0 name and value fields (fix 3)', () => {
    let dir: string;
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
    const spec = {
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
          // Another discriminated oneOf: not in the compat table, so left as v10.6.0 emitted it.
          OtherDiscriminated: {
            discriminator: { propertyName: 'kind' },
            oneOf: [
              { type: 'object', properties: { kind: { const: 'a' } }, required: ['kind'] },
              { type: 'object', properties: { kind: { const: 'b' } }, required: ['kind'] },
            ],
          },
          // Undiscriminated oneOf: v10.5.0 already exposed `Active *bool`.
          DataIntegrationCredentialsResponse: {
            oneOf: [
              { type: 'object', properties: { active: { const: true } }, required: ['active'] },
              { type: 'object', properties: { active: { const: false } }, required: ['active'] },
            ],
          },
        },
      },
    };

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'go-pipes-compat-'));
      writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec));
      process.env.OPENAPI_SPEC_PATH = join(dir, 'spec.json');
    });
    afterAll(() => {
      delete process.env.OPENAPI_SPEC_PATH;
      rmSync(dir, { recursive: true, force: true });
    });

    it('restores the v10.5.0 value fields on the credential only, and the old name', () => {
      // The parser merges the variants into one model with every field optional.
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
        { name: 'OtherDiscriminated', fields: [field('kind')] },
        {
          name: 'DataIntegrationCredentialsResponse',
          fields: [
            { name: 'active', type: { kind: 'literal', value: true }, required: false },
            { name: 'credential', type: { kind: 'model', name: 'DataIntegrationVendedCredential' }, required: false },
          ],
        },
      ];
      const ctx = context(models);
      const content = goEmitter.generateModels(models, ctx)[0].content;
      const struct = block(content, 'type DataIntegrationVendedCredential struct');
      expect(struct).toContain('\tObject string `json:"object"`\n');
      expect(struct).toContain('\tAuthMethod string `json:"auth_method"`\n');
      expect(struct).toContain('\tValue string `json:"value"`\n');
      // Required by only one variant: still optional.
      expect(struct).toContain('\tExpiresAt *string `json:"expires_at,omitempty"`\n');
      // Required by every variant but not a v10.5.0 value field: unchanged.
      expect(struct).toContain('\tConfig map[string]string `json:"config,omitempty"`\n');
      expect(block(content, 'type OtherDiscriminated struct')).toContain('\tKind *string `json:"kind,omitempty"`\n');
      expect(content).toContain(
        '// DataIntegrationCredentialsResponseCredential is an alias for DataIntegrationVendedCredential.\n' +
          'type DataIntegrationCredentialsResponseCredential = DataIntegrationVendedCredential\n',
      );
      const response = block(content, 'type DataIntegrationCredentialsResponse struct');
      expect(response).toContain('\tActive *bool `json:"active,omitempty"`\n');
      expect(response).toContain('\tCredential *DataIntegrationVendedCredential `json:"credential,omitempty"`\n');
    });
  });

  describe('deduplicated enums keep their v10.5.0 constants (fix 4)', () => {
    const values = (...v: string[]) => v.map((value) => ({ name: value.toUpperCase(), value }));
    const enums: Enum[] = [
      // Sorts first, so it became the dedup canonical in v10.6.0.
      { name: 'AddAuthorizeRequestConnectionOwner', values: values('user', 'organization') },
      { name: 'CreateDataIntegrationOwnership', values: values('user', 'organization') },
      { name: 'DataIntegrationOwnership', values: values('user', 'organization') },
      { name: 'AgentBlueprintCreatedDataInvocableAsInstanceTypes', values: values('delegated', 'autonomous') },
      { name: 'AgentInstanceCreatedDataType', values: values('delegated', 'autonomous') },
    ];
    const content = generateEnums(enums, context([], [], enums))[0].content;

    it('emits the old constants on the alias and keeps the canonical ones', () => {
      expect(content).toContain(
        [
          'type CreateDataIntegrationOwnership = AddAuthorizeRequestConnectionOwner',
          '',
          'const (',
          '\tCreateDataIntegrationOwnershipUser CreateDataIntegrationOwnership = "user"',
          '\tCreateDataIntegrationOwnershipOrganization CreateDataIntegrationOwnership = "organization"',
          ')',
        ].join('\n'),
      );
      expect(content).toContain(
        [
          'type AgentInstanceCreatedDataType = AgentBlueprintCreatedDataInvocableAsInstanceTypes',
          '',
          'const (',
          '\tAgentInstanceCreatedDataTypeDelegated AgentInstanceCreatedDataType = "delegated"',
          '\tAgentInstanceCreatedDataTypeAutonomous AgentInstanceCreatedDataType = "autonomous"',
          ')',
        ].join('\n'),
      );
      expect(content).toContain('\tAddAuthorizeRequestConnectionOwnerUser AddAuthorizeRequestConnectionOwner = "user"');
      // Other aliases stay constant-free.
      expect(content).toContain('type DataIntegrationOwnership = AddAuthorizeRequestConnectionOwner\n\n//');
      expect(content).not.toMatch(/\tDataIntegrationOwnershipUser/);
    });
  });
});
