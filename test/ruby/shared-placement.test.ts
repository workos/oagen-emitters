import { describe, it, expect } from 'vitest';
import { generateModels } from '../../src/ruby/models.js';
import type { EmitterContext, ApiSpec, Model, Service } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';

const str = { kind: 'primitive', type: 'string' } as const;

// `Failure` is reached only through an error response, by a service that
// sorts ahead of the one a scoped run selects.
const models: Model[] = [
  { name: 'Agent', fields: [{ name: 'id', type: str, required: true }] },
  { name: 'Directory', fields: [{ name: 'id', type: str, required: true }] },
  { name: 'Failure', fields: [{ name: 'message', type: str, required: true }] },
];

const get = (name: string, path: string, response: string): Service['operations'][number] => ({
  name,
  httpMethod: 'get',
  path,
  pathParams: [{ name: 'id', type: str, required: true }],
  queryParams: [],
  headerParams: [],
  response: { kind: 'model', name: response },
  errors: [{ statusCode: 404, type: { kind: 'model', name: 'Failure' } }],
  injectIdempotencyKey: false,
});
const services: Service[] = [
  { name: 'Agents', operations: [get('getAgent', '/agents/{id}', 'Agent')] },
  { name: 'Directories', operations: [get('getDirectory', '/directories/{id}', 'Directory')] },
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

const failureFiles = (files: { path: string }[]) =>
  files.map((f) => f.path).filter((path) => path.endsWith('/failure.rb'));

describe('ruby shared/ placement', () => {
  it('keeps a model reached only through an error body in shared/', () => {
    const files = generateModels(models, ctx);
    const paths = files.map((f) => f.path);

    expect(paths).toContain('lib/workos/agents/agent.rb');
    expect(paths).toContain('lib/workos/directories/directory.rb');
    expect(failureFiles(files)).toEqual(['lib/workos/shared/failure.rb']);
  });

  it('rewrites that model in place on a scoped run, never as a second file for its constant', () => {
    const scopedCtx = {
      ...ctx,
      scopedServices: new Set(['Directories']),
      scopedModelNames: new Set(['Directory', 'Failure']),
      scopedEnumNames: new Set<string>(),
      priorTargetManifestPaths: new Set(generateModels(models, ctx).map((f) => f.path)),
    } as EmitterContext;

    // Every model directory collapses into `WorkOS::`, and a scoped run prunes
    // nothing: a copy under the first referencing service's directory would
    // sit beside the one already on disk in shared/.
    expect(failureFiles(generateModels(models, scopedCtx))).toEqual(['lib/workos/shared/failure.rb']);
  });
});
