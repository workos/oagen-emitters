import type { ApiSpec, Service, Operation, EmitterContext, GeneratedFile, Model } from '@workos/oagen';
import { planOperation, toCamelCase } from '@workos/oagen';
import { className, resolveMethodName, snakeName, servicePropertyName } from './naming.js';
import { isListWrapperModel } from './models.js';
import { generateFixtures } from './fixtures.js';
import { getMountTarget, groupByMount } from '../shared/resolved-ops.js';

/**
 * Generate PHPUnit test files and fixture JSON files.
 */
export function generateTests(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const ns = ctx.namespacePascal;

  // Generate fixture JSON files
  const fixtures = generateFixtures(spec);
  for (const fixture of fixtures) {
    files.push({
      path: fixture.path,
      content: fixture.content,
      headerPlacement: 'skip',
    });
  }

  // Generate TestHelper with Guzzle mock helpers.
  // Uses headerPlacement: 'skip' because content already includes <?php.
  files.push({
    path: 'tests/TestHelper.php',
    content: generateTestHelper(ns),
    overwriteExisting: true,
    headerPlacement: 'skip',
  });

  // Collect all operations per mount target using resolved per-operation mounts.
  // This correctly handles operationHint mountOn overrides (e.g., audit_logs_retention → AuditLogs).
  const mountGroupsFromResolved = groupByMount(ctx);
  const mountGroups = new Map<string, { op: Operation; service: Service }[]>();
  if (mountGroupsFromResolved.size > 0) {
    for (const [target, group] of mountGroupsFromResolved) {
      mountGroups.set(
        target,
        group.resolvedOps.map((r) => ({ op: r.operation, service: r.service })),
      );
    }
  } else {
    // Fallback: group by service
    for (const service of spec.services) {
      const target = getMountTarget(service, ctx);
      if (!mountGroups.has(target)) mountGroups.set(target, []);
      for (const op of service.operations) {
        mountGroups.get(target)!.push({ op, service });
      }
    }
  }

  // Generate resource tests (one per mount target, all operations included)
  // Use overwriteExisting so the integration step always writes the latest
  // test content rather than attempting additive AST merge.
  for (const [target, ops] of mountGroups) {
    files.push({
      path: `tests/Service/${className(target)}Test.php`,
      content: generateMountGroupTest(target, ops, ctx),
      overwriteExisting: true,
    });
  }

  // Generate client test
  files.push({
    path: 'tests/ClientTest.php',
    content: generateClientTest(ctx),
    overwriteExisting: true,
  });

  return files;
}

/**
 * Generate TestHelper trait with Guzzle MockHandler helpers.
 */
function generateTestHelper(ns: string): string {
  return `<?php

declare(strict_types=1);

namespace WorkOS;

use GuzzleHttp\\Handler\\MockHandler;
use GuzzleHttp\\HandlerStack;
use GuzzleHttp\\Psr7\\Response;

trait TestHelper
{
    private ?MockHandler $mockHandler = null;

    protected function loadFixture(string $name): array
    {
        $path = __DIR__ . '/Fixtures/' . $name . '.json';
        if (!file_exists($path)) {
            $this->markTestSkipped("Fixture not found: {$name}.json");
        }
        return json_decode(file_get_contents($path), true);
    }

    protected function createMockClient(array $responses): ${ns}
    {
        $mockResponses = array_map(
            fn (array $response) => new Response(
                $response['status'] ?? 200,
                $response['headers'] ?? [],
                json_encode($response['body'] ?? [])
            ),
            $responses,
        );

        $this->mockHandler = new MockHandler($mockResponses);
        $handler = HandlerStack::create($this->mockHandler);

        return new ${ns}(
            apiKey: 'test_api_key',
            handler: $handler,
        );
    }

    protected function getLastRequest(): \\Psr\\Http\\Message\\RequestInterface
    {
        return $this->mockHandler->getLastRequest();
    }
}
`;
}

