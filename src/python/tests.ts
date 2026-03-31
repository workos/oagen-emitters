import type { ApiSpec, Service, Operation, EmitterContext, GeneratedFile, TypeRef } from '@workos/oagen';
import { planOperation, toSnakeCase, assignModelsToServices } from '@workos/oagen';
import { className, fileName, fieldName, resolveMethodName, buildServiceDirMap, dirToModule } from './naming.js';
import { groupServicesByNamespace } from './client.js';
import { resolveResourceClassName, bodyParamName } from './resources.js';
import { buildServiceAccessPaths } from './client.js';
import { generateFixtures, generateModelFixture } from './fixtures.js';
import { isListWrapperModel, isListMetadataModel } from './models.js';
import { assignEnumsToServices } from './enums.js';

/** Check if an operation is a redirect endpoint (same logic as resources.ts). */
function isRedirectEndpoint(op: Operation): boolean {
  if (op.successResponses?.some((r) => r.statusCode >= 300 && r.statusCode < 400)) return true;
  if (
    op.httpMethod === 'get' &&
    op.response.kind === 'primitive' &&
    (op.response as any).type === 'unknown' &&
    op.queryParams.length > 0
  ) {
    return true;
  }
  return false;
}

/**
 * Generate pytest test files and JSON fixtures for the Python SDK.
 */
export function generateTests(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  // Generate fixture JSON files
  const fixtures = generateFixtures(spec);
  for (const fixture of fixtures) {
    files.push({
      path: fixture.path,
      content: fixture.content,
      headerPlacement: 'skip',
      integrateTarget: true,
      overwriteExisting: true,
    });
  }

  // Generate conftest and helpers
  files.push(...generateConftest(ctx));

  // Build access path map for all services
  const accessPaths = buildServiceAccessPaths(spec.services, ctx);

  // Generate per-service test files
  for (const service of spec.services) {
    const testFile = generateServiceTest(service, spec, ctx, accessPaths);
    if (testFile) files.push(testFile);
  }

  // Generate model round-trip tests (P3-7)
  const modelTests = generateModelRoundTripTests(spec, ctx);
  if (modelTests) files.push(modelTests);

  // Generate client tests (P3-7)
  files.push(generateClientTests(spec, ctx, accessPaths));

  // Generate pagination tests (P3-7)
  files.push(generatePaginationTests(ctx));

  return files;
}

function generateConftest(ctx: EmitterContext): GeneratedFile[] {
  // Helper module for test utilities (load_fixture) — avoids conflicting with
  // hand-written conftest.py while remaining importable by generated tests.
  const helperLines: string[] = [];
  helperLines.push('import json');
  helperLines.push('import os');
  helperLines.push('');
  helperLines.push('');
  helperLines.push('FIXTURES_DIR = os.path.join(os.path.dirname(__file__), "fixtures")');
  helperLines.push('');
  helperLines.push('');
  helperLines.push('def load_fixture(name: str) -> dict:');
  helperLines.push('    """Load a JSON fixture file by name."""');
  helperLines.push('    path = os.path.join(FIXTURES_DIR, name)');
  helperLines.push('    with open(path) as f:');
  helperLines.push('        return json.load(f)');

  // conftest.py with pytest fixtures — merged additively into existing conftest
  const conftestLines: string[] = [];
  conftestLines.push('import pytest');
  conftestLines.push('');
  conftestLines.push(`from ${ctx.namespace} import WorkOS, AsyncWorkOS`);
  conftestLines.push('');
  conftestLines.push('');
  conftestLines.push('@pytest.fixture');
  conftestLines.push('def workos():');
  conftestLines.push('    """Create a WorkOS client for testing."""');
  conftestLines.push('    return WorkOS(api_key="sk_test_Sz3IQjepeSWaI4cMS4ms4sMuU", client_id="client_test")');
  conftestLines.push('');
  conftestLines.push('');
  conftestLines.push('@pytest.fixture');
  conftestLines.push('def async_workos():');
  conftestLines.push('    """Create an AsyncWorkOS client for testing."""');
  conftestLines.push('    return AsyncWorkOS(api_key="sk_test_Sz3IQjepeSWaI4cMS4ms4sMuU", client_id="client_test")');

  return [
    {
      path: 'tests/generated_helpers.py',
      content: helperLines.join('\n'),
      integrateTarget: true,
      overwriteExisting: true,
    },
    {
      path: 'tests/conftest.py',
      content: conftestLines.join('\n'),
      integrateTarget: true,
      overwriteExisting: true,
    },
  ];
}

