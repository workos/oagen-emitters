import { describe, it, expect } from 'vitest';
import { generateModels } from '../../src/python/models.js';
import { computeSchemaPlacement } from '../../src/python/shared-schemas.js';
import type { EmitterContext, ApiSpec, Model, Service } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';

const str = { kind: 'primitive', type: 'string' } as const;

// `CredentialsResponse` is a named union: the operation's primary response
// names it, and it names its two members only as variants. `VendedCredential`
// is a field of both the union and its `WithCredential` member.
// `NotFoundErrorBody` is reached only through an error response.
const models: Model[] = [
  {
    name: 'CredentialsResponse',
    fields: [{ name: 'credential', type: { kind: 'model', name: 'VendedCredential' }, required: false }],
    variants: [
      { kind: 'model', name: 'CredentialsResponseWithCredential' },
      { kind: 'model', name: 'CredentialsResponseWithError' },
    ],
    compositionKind: 'oneOf',
  } as Model,
  {
    name: 'CredentialsResponseWithCredential',
    fields: [{ name: 'credential', type: { kind: 'model', name: 'VendedCredential' }, required: true }],
  },
  { name: 'CredentialsResponseWithError', fields: [{ name: 'error', type: str, required: true }] },
  { name: 'VendedCredential', fields: [{ name: 'token', type: str, required: true }] },
  { name: 'NotFoundErrorBody', fields: [{ name: 'message', type: str, required: true }] },
  { name: 'Directory', fields: [{ name: 'id', type: str, required: true }] },
];

const services: Service[] = [
  {
    name: 'Directories',
    operations: [
      {
        name: 'getDirectory',
        httpMethod: 'get',
        path: '/directories/{id}',
        pathParams: [{ name: 'id', type: str, required: true }],
        queryParams: [],
        headerParams: [],
        response: { kind: 'model', name: 'Directory' },
        errors: [],
        injectIdempotencyKey: false,
      },
    ],
  },
  {
    name: 'Pipes',
    operations: [
      {
        name: 'getCredentials',
        httpMethod: 'get',
        path: '/pipes/{id}/credentials',
        pathParams: [{ name: 'id', type: str, required: true }],
        queryParams: [],
        headerParams: [],
        response: { kind: 'model', name: 'CredentialsResponse' },
        errors: [{ statusCode: 404, type: { kind: 'model', name: 'NotFoundErrorBody' } }],
        injectIdempotencyKey: false,
      },
    ],
  },
];

const spec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: '',
  services,
  models,
  enums: [],
  sdk: defaultSdkBehavior(),
};
const ctx: EmitterContext = { namespace: 'workos', namespacePascal: 'WorkOS', spec };

const common = (file: string) => `src/workos/common/models/${file}.py`;
const pipes = (file: string) => `src/workos/pipes/models/${file}.py`;
const pipesBarrel = 'src/workos/pipes/models/__init__.py';
const vendedReExport = 'from workos.common.models.vended_credential import VendedCredential as VendedCredential';

describe('python common/ placement', () => {
  it('gives a model reached only through an error body or a union variant no natural service', () => {
    const { originalModelToService, modelToService, relocatedModels } = computeSchemaPlacement(spec, ctx);

    expect(originalModelToService.get('CredentialsResponse')).toBe('Pipes');
    expect(originalModelToService.has('NotFoundErrorBody')).toBe(false);
    expect(originalModelToService.has('CredentialsResponseWithCredential')).toBe(false);
    expect(originalModelToService.has('CredentialsResponseWithError')).toBe(false);

    // A field of the union gives `VendedCredential` a natural service, and the
    // common/-bound union member that also holds it pulls it into common/.
    expect(originalModelToService.get('VendedCredential')).toBe('Pipes');
    expect(modelToService.has('VendedCredential')).toBe(false);
    expect(relocatedModels.has('VendedCredential')).toBe(true);
  });

  it('writes those models under common/ and re-exports the relocated one from its service barrel', () => {
    const files = generateModels(models, ctx);
    const paths = new Set(files.map((f) => f.path));

    for (const file of [
      'not_found_error_body',
      'credentials_response_with_credential',
      'credentials_response_with_error',
      'vended_credential',
    ]) {
      expect(paths.has(common(file))).toBe(true);
      expect(paths.has(pipes(file))).toBe(false);
    }
    expect(paths.has(pipes('credentials_response'))).toBe(true);
    expect(files.find((f) => f.path === pipesBarrel)!.content).toContain(vendedReExport);
  });

  it('keeps the service barrel re-export when a scoped run leaves that service out', () => {
    const onDisk = generateModels(models, ctx)
      .map((f) => f.path)
      .filter((path) => path.endsWith('.py'));
    const scopedCtx = {
      ...ctx,
      scopedServices: new Set(['Directories']),
      scopedModelNames: new Set(['Directory']),
      scopedEnumNames: new Set<string>(),
      priorTargetManifestPaths: new Set(onDisk),
    } as EmitterContext;

    const files = generateModels(models, scopedCtx);
    const written = files.filter((f) => !f.path.endsWith('__init__.py')).map((f) => f.path);
    expect(written).toEqual(['src/workos/directories/models/directory.py']);

    // The barrels are rebuilt from the full set, so the out-of-scope names a
    // file the run did not regenerate still imports must survive by name.
    expect(files.find((f) => f.path === pipesBarrel)!.content).toContain(vendedReExport);
    expect(files.find((f) => f.path === 'src/workos/common/models/__init__.py')!.content).toContain(
      'from .vended_credential import VendedCredential as VendedCredential',
    );
  });
});