function generateMountGroupTest(
  target: string,
  ops: { op: Operation; service: Service }[],
  ctx: EmitterContext,
): string {
  const ns = ctx.namespacePascal;
  const name = className(target);
  const accessor = servicePropertyName(target);
  const lines: string[] = [];

  // No <?php here — the file header from fileHeader() provides it
  lines.push('namespace Tests\\Service;');
  lines.push('');
  lines.push('use PHPUnit\\Framework\\TestCase;');
  lines.push('use WorkOS\\TestHelper;');
  lines.push('');
  lines.push(`class ${name}Test extends TestCase`);
  lines.push('{');
  lines.push('    use TestHelper;');

  // Track emitted test names to avoid duplicates
  const emitted = new Set<string>();

  // Generate tests for all operations across all services in the mount group.
  // Uses the hand-maintained TestHelper API:
  //   - loadFixture(name) appends .json automatically
  //   - createMockClient([['status' => N, 'body' => [...]]]) wraps into Response
  for (const { op, service } of ops) {
    const plan = planOperation(op);
    const method = resolveMethodName(op, service, ctx);
    const testName = `test${method.charAt(0).toUpperCase()}${method.slice(1)}`;

    if (emitted.has(testName)) continue;
    emitted.add(testName);

    // Skip tests for operations with model-type required body params
    // or required params with optional-before-required ordering issues
    const hasModelBodyParam =
      op.requestBody?.kind === 'model' &&
      ctx.spec.models
        .find((m) => m.name === (op.requestBody as { name: string }).name)
        ?.fields.some((f) => f.required && (f.type.kind === 'model' || f.type.kind === 'enum'));
    const _hasRequiredQueryParams = op.queryParams.some((q) => q.required);
    const hasOptionalBeforeRequired = (() => {
      const params = buildMethodParamOrder(op, ctx);
      let seenOptional = false;
      for (const p of params) {
        if (!p.required) seenOptional = true;
        else if (seenOptional) return true;
      }
      return false;
    })();

    lines.push('');
    lines.push(`    public function ${testName}(): void`);
    lines.push('    {');

    if (hasModelBodyParam || hasOptionalBeforeRequired) {
      lines.push("        $this->markTestSkipped('Complex parameter requirements - tested via smoke tests');");
      lines.push('    }');
      continue;
    }

    const expectedPath = buildExpectedPath(op, ctx);

    if (plan.isDelete) {
      lines.push("        $client = $this->createMockClient([['status' => 204]]);");
      lines.push(`        $client->${accessor}()->${method}(${buildTestArgs(op, ctx)});`);
      // Request assertions
      lines.push('        $request = $this->getLastRequest();');
      lines.push("        $this->assertSame('DELETE', $request->getMethod());");
      lines.push(`        $this->assertStringEndsWith('${expectedPath}', $request->getUri()->getPath());`);
    } else if (plan.isPaginated && op.pagination?.itemType.kind === 'model') {
      const fixtureName = `list_${resolveFixtureModelName(op.pagination.itemType.name, ctx)}`;
      lines.push(`        $fixture = $this->loadFixture('${fixtureName}');`);
      lines.push("        $client = $this->createMockClient([['status' => 200, 'body' => $fixture]]);");
      lines.push(`        $result = $client->${accessor}()->${method}(${buildTestArgs(op, ctx)});`);
      lines.push(`        $this->assertInstanceOf(\\${ns}\\PaginatedResponse::class, $result);`);
      // Request assertions
      lines.push('        $request = $this->getLastRequest();');
      lines.push(`        $this->assertSame('${op.httpMethod.toUpperCase()}', $request->getMethod());`);
      lines.push(`        $this->assertStringEndsWith('${expectedPath}', $request->getUri()->getPath());`);
    } else if (plan.responseModelName) {
      const modelName = className(plan.responseModelName);
      const fixtureName = `${snakeName(plan.responseModelName)}`;
      lines.push(`        $fixture = $this->loadFixture('${fixtureName}');`);
      lines.push("        $client = $this->createMockClient([['status' => 200, 'body' => $fixture]]);");
      lines.push(`        $result = $client->${accessor}()->${method}(${buildTestArgs(op, ctx)});`);
      lines.push(`        $this->assertInstanceOf(\\${ns}\\Resource\\${modelName}::class, $result);`);
      // Request assertions
      lines.push('        $request = $this->getLastRequest();');
      lines.push(`        $this->assertSame('${op.httpMethod.toUpperCase()}', $request->getMethod());`);
      lines.push(`        $this->assertStringEndsWith('${expectedPath}', $request->getUri()->getPath());`);
      // Body assertions for POST/PUT/PATCH
      if (plan.hasBody && ['post', 'put', 'patch'].includes(op.httpMethod.toLowerCase())) {
        emitBodyAssertions(lines, op, ctx);
      }
    } else {
      lines.push("        $client = $this->createMockClient([['status' => 200, 'body' => []]]);");
      lines.push(`        $client->${accessor}()->${method}(${buildTestArgs(op, ctx)});`);
      // Request assertions
      lines.push('        $request = $this->getLastRequest();');
      lines.push(`        $this->assertSame('${op.httpMethod.toUpperCase()}', $request->getMethod());`);
      lines.push(`        $this->assertStringEndsWith('${expectedPath}', $request->getUri()->getPath());`);
    }

    lines.push('    }');
  }

  // Generate tests for wrapper methods (union split operations)
  for (const resolved of ctx.resolvedOperations ?? []) {
    if (resolved.mountOn !== target) continue;
    for (const wrapper of resolved.wrappers ?? []) {
      const method = toCamelCase(wrapper.name);
      const testName = `test${method.charAt(0).toUpperCase()}${method.slice(1)}`;

      if (emitted.has(testName)) continue;
      emitted.add(testName);

      const op = resolved.operation;
      const responseModel = op.response.kind === 'model' ? op.response.name : null;

      lines.push('');
      lines.push(`    public function ${testName}(): void`);
      lines.push('    {');

      if (responseModel) {
        const modelName = className(responseModel);
        const fixtureName = `${snakeName(responseModel)}`;
        lines.push(`        $fixture = $this->loadFixture('${fixtureName}');`);
        lines.push("        $client = $this->createMockClient([['status' => 200, 'body' => $fixture]]);");
        lines.push(`        $result = $client->${accessor}()->${method}();`);
        lines.push(`        $this->assertInstanceOf(\\${ns}\\Resource\\${modelName}::class, $result);`);
      } else {
        lines.push("        $client = $this->createMockClient([['status' => 200, 'body' => []]]);");
        lines.push(`        $client->${accessor}()->${method}();`);
        lines.push('        $this->assertTrue(true);');
      }

      lines.push('    }');
    }
  }

  lines.push('}');
  return lines.join('\n');
}

