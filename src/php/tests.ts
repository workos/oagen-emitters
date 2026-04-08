import type {
  ApiSpec,
  Service,
  Operation,
  EmitterContext,
  GeneratedFile,
  Model,
  ResolvedOperation,
} from '@workos/oagen';
import { planOperation, toCamelCase } from '@workos/oagen';
import { className, enumClassName, resolveMethodName, snakeName, servicePropertyName } from './naming.js';
import { isListWrapperModel } from './models.js';
import { generateFixtures } from './fixtures.js';
import { getMountTarget, groupByMount, buildHiddenParams } from '../shared/resolved-ops.js';
import { resolveWrapperParams } from '../shared/wrapper-utils.js';

/**
 * Generate PHPUnit test files and fixture JSON files.
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
    });
  }

  // TestHelper is now hand-maintained in the target SDK (@oagen-ignore-file).

  // Collect all operations per mount target using resolved per-operation mounts.
  // This correctly handles operationHint mountOn overrides (e.g., audit_logs_retention → AuditLogs).
  const mountGroupsFromResolved = groupByMount(ctx);
  const mountGroups = new Map<string, { op: Operation; service: Service; resolvedOp?: ResolvedOperation }[]>();
  if (mountGroupsFromResolved.size > 0) {
    for (const [target, group] of mountGroupsFromResolved) {
      mountGroups.set(
        target,
        group.resolvedOps.map((r) => ({ op: r.operation, service: r.service, resolvedOp: r })),
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

function generateMountGroupTest(
  target: string,
  ops: { op: Operation; service: Service; resolvedOp?: ResolvedOperation }[],
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
  for (const { op, service, resolvedOp } of ops) {
    // Skip base method when wrappers exist (matches resources.ts)
    if (resolvedOp?.wrappers && resolvedOp.wrappers.length > 0) continue;

    const plan = planOperation(op);
    const method = resolveMethodName(op, service, ctx);
    const testName = `test${method.charAt(0).toUpperCase()}${method.slice(1)}`;
    const hidden = buildHiddenParams(resolvedOp);

    if (emitted.has(testName)) continue;
    emitted.add(testName);

    lines.push('');
    lines.push(`    public function ${testName}(): void`);
    lines.push('    {');

    const expectedPath = buildExpectedPath(op, ctx);

    if (plan.isDelete) {
      lines.push("        $client = $this->createMockClient([['status' => 204]]);");
      lines.push(`        $client->${accessor}()->${method}(${buildTestArgs(op, ctx, { hidden })});`);
      // Request assertions
      lines.push('        $request = $this->getLastRequest();');
      lines.push("        $this->assertSame('DELETE', $request->getMethod());");
      lines.push(`        $this->assertStringEndsWith('${expectedPath}', $request->getUri()->getPath());`);
      // Body assertions for DELETE-with-body
      if (plan.hasBody && op.requestBody?.kind === 'model') {
        emitBodyAssertions(lines, op, ctx, hidden);
      }
    } else if (plan.isPaginated && op.pagination?.itemType.kind === 'model') {
      const fixtureName = `list_${resolveFixtureModelName(op.pagination.itemType.name, ctx)}`;
      // Pass all params (including optional enums) to verify serialization
      lines.push(`        $fixture = $this->loadFixture('${fixtureName}');`);
      lines.push("        $client = $this->createMockClient([['status' => 200, 'body' => $fixture]]);");
      lines.push(
        `        $result = $client->${accessor}()->${method}(${buildTestArgs(op, ctx, { includeOptional: true, hidden })});`,
      );
      lines.push(`        $this->assertInstanceOf(\\${ns}\\PaginatedResponse::class, $result);`);
      // Request assertions
      lines.push('        $request = $this->getLastRequest();');
      lines.push(`        $this->assertSame('${op.httpMethod.toUpperCase()}', $request->getMethod());`);
      lines.push(`        $this->assertStringEndsWith('${expectedPath}', $request->getUri()->getPath());`);
      // Query string serialization assertions
      emitQueryAssertions(lines, op, ctx, hidden);
    } else if (plan.responseModelName) {
      const modelName = className(plan.responseModelName);
      const fixtureName = `${snakeName(plan.responseModelName)}`;
      lines.push(`        $fixture = $this->loadFixture('${fixtureName}');`);
      if (op.response.kind === 'array') {
        lines.push("        $client = $this->createMockClient([['status' => 200, 'body' => [$fixture]]]);");
      } else {
        lines.push("        $client = $this->createMockClient([['status' => 200, 'body' => $fixture]]);");
      }
      lines.push(`        $result = $client->${accessor}()->${method}(${buildTestArgs(op, ctx, { hidden })});`);
      if (op.response.kind === 'array') {
        lines.push('        $this->assertIsArray($result);');
        lines.push(`        $this->assertInstanceOf(\\${ns}\\Resource\\${modelName}::class, $result[0]);`);
        emitFieldHydrationAssertions(lines, plan.responseModelName, '$result[0]', '$fixture', ctx);
        // Round-trip: fromArray → toArray must not throw
        lines.push('        $this->assertIsArray($result[0]->toArray());');
      } else {
        lines.push(`        $this->assertInstanceOf(\\${ns}\\Resource\\${modelName}::class, $result);`);
        emitFieldHydrationAssertions(lines, plan.responseModelName, '$result', '$fixture', ctx);
        // Round-trip: fromArray → toArray must not throw
        lines.push('        $this->assertIsArray($result->toArray());');
      }
      // Request assertions
      lines.push('        $request = $this->getLastRequest();');
      lines.push(`        $this->assertSame('${op.httpMethod.toUpperCase()}', $request->getMethod());`);
      lines.push(`        $this->assertStringEndsWith('${expectedPath}', $request->getUri()->getPath());`);
      // Body assertions for POST/PUT/PATCH
      if (plan.hasBody && ['post', 'put', 'patch'].includes(op.httpMethod.toLowerCase())) {
        emitBodyAssertions(lines, op, ctx, hidden);
      }
    } else {
      lines.push("        $client = $this->createMockClient([['status' => 200, 'body' => []]]);");
      lines.push(`        $client->${accessor}()->${method}(${buildTestArgs(op, ctx, { hidden })});`);
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

      // Build required args for wrapper methods
      const wrapperArgs = buildWrapperTestArgs(wrapper, ctx);

      if (responseModel) {
        const modelName = className(responseModel);
        const fixtureName = `${snakeName(responseModel)}`;
        lines.push(`        $fixture = $this->loadFixture('${fixtureName}');`);
        lines.push("        $client = $this->createMockClient([['status' => 200, 'body' => $fixture]]);");
        lines.push(`        $result = $client->${accessor}()->${method}(${wrapperArgs});`);
        lines.push(`        $this->assertInstanceOf(\\${ns}\\Resource\\${modelName}::class, $result);`);
      } else {
        lines.push("        $client = $this->createMockClient([['status' => 200, 'body' => []]]);");
        lines.push(`        $client->${accessor}()->${method}(${wrapperArgs});`);
        lines.push('        $this->assertTrue(true);');
      }

      lines.push('    }');
    }
  }

  // Pagination boundary test: verify iteration works when before/after cursors are null
  const firstPaginatedOp = ops.find(({ op }) => {
    const p = planOperation(op);
    return p.isPaginated && op.pagination?.itemType.kind === 'model';
  });
  if (firstPaginatedOp) {
    const testName = 'testPaginationBoundary';
    if (!emitted.has(testName)) {
      emitted.add(testName);
      const op = firstPaginatedOp.op;
      const paginatedHidden = buildHiddenParams(firstPaginatedOp.resolvedOp);
      const itemType = op.pagination!.itemType as { name: string };
      const fixtureName = `list_${resolveFixtureModelName(itemType.name, ctx)}`;
      const method = resolveMethodName(op, firstPaginatedOp.service, ctx);

      lines.push('');
      lines.push(`    public function ${testName}(): void`);
      lines.push('    {');
      lines.push(`        $fixture = $this->loadFixture('${fixtureName}');`);
      lines.push('        // Ensure cursors are null (first/last page boundary)');
      lines.push("        $fixture['list_metadata']['before'] = null;");
      lines.push("        $fixture['list_metadata']['after'] = null;");
      lines.push("        $client = $this->createMockClient([['status' => 200, 'body' => $fixture]]);");
      lines.push(
        `        $result = $client->${accessor}()->${method}(${buildTestArgs(op, ctx, { hidden: paginatedHidden })});`,
      );
      lines.push(`        $this->assertInstanceOf(\\${ns}\\PaginatedResponse::class, $result);`);
      lines.push('        // Verify cursors are null on boundary page');
      lines.push("        $this->assertNull($result->listMetadata['before']);");
      lines.push("        $this->assertNull($result->listMetadata['after']);");
      lines.push('        // Iterating should not throw on null cursors');
      lines.push('        foreach ($result as $item) {');
      lines.push('            $this->assertNotNull($item);');
      lines.push('            break;');
      lines.push('        }');
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

function buildTestArgs(
  op: Operation,
  ctx: EmitterContext,
  opts?: { includeOptional?: boolean; hidden?: Set<string> },
): string {
  const includeOptional = opts?.includeOptional ?? false;
  const hidden = opts?.hidden ?? new Set<string>();
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
      const pathParamNames = new Set(op.pathParams.map((p) => toCamelCase(p.name)));
      for (const f of bodyModel.fields) {
        if (hidden.has(f.name)) continue;
        if (!f.required && !includeOptional) continue;
        let phpName = toCamelCase(f.name);
        if (pathParamNames.has(phpName)) {
          phpName = `body${phpName.charAt(0).toUpperCase()}${phpName.slice(1)}`;
        }
        if (usedNames.has(phpName)) continue;
        usedNames.add(phpName);
        args.push(`${phpName}: ${generateTestValue(f.type, ctx)}`);
      }
    }
  }

  // Query params
  for (const q of op.queryParams) {
    if (hidden.has(q.name)) continue;
    if (!q.required && !includeOptional) continue;
    const phpName = toCamelCase(q.name);
    if (usedNames.has(phpName)) continue;
    usedNames.add(phpName);
    args.push(`${phpName}: ${generateTestValue(q.type, ctx)}`);
  }

  return args.join(', ');
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
          const enumClass = enumClassName(ref.name);
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
    case 'model': {
      if (ref.name) {
        const modelClass = className(ref.name);
        const fixtureName = snakeName(ref.name);
        return `\\WorkOS\\Resource\\${modelClass}::fromArray($this->loadFixture('${fixtureName}'))`;
      }
      return '[]';
    }
    default:
      return "'test_value'";
  }
}

/**
 * Build test arguments for wrapper method calls, providing values for required exposed params.
 */
