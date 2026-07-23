import type { ApiSpec, EmitterContext, Service, Operation, ResolvedOperation } from '@workos/oagen';
import { defaultSdkBehavior, toSnakeCase, toPascalCase } from '@workos/oagen';

export function makeSpec(overrides: Partial<ApiSpec> = {}): ApiSpec {
  return {
    name: 'Test',
    version: '1.0.0',
    baseUrl: 'https://api.example.com',
    services: [],
    models: [],
    enums: [],
    sdk: defaultSdkBehavior(),
    ...overrides,
  };
}

/** Build resolvedOperations from services so groupByMount works. */
export function buildResolvedOps(services: Service[]): ResolvedOperation[] {
  const ops: ResolvedOperation[] = [];
  for (const service of services) {
    const mountOn = toPascalCase(service.name);
    for (const op of service.operations) {
      ops.push({
        operation: op,
        service,
        methodName: toSnakeCase(op.name),
        mountOn,
        defaults: {},
        inferFromClient: [],
        urlBuilder: false,
      });
    }
  }
  return ops;
}

export function makeCtx(spec: ApiSpec): EmitterContext {
  return {
    namespace: 'acme',
    namespacePascal: 'Acme',
    spec,
    resolvedOperations: buildResolvedOps(spec.services),
  };
}

export function makeOp(overrides: Partial<Operation> = {}): Operation {
  return {
    name: 'listOrganizations',
    httpMethod: 'get',
    path: '/organizations',
    pathParams: [],
    queryParams: [],
    headerParams: [],
    requestBody: undefined,
    response: { kind: 'model', name: 'Organization' },
    errors: [],
    injectIdempotencyKey: false,
    ...overrides,
  };
}