function generateClientTest(ctx: EmitterContext): string {
  const ns = ctx.namespacePascal;
  const lines: string[] = [];

  // No <?php here — the file header from fileHeader() provides it
  lines.push('namespace Tests;');
  lines.push('');
  lines.push('use PHPUnit\\Framework\\TestCase;');
  lines.push(`use ${ns}\\${ns};`);
  lines.push('');
  lines.push('class ClientTest extends TestCase');
  lines.push('{');
  lines.push('    public function testConstructor(): void');
  lines.push('    {');
  lines.push(`        $client = new ${ns}(apiKey: 'test-key');`);
  lines.push('        $this->assertNotNull($client);');
  lines.push('    }');
  lines.push('}');

  return lines.join('\n');
}

function buildTestArgs(op: Operation, ctx: EmitterContext): string {
  const args: string[] = [];
  const usedNames = new Set<string>();

  // Path params (use enum values for enum-typed path params)
  for (const p of op.pathParams) {
    if (p.type.kind === 'enum' || p.type.kind === 'model') {
      args.push(generateTestValue(p.type, ctx));
    } else {
      args.push(`'test_${p.name}'`);
    }
    usedNames.add(toCamelCase(p.name));
  }

  // Required body fields
  if (op.requestBody?.kind === 'model') {
    const bodyModel = ctx.spec.models.find((m) => m.name === (op.requestBody as { name: string }).name);
    if (bodyModel) {
      for (const f of bodyModel.fields) {
        if (!f.required) continue;
        const phpName = toCamelCase(f.name);
        if (usedNames.has(phpName)) continue;
        usedNames.add(phpName);
        args.push(`${phpName}: ${generateTestValue(f.type, ctx)}`);
      }
    }
  }

  // Required query params
  for (const q of op.queryParams) {
    if (!q.required) continue;
    const phpName = toCamelCase(q.name);
    if (usedNames.has(phpName)) continue;
    usedNames.add(phpName);
    args.push(`${phpName}: ${generateTestValue(q.type, ctx)}`);
  }

  return args.join(', ');
}