function buildWrapperTestArgs(wrapper: import('@workos/oagen').ResolvedWrapper, ctx: EmitterContext): string {
  const params = resolveWrapperParams(wrapper, ctx);
  const args: string[] = [];
  for (const { paramName, field, isOptional } of params) {
    if (isOptional) continue;
    const phpName = toCamelCase(paramName);
    const value = field ? generateTestValue(field.type, ctx) : "'test_value'";
    args.push(`${phpName}: ${value}`);
  }
  return args.join(', ');
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
 * Emit field hydration assertions: verify that deserialized model fields
 * match the fixture data. Checks up to 2 primitive string fields (id + one more).
 */
function emitFieldHydrationAssertions(
  lines: string[],
  modelName: string,
  resultVar: string,
  fixtureVar: string,
  ctx: EmitterContext,
): void {
  const model = ctx.spec.models.find((m) => m.name === modelName);
  if (!model) return;

  // Pick required primitive string fields for assertion (id first, then others)
  const candidates = model.fields.filter(
    (f) => f.required && f.type.kind === 'primitive' && f.type.type === 'string' && !f.type.format,
  );
  const idField = candidates.find((f) => f.name === 'id');
  const others = candidates.filter((f) => f.name !== 'id');
  const assertFields = [idField, others[0]].filter(Boolean);

  for (const f of assertFields) {
    if (!f) continue;
    const phpProp = toCamelCase(f.name);
    lines.push(`        $this->assertSame(${fixtureVar}['${f.name}'], ${resultVar}->${phpProp});`);
  }
}

/**
 * Emit query string assertions for list operations.
 * Asserts that all query params (including optional enums) are serialized correctly.
 */
function emitQueryAssertions(lines: string[], op: Operation, ctx: EmitterContext, hidden?: Set<string>): void {
  if (op.queryParams.length === 0) return;
  lines.push('        parse_str($request->getUri()->getQuery(), $query);');
  for (const q of op.queryParams) {
    if (hidden?.has(q.name)) continue;
    const innerType =
      q.type.kind === 'nullable' ? (q.type as { inner: { kind: string; type?: string; name?: string } }).inner : q.type;
    if (innerType.kind === 'enum' && innerType.name) {
      // Assert enum is serialized as its backing value, not the enum instance
      const e = ctx.spec.enums.find((en) => en.name === innerType.name);
      if (e && e.values.length > 0) {
        lines.push(`        $this->assertSame('${e.values[0].value}', $query['${q.name}']);`);
      }
    } else if (innerType.kind === 'primitive') {
      switch (innerType.type) {
        case 'string':
          lines.push(`        $this->assertSame('test_value', $query['${q.name}']);`);
          break;
        case 'integer':
        case 'number':
          lines.push(`        $this->assertArrayHasKey('${q.name}', $query);`);
          break;
        case 'boolean':
          lines.push(`        $this->assertArrayHasKey('${q.name}', $query);`);
          break;
      }
    }
  }
}

/**
 * Emit body field assertions for POST/PUT/PATCH operations.
 * Only asserts primitive required fields (strings, numbers, booleans).
 */
function emitBodyAssertions(lines: string[], op: Operation, ctx: EmitterContext, hidden?: Set<string>): void {
  if (op.requestBody?.kind !== 'model') return;
  const bodyModel = ctx.spec.models.find((m) => m.name === (op.requestBody as { name: string }).name);
  if (!bodyModel) return;
  // Skip fields that collide with path param names (they get deduped in the resource)
  const pathParamNames = new Set(op.pathParams.map((p) => p.name));
  const primitiveRequired = bodyModel.fields.filter(
    (f) =>
      f.required &&
      (f.type.kind === 'primitive' || f.type.kind === 'literal') &&
      !pathParamNames.has(f.name) &&
      !hidden?.has(f.name),
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
