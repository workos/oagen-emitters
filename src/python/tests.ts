import type { ApiSpec, Service, Operation, EmitterContext, GeneratedFile } from '@workos/oagen';
import { planOperation, toSnakeCase } from '@workos/oagen';
import { className, fileName, fieldName, resolveServiceDir, resolveMethodName, buildServiceNameMap } from './naming.js';
import { resolveResourceClassName } from './resources.js';
import { generateFixtures } from './fixtures.js';
import { isListWrapperModel } from './models.js';

/**
 * Generate pytest test files and JSON fixtures for the Python SDK.
 */
export function generateTests(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  // Generate fixture JSON files
  const fixtures = generateFixtures(spec, ctx);
  for (const fixture of fixtures) {
    files.push({
      path: fixture.path,
      content: fixture.content,
      headerPlacement: 'skip',
      integrateTarget: false,
    });
  }

  // Generate conftest.py
  files.push(generateConftest(ctx));

  // Generate per-service test files
  for (const service of spec.services) {
    const testFile = generateServiceTest(service, spec, ctx);
    if (testFile) files.push(testFile);
  }

  return files;
}

function generateConftest(ctx: EmitterContext): GeneratedFile {
  const lines: string[] = [];

  lines.push('import json');
  lines.push('import os');
  lines.push('');
  lines.push('import pytest');
  lines.push('');
  lines.push(`from ${ctx.namespace} import WorkOS`);
  lines.push('');
  lines.push('');
  lines.push('FIXTURES_DIR = os.path.join(os.path.dirname(__file__), "fixtures")');
  lines.push('');
  lines.push('');
  lines.push('def load_fixture(name: str) -> dict:');
  lines.push('    """Load a JSON fixture file by name."""');
  lines.push('    path = os.path.join(FIXTURES_DIR, name)');
  lines.push('    with open(path) as f:');
  lines.push('        return json.load(f)');
  lines.push('');
  lines.push('');
  lines.push('@pytest.fixture');
  lines.push('def workos():');
  lines.push('    """Create a WorkOS client for testing."""');
  lines.push('    return WorkOS(api_key="sk_test_Sz3IQjepeSWaI4cMS4ms4sMuU")');

  return {
    path: 'tests/conftest.py',
    content: lines.join('\n'),
    integrateTarget: false,
  };
}

function generateServiceTest(service: Service, spec: ApiSpec, ctx: EmitterContext): GeneratedFile | null {
  if (service.operations.length === 0) return null;

  const resolvedName = resolveResourceClassName(service, ctx);
  const dirName = resolveServiceDir(resolvedName);
  const propName = toSnakeCase(resolvedName);

  const lines: string[] = [];

  lines.push('import pytest');
  lines.push('from conftest import load_fixture');
  lines.push('');

  // Collect model imports needed
  const modelImports = new Set<string>();
  for (const op of service.operations) {
    const plan = planOperation(op);
    if (plan.responseModelName) modelImports.add(plan.responseModelName);
    if (op.pagination?.itemType.kind === 'model') {
      modelImports.add(op.pagination.itemType.name);
    }
  }

  // Filter out list wrapper models
  const actualImports = [...modelImports].filter((name) => {
    const model = spec.models.find((m) => m.name === name);
    if (!model) return true;
    return !isListWrapperModel(model);
  });

  if (actualImports.length > 0) {
    lines.push(`from ${ctx.namespace}.${dirName}.models import ${actualImports.sort().join(', ')}`);
  }

  const hasPaginated = service.operations.some((op) => op.pagination);
  if (hasPaginated) {
    lines.push(`from ${ctx.namespace}._pagination import SyncPage`);
  }
  lines.push(`from ${ctx.namespace}._errors import AuthenticationError`);

  lines.push('');
  lines.push('');
  lines.push(`class Test${resolvedName}:`);

  for (const op of service.operations) {
    const plan = planOperation(op);
    const method = resolveMethodName(op, service, ctx);
    const isDelete = plan.isDelete;
    const isPaginated = plan.isPaginated;

    lines.push('');

    if (isPaginated) {
      const itemType = op.pagination!.itemType;
      const itemName = itemType.kind === 'model' ? itemType.name : null;
      const fixtureName = itemName ? `list_${fileName(itemName)}.json` : null;

      lines.push(`    def test_${method}(self, workos, httpx_mock):`);
      if (fixtureName) {
        lines.push(`        httpx_mock.add_response(`);
        lines.push(`            json=load_fixture("${fixtureName}"),`);
        lines.push('        )');
        lines.push(`        page = workos.${propName}.${method}()`);
        lines.push('        assert isinstance(page, SyncPage)');
        lines.push('        assert isinstance(page.data, list)');
      } else {
        lines.push('        httpx_mock.add_response(json={"data": [], "list_metadata": {}})');
        lines.push(`        page = workos.${propName}.${method}()`);
        lines.push('        assert isinstance(page, SyncPage)');
      }
    } else if (isDelete) {
      lines.push(`    def test_${method}(self, workos, httpx_mock):`);
      lines.push('        httpx_mock.add_response(status_code=204)');
      const args = buildTestArgs(op);
      lines.push(`        result = workos.${propName}.${method}(${args})`);
      lines.push('        assert result is None');
    } else if (plan.responseModelName) {
      const modelName = plan.responseModelName;
      const fixtureName = `${fileName(modelName)}.json`;
      const modelClass = className(modelName);

      lines.push(`    def test_${method}(self, workos, httpx_mock):`);
      lines.push(`        httpx_mock.add_response(`);
      lines.push(`            json=load_fixture("${fixtureName}"),`);
      lines.push('        )');
      const args = buildTestArgs(op);
      lines.push(`        result = workos.${propName}.${method}(${args})`);
      lines.push(`        assert isinstance(result, ${modelClass})`);
    } else {
      lines.push(`    def test_${method}(self, workos, httpx_mock):`);
      lines.push('        httpx_mock.add_response(json={})');
      const args = buildTestArgs(op);
      lines.push(`        workos.${propName}.${method}(${args})`);
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
    const args = buildTestArgs(firstNonDelete);
    lines.push(`            workos.${propName}.${method}(${args})`);
  }

  return {
    path: `tests/test_${fileName(resolvedName)}.py`,
    content: lines.join('\n'),
    integrateTarget: false,
  };
}

/**
 * Build test arguments string for an operation call.
 */
function buildTestArgs(op: Operation): string {
  const args: string[] = [];

  // Path params as positional args
  for (const param of op.pathParams) {
    args.push(`"test_${param.name}"`);
  }

  // Required body fields as keyword args
  const plan = planOperation(op);
  if (plan.hasBody && op.requestBody?.kind === 'model') {
    // Just pass minimal required args
    args.push(`${fieldName(op.requestBody.name)}={"name": "Test"}`);
  }

  return args.join(', ');
}