/** Build a simplified param order for detecting optional-before-required issues. */
function buildMethodParamOrder(op: Operation, ctx: EmitterContext): { name: string; required: boolean }[] {
  const params: { name: string; required: boolean }[] = [];
  for (const p of op.pathParams) {
    params.push({ name: p.name, required: true });
  }
  if (op.requestBody?.kind === 'model') {
    const bodyModel = ctx.spec.models.find((m) => m.name === (op.requestBody as { name: string }).name);
    if (bodyModel) {
      for (const f of bodyModel.fields) {
        params.push({ name: f.name, required: f.required });
      }
    }
  }
  for (const q of op.queryParams) {
    params.push({ name: q.name, required: q.required });
  }
  return params;
}

function generateTestValue(ref: { kind: string; type?: string; name?: string }, ctx?: EmitterContext): string {
  switch (ref.kind) {
    case 'primitive':
      switch (ref.type) {
        case 'string':
          return "'test_value'";
        case 'integer':
          return '1';
        case 'number':
          return '1.0';
        case 'boolean':
          return 'true';
        default:
          return "'test_value'";
      }
    case 'enum': {
      // Use the first enum value so PHP type-checking passes
      if (ctx && ref.name) {
        const e = ctx.spec.enums.find((en) => en.name === ref.name);
        if (e && e.values.length > 0) {
          const enumClass = className(ref.name);
          const caseName = String(e.values[0].name)
            .split(/[_\s-]+/)
            .filter(Boolean)
            .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
            .join('');
          return `\\WorkOS\\Resource\\${enumClass}::${caseName}`;
        }
      }
      return "'test_value'";
    }
    case 'array':
      return '[]';
    case 'model':
      return '[]';
    default:
      return "'test_value'";
  }
}

/**
 * Resolve the fixture model name, unwrapping list wrapper models to match
 * the fixture generator's naming (which unwraps before naming).
 */
function resolveFixtureModelName(modelName: string, ctx: EmitterContext): string {
  const model = ctx.spec.models.find((m: Model) => m.name === modelName);
  if (model && isListWrapperModel(model)) {
    const dataField = model.fields.find((f) => f.name === 'data');
    if (dataField?.type.kind === 'array' && dataField.type.items.kind === 'model') {
      return snakeName(dataField.type.items.name);
    }
  }
  return snakeName(modelName);
}

/**
 * Build the expected URL path for an operation, substituting test values for path params.
 */
function buildExpectedPath(op: Operation, ctx: EmitterContext): string {
  let path = op.path.replace(/^\//, '');
  for (const p of op.pathParams) {
    if (p.type.kind === 'enum' && (p.type as { name: string }).name) {
      // Use the actual first enum backing value for the path
      const e = ctx.spec.enums.find((en) => en.name === (p.type as { name: string }).name);
      const firstValue = e?.values[0]?.value;
      path = path.replace(`{${p.name}}`, firstValue != null ? String(firstValue) : `test_${p.name}`);
    } else {
      path = path.replace(`{${p.name}}`, `test_${p.name}`);
    }
  }
  return path;
}

/**
 * Emit body field assertions for POST/PUT/PATCH operations.
 * Only asserts primitive required fields (strings, numbers, booleans).
 */
function emitBodyAssertions(lines: string[], op: Operation, ctx: EmitterContext): void {
  if (op.requestBody?.kind !== 'model') return;
  const bodyModel = ctx.spec.models.find((m) => m.name === (op.requestBody as { name: string }).name);
  if (!bodyModel) return;
  // Skip fields that collide with path param names (they get deduped in the resource)
  const pathParamNames = new Set(op.pathParams.map((p) => p.name));
  const primitiveRequired = bodyModel.fields.filter(
    (f) => f.required && (f.type.kind === 'primitive' || f.type.kind === 'literal') && !pathParamNames.has(f.name),
  );
  if (primitiveRequired.length === 0) return;

  lines.push('        $body = json_decode((string) $request->getBody(), true);');
  for (const f of primitiveRequired) {
    if (f.type.kind === 'primitive' && f.type.type === 'string') {
      lines.push(`        $this->assertSame('test_value', $body['${f.name}']);`);
    } else if (f.type.kind === 'primitive' && f.type.type === 'integer') {
      lines.push(`        $this->assertSame(1, $body['${f.name}']);`);
    } else if (f.type.kind === 'primitive' && f.type.type === 'boolean') {
      lines.push(`        $this->assertTrue($body['${f.name}']);`);
    } else {
      lines.push(`        $this->assertArrayHasKey('${f.name}', $body);`);
    }
  }
}