function generateServiceTest(
  service: Service,
  spec: ApiSpec,
  ctx: EmitterContext,
  accessPaths: Map<string, string>,
): GeneratedFile | null {
  if (service.operations.length === 0) return null;

  const resolvedName = resolveResourceClassName(service, ctx);
  const propName = accessPaths.get(service.name) ?? toSnakeCase(resolvedName);

  const lines: string[] = [];

  lines.push('import json');
  lines.push('');
  lines.push('import pytest');
  lines.push(`from ${ctx.namespace} import WorkOS`);
  lines.push('from tests.generated_helpers import load_fixture');
  lines.push('');

  // Collect model and enum imports needed (response models, body field models, and enum params)
  const modelImports = new Set<string>();
  const enumImports = new Set<string>();
  for (const op of service.operations) {
    const plan = planOperation(op);
    if (plan.responseModelName) modelImports.add(plan.responseModelName);
    if (op.pagination?.itemType.kind === 'model') {
      modelImports.add(op.pagination.itemType.name);
    }
    // Collect model-typed and enum-typed body fields (used as method arguments)
    if (plan.hasBody && op.requestBody?.kind === 'model') {
      const bodyModel = spec.models.find((m) => m.name === (op.requestBody as any).name);
      if (bodyModel) {
        for (const f of bodyModel.fields) {
          if (f.type.kind === 'model') modelImports.add(f.type.name);
          if (f.type.kind === 'nullable' && f.type.inner.kind === 'model') modelImports.add(f.type.inner.name);
          if (f.type.kind === 'array' && f.type.items.kind === 'model') modelImports.add(f.type.items.name);
          if (f.type.kind === 'enum') enumImports.add(f.type.name);
          if (f.type.kind === 'nullable' && f.type.inner.kind === 'enum') enumImports.add(f.type.inner.name);
        }
      }
    }
    // Collect enum-typed query params
    for (const param of op.queryParams) {
      if (param.type.kind === 'enum') enumImports.add(param.type.name);
      if (param.type.kind === 'nullable' && param.type.inner.kind === 'enum') enumImports.add(param.type.inner.name);
    }
  }

  // Filter out list wrapper models
  const actualImports = [...modelImports].filter((name) => {
    const model = spec.models.find((m) => m.name === name);
    if (!model) return true;
    return !isListWrapperModel(model);
  });

  // Group imports by their actual service directory (models may live in different services)
  const modelToServiceMap = assignModelsToServices(spec.models, spec.services);
  const grouping = groupServicesByNamespace(spec.services, ctx);
  const serviceDirMap = buildServiceDirMap(grouping);
  const resolveModelDir = (modelName: string) => {
    const svc = modelToServiceMap.get(modelName);
    return svc ? (serviceDirMap.get(svc) ?? 'common') : 'common';
  };

  // Group enum imports by service directory
  const enumToServiceMap = assignEnumsToServices(spec.enums, spec.services);
  const resolveEnumDir = (enumName: string) => {
    const svc = enumToServiceMap.get(enumName);
    return svc ? (serviceDirMap.get(svc) ?? 'common') : 'common';
  };

  const importsByDir = new Map<string, string[]>();
  for (const name of actualImports.sort()) {
    const modelDir = resolveModelDir(name);
    if (!importsByDir.has(modelDir)) importsByDir.set(modelDir, []);
    importsByDir.get(modelDir)!.push(className(name));
  }
  for (const name of [...enumImports].sort()) {
    const enumDir = resolveEnumDir(name);
    if (!importsByDir.has(enumDir)) importsByDir.set(enumDir, []);
    const existing = importsByDir.get(enumDir)!;
    const cn = className(name);
    if (!existing.includes(cn)) existing.push(cn);
  }

  for (const [modelDir, names] of [...importsByDir].sort()) {
    lines.push(`from ${ctx.namespace}.${dirToModule(modelDir)}.models import ${names.join(', ')}`);
  }

  const hasPaginated = service.operations.some((op) => op.pagination);
  if (hasPaginated) {
    lines.push(`from ${ctx.namespace}._pagination import AsyncPage, SyncPage`);
  }
  lines.push(
    `from ${ctx.namespace}._errors import AuthenticationError, NotFoundError, RateLimitExceededError, ServerError`,
  );

  lines.push('');
  lines.push('');
  lines.push(`class Test${resolvedName}:`);

  const emittedTestMethods = new Set<string>();
  for (const op of service.operations) {
    const plan = planOperation(op);
    const method = resolveMethodName(op, service, ctx);

    // Skip duplicate method names (match resource class deduplication)
    if (emittedTestMethods.has(method)) continue;
    emittedTestMethods.add(method);

    const isDelete = plan.isDelete;
    const isPaginated = plan.isPaginated;
    const isArrayResponse = op.response.kind === 'array' && op.response.items.kind === 'model';

    lines.push('');

    if (isPaginated) {
      const itemType = op.pagination!.itemType;
      let itemName = itemType.kind === 'model' ? itemType.name : null;
      // Unwrap list wrapper models to their inner item type for fixture names
      if (itemName) {
        const wrapperModel = spec.models.find((m) => m.name === itemName);
        if (wrapperModel && isListWrapperModel(wrapperModel)) {
          const dataField = wrapperModel.fields.find((f) => f.name === 'data');
          if (dataField && dataField.type.kind === 'array' && dataField.type.items.kind === 'model') {
            itemName = dataField.type.items.name;
          }
        }
      }
      const fixtureName = itemName ? `list_${fileName(itemName)}.json` : null;

      const paginatedArgs = buildTestArgs(op, spec);
      lines.push(`    def test_${method}(self, workos, httpx_mock):`);
      if (fixtureName) {
        lines.push(`        httpx_mock.add_response(`);
        lines.push(`            json=load_fixture("${fixtureName}"),`);
        lines.push('        )');
        lines.push(`        page = workos.${propName}.${method}(${paginatedArgs})`);
        lines.push('        assert isinstance(page, SyncPage)');
        lines.push('        assert isinstance(page.data, list)');
      } else {
        lines.push('        httpx_mock.add_response(json={"data": [], "list_metadata": {}})');
        lines.push(`        page = workos.${propName}.${method}(${paginatedArgs})`);
        lines.push('        assert isinstance(page, SyncPage)');
      }
    } else if (isDelete) {
      lines.push(`    def test_${method}(self, workos, httpx_mock):`);
      lines.push('        httpx_mock.add_response(status_code=204)');
      const args = buildTestArgs(op, spec);
      lines.push(`        result = workos.${propName}.${method}(${args})`);
      lines.push('        assert result is None');
      // Request assertions for delete
      const deletePath = buildExpectedPath(op);
      lines.push('        request = httpx_mock.get_request()');
      lines.push(`        assert request.method == "DELETE"`);
      lines.push(`        assert request.url.path.endswith("/${deletePath}")`);
    } else if (isRedirectEndpoint(op)) {
      // Redirect endpoint: returns a URL string, no HTTP request made
      const args = buildTestArgs(op, spec);
      lines.push(`    def test_${method}(self, workos):`);
      lines.push(`        result = workos.${propName}.${method}(${args})`);
      lines.push('        assert isinstance(result, str)');
      lines.push('        assert result.startswith("http")');
    } else if (isArrayResponse) {
      // Array response: returns List[Model]
      const modelClass = className(plan.responseModelName!);
      const fixtureName = `${fileName(plan.responseModelName!)}.json`;
      const args = buildTestArgs(op, spec);
      lines.push(`    def test_${method}(self, workos, httpx_mock):`);
      lines.push(`        httpx_mock.add_response(json=[load_fixture("${fixtureName}")])`);
      lines.push(`        result = workos.${propName}.${method}(${args})`);
      lines.push('        assert isinstance(result, list)');
      lines.push(`        assert len(result) == 1`);
      lines.push(`        assert isinstance(result[0], ${modelClass})`);
    } else if (plan.responseModelName) {
      const modelName = plan.responseModelName;
      const fixtureName = `${fileName(modelName)}.json`;
      const modelClass = className(modelName);

      lines.push(`    def test_${method}(self, workos, httpx_mock):`);
      lines.push(`        httpx_mock.add_response(`);
      lines.push(`            json=load_fixture("${fixtureName}"),`);
      lines.push('        )');
      const args = buildTestArgs(op, spec);
      lines.push(`        result = workos.${propName}.${method}(${args})`);
      lines.push(`        assert isinstance(result, ${modelClass})`);

      // Field-value assertions: verify at least 2 scalar fields from fixture
      const assertFields = pickAssertableFields(modelName, spec);
      for (const af of assertFields) {
        const op_ = af.isBool ? 'is' : '==';
        lines.push(`        assert result.${af.field} ${op_} ${af.value}`);
      }

      // Request assertions: verify HTTP method and URL path
      const expectedPath = buildExpectedPath(op);
      lines.push('        request = httpx_mock.get_request()');
      lines.push(`        assert request.method == "${op.httpMethod.toUpperCase()}"`);
      lines.push(`        assert request.url.path.endswith("/${expectedPath}")`);
      // For POST/PUT/PATCH with required body fields, verify specific field values
      if (plan.hasBody && ['post', 'put', 'patch'].includes(op.httpMethod.toLowerCase())) {
        const bodyModel = spec.models.find((m) => op.requestBody?.kind === 'model' && m.name === op.requestBody.name);
        const reqFields = bodyModel?.fields.filter((f) => f.required) ?? [];
        if (reqFields.length > 0) {
          lines.push('        body = json.loads(request.content)');
          for (const f of reqFields) {
            const testVal = generateTestValue(f.type, f.name);
            // Only assert primitives (strings, numbers, booleans) — skip complex types
            if (f.type.kind === 'primitive' || f.type.kind === 'enum' || f.type.kind === 'literal') {
              lines.push(`        assert body["${f.name}"] == ${testVal}`);
            } else {
              lines.push(`        assert "${f.name}" in body`);
            }
          }
        }
      }
    } else {
      lines.push(`    def test_${method}(self, workos, httpx_mock):`);
      lines.push('        httpx_mock.add_response(json={})');
      const args = buildTestArgs(op, spec);
      lines.push(`        workos.${propName}.${method}(${args})`);
      // Request assertions for void-returning methods
      const voidPath = buildExpectedPath(op);
      lines.push('        request = httpx_mock.get_request()');
      lines.push(`        assert request.method == "${op.httpMethod.toUpperCase()}"`);
      lines.push(`        assert request.url.path.endswith("/${voidPath}")`);
    }
  }

  // Add an error test for the first non-delete operation
  const firstNonDelete = service.operations.find((op) => !planOperation(op).isDelete);
  if (firstNonDelete) {
    const method = resolveMethodName(firstNonDelete, service, ctx);
    lines.push('');
    lines.push(`    def test_${method}_unauthorized(self, workos, httpx_mock):`);
    lines.push('        httpx_mock.add_response(');
    lines.push('            status_code=401,');
    lines.push('            json={"message": "Unauthorized"},');
    lines.push('        )');
    lines.push('        with pytest.raises(AuthenticationError):');
    const args = buildTestArgs(firstNonDelete, spec);
    lines.push(`            workos.${propName}.${method}(${args})`);

    lines.push('');
    lines.push(`    def test_${method}_not_found(self, httpx_mock):`);
    lines.push('        workos = WorkOS(api_key="sk_test_123", client_id="client_test", max_retries=0)');
    lines.push('        httpx_mock.add_response(status_code=404, json={"message": "Not found"})');
    lines.push('        with pytest.raises(NotFoundError):');
    lines.push(`            workos.${propName}.${method}(${args})`);
    lines.push('        workos.close()');

    lines.push('');
    lines.push(`    def test_${method}_rate_limited(self, httpx_mock):`);
    lines.push('        workos = WorkOS(api_key="sk_test_123", client_id="client_test", max_retries=0)');
    lines.push(
      '        httpx_mock.add_response(status_code=429, headers={"Retry-After": "0"}, json={"message": "Slow down"})',
    );
    lines.push('        with pytest.raises(RateLimitExceededError):');
    lines.push(`            workos.${propName}.${method}(${args})`);
    lines.push('        workos.close()');

    lines.push('');
    lines.push(`    def test_${method}_server_error(self, httpx_mock):`);
    lines.push('        workos = WorkOS(api_key="sk_test_123", client_id="client_test", max_retries=0)');
    lines.push('        httpx_mock.add_response(status_code=500, json={"message": "Server error"})');
    lines.push('        with pytest.raises(ServerError):');
    lines.push(`            workos.${propName}.${method}(${args})`);
    lines.push('        workos.close()');
  }

  // --- Async test class ---
  lines.push('');
  lines.push('');
  lines.push(`@pytest.mark.asyncio`);
  lines.push(`class TestAsync${resolvedName}:`);

  const asyncEmittedTestMethods = new Set<string>();
  for (const op of service.operations) {
    const plan = planOperation(op);
    const method = resolveMethodName(op, service, ctx);

    if (asyncEmittedTestMethods.has(method)) continue;
    asyncEmittedTestMethods.add(method);

    const isDelete = plan.isDelete;
    const isPaginated = plan.isPaginated;
    const isAsyncArrayResponse = op.response.kind === 'array' && op.response.items.kind === 'model';
    const asyncArgs = buildTestArgs(op, spec);

    lines.push('');

    if (isPaginated) {
      const itemType = op.pagination!.itemType;
      let itemName = itemType.kind === 'model' ? itemType.name : null;
      if (itemName) {
        const wrapperModel = spec.models.find((m) => m.name === itemName);
        if (wrapperModel && isListWrapperModel(wrapperModel)) {
          const dataField = wrapperModel.fields.find((f) => f.name === 'data');
          if (dataField && dataField.type.kind === 'array' && dataField.type.items.kind === 'model') {
            itemName = dataField.type.items.name;
          }
        }
      }
      const fixtureName = itemName ? `list_${fileName(itemName)}.json` : null;
      lines.push(`    async def test_${method}(self, async_workos, httpx_mock):`);
      if (fixtureName) {
        lines.push(`        httpx_mock.add_response(json=load_fixture("${fixtureName}"))`);
        lines.push(`        page = await async_workos.${propName}.${method}(${asyncArgs})`);
        lines.push('        assert isinstance(page.data, list)');
      } else {
        lines.push('        httpx_mock.add_response(json={"data": [], "list_metadata": {}})');
        lines.push(`        page = await async_workos.${propName}.${method}(${asyncArgs})`);
        lines.push('        assert isinstance(page.data, list)');
      }
    } else if (isDelete) {
      lines.push(`    async def test_${method}(self, async_workos, httpx_mock):`);
      lines.push('        httpx_mock.add_response(status_code=204)');
      lines.push(`        result = await async_workos.${propName}.${method}(${asyncArgs})`);
      lines.push('        assert result is None');
    } else if (isRedirectEndpoint(op)) {
      lines.push(`    async def test_${method}(self, async_workos):`);
      lines.push(`        result = await async_workos.${propName}.${method}(${asyncArgs})`);
      lines.push('        assert isinstance(result, str)');
      lines.push('        assert result.startswith("http")');
    } else if (isAsyncArrayResponse) {
      const fixtureName = `${fileName(plan.responseModelName!)}.json`;
      lines.push(`    async def test_${method}(self, async_workos, httpx_mock):`);
      lines.push(`        httpx_mock.add_response(json=[load_fixture("${fixtureName}")])`);
      lines.push(`        result = await async_workos.${propName}.${method}(${asyncArgs})`);
      lines.push('        assert isinstance(result, list)');
    } else if (plan.responseModelName) {
      const modelName = plan.responseModelName;
      const fixtureName = `${fileName(modelName)}.json`;
      const modelClass = className(modelName);
      lines.push(`    async def test_${method}(self, async_workos, httpx_mock):`);
      lines.push(`        httpx_mock.add_response(json=load_fixture("${fixtureName}"))`);
      lines.push(`        result = await async_workos.${propName}.${method}(${asyncArgs})`);
      lines.push(`        assert isinstance(result, ${modelClass})`);
    } else {
      lines.push(`    async def test_${method}(self, async_workos, httpx_mock):`);
      lines.push('        httpx_mock.add_response(json={})');
      lines.push(`        await async_workos.${propName}.${method}(${asyncArgs})`);
    }
  }

  return {
    path: `tests/test_${fileName(resolvedName)}.py`,
    content: lines.join('\n'),
    integrateTarget: true,
    overwriteExisting: true,
  };
}

/**
 * Pick up to N scalar fields from a model fixture to use for value assertions.
 * Returns tuples of [snake_case_field_name, python_literal_value].
 */
function pickAssertableFields(
  modelName: string,
  spec: ApiSpec,
  maxFields: number = 2,
): { field: string; value: string; isBool?: boolean }[] {
  const modelMap = new Map(spec.models.map((m) => [m.name, m]));
  const enumMap = new Map(spec.enums.map((e) => [e.name, e]));
  const model = modelMap.get(modelName);
  if (!model) return [];

  const fixture = generateModelFixture(model, modelMap, enumMap);
  const results: { field: string; value: string; isBool?: boolean }[] = [];

  for (const f of model.fields) {
    if (results.length >= maxFields) break;
    const val = fixture[f.name];
    if (val === undefined || val === null) continue;
    if (typeof val === 'string') {
      // Skip strings containing characters that are hard to represent as Python literals
      if (val.includes('"') || val.includes("'") || val.includes('{') || val.includes('\\') || val.includes('\n'))
        continue;
      results.push({ field: fieldName(f.name), value: `"${val}"` });
    } else if (typeof val === 'boolean') {
      // Use "is True/False" to satisfy ruff E712
      results.push({ field: fieldName(f.name), value: val ? 'True' : 'False', isBool: true });
    } else if (typeof val === 'number') {
      results.push({ field: fieldName(f.name), value: String(val) });
    }
  }
  return results;
}

/**
 * Build a Python string literal for the expected request URL suffix.
 * Replaces path params with their test values.
 */
function buildExpectedPath(op: Operation): string {
  let path = op.path.replace(/^\//, '');
  for (const param of op.pathParams) {
    path = path.replace(`{${param.name}}`, `test_${param.name}`);
  }
  return path;
}

/**
 * Build test arguments string for an operation call.
 */
function buildTestArgs(op: Operation, spec: ApiSpec): string {
  const args: string[] = [];

  // Path params as positional args
  for (const param of op.pathParams) {
    args.push(`"test_${param.name}"`);
  }

  const pathParamNames = new Set(op.pathParams.map((p) => fieldName(p.name)));

  // Required body fields as keyword args (matching the expanded-field signature)
  const plan = planOperation(op);
  if (plan.hasBody && op.requestBody?.kind === 'model') {
    const requestBodyName = op.requestBody.name;
    const bodyModel = spec.models.find((m) => m.name === requestBodyName);
    if (bodyModel) {
      const reqFields = bodyModel.fields.filter((f) => f.required);
      for (const f of reqFields) {
        const paramName = bodyParamName(f, pathParamNames);
        args.push(`${paramName}=${generateTestValue(f.type, f.name)}`);
      }
    }
  } else if (plan.hasBody && op.requestBody?.kind === 'union') {
    // Union body — pick the first variant model and use its fixture
    const variants = (op.requestBody as any).variants ?? [];
    const firstModelVariant = variants.find((v: any) => v.kind === 'model');
    if (firstModelVariant) {
      args.push(`body=load_fixture("${fileName(firstModelVariant.name)}.json")`);
    } else {
      args.push('body={}');
    }
  }

  // Per-operation Bearer token auth (e.g., access_token for SSO)
  const hasBearerOverride = op.security?.some((s) => s.schemeName !== 'bearerAuth') ?? false;
  if (hasBearerOverride) {
    const tokenParamName = fieldName(op.security!.find((s) => s.schemeName !== 'bearerAuth')!.schemeName);
    args.push(`${tokenParamName}="test_${tokenParamName}"`);
  }

  // Required query params (for all methods, including paginated)
  if (plan.hasQueryParams) {
    for (const param of op.queryParams) {
      // Skip pagination params (they're optional)
      if (plan.isPaginated && ['limit', 'before', 'after', 'order'].includes(param.name)) continue;
      // Skip params already covered by body fields
      if (plan.hasBody && op.requestBody?.kind === 'model') {
        const rbName = op.requestBody.name;
        const bodyModel = spec.models.find((m) => m.name === rbName);
        if (bodyModel?.fields.some((f) => fieldName(f.name) === fieldName(param.name))) continue;
      }
      if (param.required && !pathParamNames.has(fieldName(param.name))) {
        args.push(`${fieldName(param.name)}=${generateTestValue(param.type, param.name)}`);
      }
    }
  }

  return args.join(', ');
}

/**
 * Generate a representative Python value literal for a given type, for use in tests.
 */
function generateTestValue(ref: TypeRef, name: string): string {
  switch (ref.kind) {
    case 'primitive':
      switch (ref.type) {
        case 'string':
          return `"test_${name}"`;
        case 'integer':
          return '1';
        case 'number':
          return '1.0';
        case 'boolean':
          return 'True';
        default:
          return '{}';
      }
    case 'array':
      return '[]';
    case 'enum': {
      const enumValues = (ref as any).values as (string | number)[] | undefined;
      const enumClass = className(ref.name);
      if (enumValues && enumValues.length > 0) {
        const first = enumValues[0];
        const literal = typeof first === 'string' ? `"${first}"` : String(first);
        return `${enumClass}(${literal})`;
      }
      return `${enumClass}("test")`;
    }
    case 'model':
      return `${className(ref.name)}.from_dict(load_fixture("${fileName(ref.name)}.json"))`;
    case 'nullable':
      return generateTestValue(ref.inner, name);
    case 'map':
      return '{}';
    case 'literal':
      return typeof ref.value === 'string' ? `"${ref.value}"` : String(ref.value);
    case 'union':
      if (ref.variants.length > 0) return generateTestValue(ref.variants[0], name);
      return 'None';
    default:
      return '{}';
  }
}

/**
 * Generate model round-trip tests: Model.from_dict(instance.to_dict()) == instance
 */
function generateModelRoundTripTests(spec: ApiSpec, ctx: EmitterContext): GeneratedFile | null {
  // Collect models used as request bodies only (not returned in responses)
  const responseModelNames = new Set<string>();
  const requestOnlyModelNames = new Set<string>();
  for (const svc of spec.services) {
    for (const op of svc.operations) {
      const plan = planOperation(op);
      if (plan.responseModelName) responseModelNames.add(plan.responseModelName);
      if (op.requestBody?.kind === 'model') requestOnlyModelNames.add(op.requestBody.name);
      // Also collect union body variant models as request-only
      if (op.requestBody?.kind === 'union') {
        for (const v of (op.requestBody as any).variants ?? []) {
          if (v.kind === 'model') requestOnlyModelNames.add(v.name);
        }
      }
    }
  }
  // A model is request-only if it's used as a request body but never as a response
  for (const name of responseModelNames) requestOnlyModelNames.delete(name);

  const models = spec.models.filter(
    (m) => !isListWrapperModel(m) && !isListMetadataModel(m) && !requestOnlyModelNames.has(m.name),
  );
  if (models.length === 0) return null;

  const modelToService = assignModelsToServices(spec.models, spec.services);
  const roundTripGrouping = groupServicesByNamespace(spec.services, ctx);
  const roundTripDirMap = buildServiceDirMap(roundTripGrouping);
  const resolveDir = (irService: string | undefined) =>
    irService ? (roundTripDirMap.get(irService) ?? 'common') : 'common';

  const lines: string[] = [];
  lines.push('"""Model round-trip tests: from_dict(to_dict()) preserves data."""');
  lines.push('');
  lines.push('import pytest');
  lines.push('');
  lines.push('from tests.generated_helpers import load_fixture');
  lines.push('');

  // Collect imports by directory
  const importsByDir = new Map<string, string[]>();
  for (const model of models) {
    const service = modelToService.get(model.name);
    const dirName = resolveDir(service);
    if (!importsByDir.has(dirName)) importsByDir.set(dirName, []);
    importsByDir.get(dirName)!.push(className(model.name));
  }

  for (const [dirName, names] of [...importsByDir].sort()) {
    lines.push(`from ${ctx.namespace}.${dirToModule(dirName)}.models import ${names.sort().join(', ')}`);
  }

  lines.push('');
  lines.push('');
  lines.push('class TestModelRoundTrip:');

  for (const model of models) {
    const modelClass = className(model.name);
    const fixtureName = `${fileName(model.name)}.json`;

    lines.push('');
    lines.push(`    def test_${fileName(model.name)}_round_trip(self):`);
    lines.push(`        data = load_fixture("${fixtureName}")`);
    lines.push(`        instance = ${modelClass}.from_dict(data)`);
    lines.push('        serialized = instance.to_dict()');
    lines.push('        assert serialized == data');
    lines.push(`        restored = ${modelClass}.from_dict(serialized)`);
    lines.push('        assert restored.to_dict() == serialized');
  }

  return {
    path: 'tests/test_models_round_trip.py',
    content: lines.join('\n'),
    integrateTarget: true,
    overwriteExisting: true,
  };
}

/**
 * Generate client tests: retry behavior, error raising, context manager, idempotency keys.
 */
function generateClientTests(_spec: ApiSpec, ctx: EmitterContext, accessPaths: Map<string, string>): GeneratedFile {
  const lines: string[] = [];

  lines.push('"""Client tests: retries, errors, context manager, idempotency."""');
  lines.push('');
  lines.push('import httpx');
  lines.push('import pytest');
  lines.push('');
  lines.push(`from ${ctx.namespace} import WorkOS, AsyncWorkOS`);
  lines.push(`from ${ctx.namespace} import _client as generated_client_module`);
  lines.push(`from ${ctx.namespace}._errors import (`);
  lines.push('    AuthenticationError,');
  lines.push('    BadRequestError,');
  lines.push('    ForbiddenError,');
  lines.push('    NotFoundError,');
  lines.push('    ConflictError,');
  lines.push('    UnprocessableEntityError,');
  lines.push('    RateLimitExceededError,');
  lines.push('    ServerError,');
  lines.push('    ConfigurationError,');
  lines.push(')');
  lines.push('');
  lines.push('');
  lines.push('class TestWorkOSClient:');
  lines.push('');
  lines.push('    def test_missing_api_key_raises(self):');
  lines.push('        with pytest.raises(ValueError):');
  lines.push('            WorkOS(client_id="client_test")');
  lines.push('');
  lines.push('    def test_context_manager(self):');
  lines.push('        with WorkOS(api_key="sk_test_123", client_id="client_test") as client:');
  lines.push('            assert client._api_key == "sk_test_123"');
  lines.push('');
  lines.push('    def test_client_id_from_constructor(self):');
  lines.push('        client = WorkOS(api_key="sk_test_123", client_id="client_test_456")');
  lines.push('        assert client.client_id == "client_test_456"');
  lines.push('        client.close()');

  // Error status code tests
  const errorCodes: [number, string][] = [
    [400, 'BadRequestError'],
    [401, 'AuthenticationError'],
    [403, 'ForbiddenError'],
    [404, 'NotFoundError'],
    [409, 'ConflictError'],
    [422, 'UnprocessableEntityError'],
    [429, 'RateLimitExceededError'],
    [500, 'ServerError'],
  ];

  for (const [code, errorClass] of errorCodes) {
    lines.push('');
    lines.push(`    def test_raises_${code}(self, httpx_mock):`);
    lines.push('        httpx_mock.add_response(');
    lines.push(`            status_code=${code},`);
    lines.push('            json={"message": "Error"},');
    lines.push('        )');
    lines.push('        client = WorkOS(api_key="sk_test_123", client_id="client_test", max_retries=0)');
    lines.push(`        with pytest.raises(${errorClass}):`);
    lines.push('            client.request("GET", "test")');
    lines.push('        client.close()');
  }

  lines.push('');
  lines.push('    def test_idempotency_key_on_post(self, httpx_mock):');
  lines.push('        httpx_mock.add_response(json={})');
  lines.push('        client = WorkOS(api_key="sk_test_123", client_id="client_test")');
  lines.push('        client.request("POST", "test")');
  lines.push('        request = httpx_mock.get_request()');
  lines.push('        assert "Idempotency-Key" in request.headers');
  lines.push('        client.close()');
  lines.push('');
  lines.push('    def test_no_idempotency_key_on_get(self, httpx_mock):');
  lines.push('        httpx_mock.add_response(json={})');
  lines.push('        client = WorkOS(api_key="sk_test_123", client_id="client_test")');
  lines.push('        client.request("GET", "test")');
  lines.push('        request = httpx_mock.get_request()');
  lines.push('        assert "Idempotency-Key" not in request.headers');
  lines.push('        client.close()');
  lines.push('');
  lines.push('    def test_empty_body_sends_json(self, httpx_mock):');
  lines.push('        httpx_mock.add_response(json={})');
  lines.push('        client = WorkOS(api_key="sk_test_123", client_id="client_test")');
  lines.push('        client.request("PUT", "test", body={})');
  lines.push('        request = httpx_mock.get_request()');
  lines.push('        assert request.content == b"{}"');
  lines.push('        client.close()');

  lines.push('');
  lines.push('    def test_calculate_retry_delay_uses_retry_after_seconds(self):');
  lines.push('        assert WorkOS._calculate_retry_delay(1, "30") == 30.0');

  lines.push('');
  lines.push('    def test_retry_exhaustion_raises_rate_limit(self, httpx_mock, monkeypatch):');
  lines.push('        monkeypatch.setattr(generated_client_module.time, "sleep", lambda _: None)');
  lines.push('        for _ in range(4):');
  lines.push(
    '            httpx_mock.add_response(status_code=429, headers={"Retry-After": "0"}, json={"message": "Slow down"})',
  );
  lines.push('        client = WorkOS(api_key="sk_test_123", client_id="client_test", max_retries=3)');
  lines.push('        with pytest.raises(RateLimitExceededError):');
  lines.push('            client.request("GET", "test")');
  lines.push('        client.close()');

  lines.push('');
  lines.push('    def test_rate_limit_retry_after_is_parsed(self, httpx_mock):');
  lines.push(
    '        httpx_mock.add_response(status_code=429, headers={"Retry-After": "30"}, json={"message": "Slow down"})',
  );
  lines.push('        client = WorkOS(api_key="sk_test_123", client_id="client_test", max_retries=0)');
  lines.push('        with pytest.raises(RateLimitExceededError) as exc_info:');
  lines.push('            client.request("GET", "test")');
  lines.push('        assert exc_info.value.retry_after == 30.0');
  lines.push('        client.close()');

  lines.push('');
  lines.push('    def test_timeout_error_is_wrapped(self, httpx_mock, monkeypatch):');
  lines.push('        monkeypatch.setattr(generated_client_module.time, "sleep", lambda _: None)');
  lines.push('        httpx_mock.add_exception(httpx.TimeoutException("timed out"))');
  lines.push('        client = WorkOS(api_key="sk_test_123", client_id="client_test", max_retries=0)');
  lines.push('        with pytest.raises(generated_client_module.WorkOSTimeoutError):');
  lines.push('            client.request("GET", "test")');
  lines.push('        client.close()');

  lines.push('');
  lines.push('    def test_connection_error_is_wrapped(self, httpx_mock, monkeypatch):');
  lines.push('        monkeypatch.setattr(generated_client_module.time, "sleep", lambda _: None)');
  lines.push('        httpx_mock.add_exception(httpx.ConnectError("connect failed"))');
  lines.push('        client = WorkOS(api_key="sk_test_123", client_id="client_test", max_retries=0)');
  lines.push('        with pytest.raises(generated_client_module.WorkOSConnectionError):');
  lines.push('            client.request("GET", "test")');
  lines.push('        client.close()');

  lines.push('');
  lines.push('    def test_documented_import_surface_exposes_resources(self):');
  lines.push('        client = WorkOS(api_key="sk_test_123", client_id="client_test")');
  for (const path of [...new Set(accessPaths.values())].sort()) {
    lines.push(`        assert client.${path} is not None`);
  }
  lines.push('        client.close()');

  lines.push('');
  lines.push('@pytest.mark.asyncio');
  lines.push('class TestAsyncWorkOSClient:');
  lines.push('');
  lines.push('    async def test_documented_import_surface_exposes_resources(self):');
  lines.push('        client = AsyncWorkOS(api_key="sk_test_123", client_id="client_test")');
  for (const path of [...new Set(accessPaths.values())].sort()) {
    lines.push('        try:');
    lines.push(`            assert client.${path} is not None`);
    lines.push('        except NotImplementedError:');
    lines.push('            pass  # Some modules not yet available in async client');
  }
  lines.push('        await client.close()');

  lines.push('');
  lines.push('    async def test_timeout_error_is_wrapped(self, httpx_mock, monkeypatch):');
  lines.push('        async def _sleep(_: float) -> None:');
  lines.push('            return None');
  lines.push('        monkeypatch.setattr(generated_client_module.asyncio, "sleep", _sleep)');
  lines.push('        httpx_mock.add_exception(httpx.TimeoutException("timed out"))');
  lines.push('        client = AsyncWorkOS(api_key="sk_test_123", client_id="client_test", max_retries=0)');
  lines.push('        with pytest.raises(generated_client_module.WorkOSTimeoutError):');
  lines.push('            await client.request("GET", "test")');
  lines.push('        await client.close()');

  lines.push('');
  lines.push('    async def test_connection_error_is_wrapped(self, httpx_mock, monkeypatch):');
  lines.push('        async def _sleep(_: float) -> None:');
  lines.push('            return None');
  lines.push('        monkeypatch.setattr(generated_client_module.asyncio, "sleep", _sleep)');
  lines.push('        httpx_mock.add_exception(httpx.ConnectError("connect failed"))');
  lines.push('        client = AsyncWorkOS(api_key="sk_test_123", client_id="client_test", max_retries=0)');
  lines.push('        with pytest.raises(generated_client_module.WorkOSConnectionError):');
  lines.push('            await client.request("GET", "test")');
  lines.push('        await client.close()');

  return {
    path: 'tests/test_generated_client.py',
    content: lines.join('\n'),
    integrateTarget: true,
    overwriteExisting: true,
  };
}

/**
 * Generate pagination tests: auto_paging_iter, before cursor stripping.
 */
function generatePaginationTests(ctx: EmitterContext): GeneratedFile {
  const lines: string[] = [];

  lines.push('"""Pagination tests: auto_paging_iter, before cursor stripping."""');
  lines.push('');
  lines.push('import pytest');
  lines.push('');
  lines.push(`from ${ctx.namespace}._pagination import SyncPage, AsyncPage`);
  lines.push('from dataclasses import dataclass');
  lines.push('from typing import Any, Dict');
  lines.push('');
  lines.push('');
  lines.push('@dataclass');
  lines.push('class FakeItem:');
  lines.push('    id: str');
  lines.push('');
  lines.push('    @classmethod');
  lines.push('    def from_dict(cls, data: Dict[str, Any]) -> "FakeItem":');
  lines.push('        return cls(id=data["id"])');
  lines.push('');
  lines.push('    def to_dict(self) -> Dict[str, Any]:');
  lines.push('        return {"id": self.id}');
  lines.push('');
  lines.push('');
  lines.push('class TestSyncPage:');
  lines.push('');
  lines.push('    def test_has_more_with_after_cursor(self):');
  lines.push('        page = SyncPage(');
  lines.push('            data=[FakeItem(id="1")],');
  lines.push('            list_metadata={"after": "cursor_abc"},');
  lines.push('        )');
  lines.push('        assert page.has_more() is True');
  lines.push('        assert page.after == "cursor_abc"');
  lines.push('');
  lines.push('    def test_has_more_without_cursor(self):');
  lines.push('        page = SyncPage(');
  lines.push('            data=[FakeItem(id="1")],');
  lines.push('            list_metadata={},');
  lines.push('        )');
  lines.push('        assert page.has_more() is False');
  lines.push('');
  lines.push('    def test_auto_paging_iter_single_page(self):');
  lines.push('        page = SyncPage(');
  lines.push('            data=[FakeItem(id="1"), FakeItem(id="2")],');
  lines.push('            list_metadata={},');
  lines.push('        )');
  lines.push('        items = list(page.auto_paging_iter())');
  lines.push('        assert len(items) == 2');
  lines.push('        assert items[0].id == "1"');
  lines.push('        assert items[1].id == "2"');
  lines.push('');
  lines.push('    def test_auto_paging_iter_multi_page(self):');
  lines.push('        page2 = SyncPage(');
  lines.push('            data=[FakeItem(id="3")],');
  lines.push('            list_metadata={},');
  lines.push('        )');
  lines.push('        page1 = SyncPage(');
  lines.push('            data=[FakeItem(id="1"), FakeItem(id="2")],');
  lines.push('            list_metadata={"after": "cursor_abc"},');
  lines.push('            _fetch_page=lambda after=None: page2,');
  lines.push('        )');
  lines.push('        items = list(page1.auto_paging_iter())');
  lines.push('        assert len(items) == 3');
  lines.push('        assert [i.id for i in items] == ["1", "2", "3"]');
  lines.push('');
  lines.push('');
  lines.push('@pytest.mark.asyncio');
  lines.push('class TestAsyncPage:');
  lines.push('');
  lines.push('    async def test_has_more_with_after_cursor(self):');
  lines.push('        page = AsyncPage(');
  lines.push('            data=[FakeItem(id="1")],');
  lines.push('            list_metadata={"after": "cursor_abc"},');
  lines.push('        )');
  lines.push('        assert page.has_more() is True');
  lines.push('        assert page.after == "cursor_abc"');
  lines.push('');
  lines.push('    async def test_has_more_without_cursor(self):');
  lines.push('        page = AsyncPage(');
  lines.push('            data=[FakeItem(id="1")],');
  lines.push('            list_metadata={},');
  lines.push('        )');
  lines.push('        assert page.has_more() is False');
  lines.push('');
  lines.push('    async def test_auto_paging_iter_single_page(self):');
  lines.push('        page = AsyncPage(');
  lines.push('            data=[FakeItem(id="1"), FakeItem(id="2")],');
  lines.push('            list_metadata={},');
  lines.push('        )');
  lines.push('        items = [item async for item in page.auto_paging_iter()]');
  lines.push('        assert len(items) == 2');
  lines.push('        assert items[0].id == "1"');
  lines.push('        assert items[1].id == "2"');
  lines.push('');
  lines.push('    async def test_auto_paging_iter_multi_page(self):');
  lines.push('        page2 = AsyncPage(');
  lines.push('            data=[FakeItem(id="3")],');
  lines.push('            list_metadata={},');
  lines.push('        )');
  lines.push('        async def _fetch(after=None):');
  lines.push('            return page2');
  lines.push('        page1 = AsyncPage(');
  lines.push('            data=[FakeItem(id="1"), FakeItem(id="2")],');
  lines.push('            list_metadata={"after": "cursor_abc"},');
  lines.push('            _fetch_page=_fetch,');
  lines.push('        )');
  lines.push('        items = [item async for item in page1.auto_paging_iter()]');
  lines.push('        assert len(items) == 3');
  lines.push('        assert [i.id for i in items] == ["1", "2", "3"]');

  return {
    path: 'tests/test_pagination.py',
    content: lines.join('\n'),
    integrateTarget: true,
    overwriteExisting: true,
  };
}
