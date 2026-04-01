import type { ApiSpec, EmitterContext, GeneratedFile, Service, Operation } from '@workos/oagen';
import { planOperation } from '@workos/oagen';
import { className, fieldName, resolveMethodName, resolveClassName, servicePropertyName } from './naming.js';
import { generateFixtures } from './fixtures.js';

/**
 * Generate PHPUnit test files and JSON fixtures.
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
      integrateTarget: false,
    });
  }

  // Generate test helper
  files.push(generateTestHelper(ctx));

  // Generate per-resource test files
  for (const service of spec.services) {
    if (service.operations.length === 0) continue;
    files.push(generateResourceTest(service, spec, ctx));
  }

  // Generate client test
  files.push(generateClientTest(ctx));

  return files;
}

function generateTestHelper(ctx: EmitterContext): GeneratedFile {
  return {
    path: 'tests/TestHelper.php',
    content: `<?php

namespace Tests\\${ctx.namespacePascal};

use GuzzleHttp\\Handler\\MockHandler;
use GuzzleHttp\\HandlerStack;
use GuzzleHttp\\Psr7\\Response;
use ${ctx.namespacePascal}\\${ctx.namespacePascal};

trait TestHelper
{
    protected function loadFixture(string $name): array
    {
        $path = __DIR__ . '/Fixtures/' . $name . '.json';
        return json_decode(file_get_contents($path), true);
    }

    protected function createMockClient(array $responses): ${ctx.namespacePascal}
    {
        $mockResponses = array_map(
            fn (array $response) => new Response(
                $response['status'] ?? 200,
                $response['headers'] ?? [],
                json_encode($response['body'] ?? [])
            ),
            $responses,
        );

        $mock = new MockHandler($mockResponses);
        $handler = HandlerStack::create($mock);

        return new ${ctx.namespacePascal}(
            apiKey: 'test_api_key',
            handler: $handler,
        );
    }
}`,
    integrateTarget: false,
    headerPlacement: 'skip',
  };
}

function generateResourceTest(service: Service, spec: ApiSpec, ctx: EmitterContext): GeneratedFile {
  const resourceName = resolveClassName(service, ctx);
  const propName = servicePropertyName(resourceName);
  const lines: string[] = [];

  lines.push('<?php');
  lines.push('');
  lines.push(`namespace Tests\\${ctx.namespacePascal}\\Resources;`);
  lines.push('');
  lines.push('use PHPUnit\\Framework\\TestCase;');
  lines.push(`use Tests\\${ctx.namespacePascal}\\TestHelper;`);
  lines.push('');

  lines.push(`class ${resourceName}Test extends TestCase`);
  lines.push('{');
  lines.push('    use TestHelper;');

  for (const op of service.operations) {
    const plan = planOperation(op);
    const method = resolveMethodName(op, service, ctx);

    lines.push('');
    lines.push(`    public function test${capitalize(method)}(): void`);
    lines.push('    {');

    if (plan.isDelete) {
      // Delete operation — expect 204 no content
      lines.push('        $client = $this->createMockClient([');
      lines.push("            ['status' => 204, 'body' => []],");
      lines.push('        ]);');
      lines.push('');

      const callArgs = buildTestCallArgs(op, plan, ctx);
      lines.push(`        $client->${propName}()->${method}(${callArgs});`);
      lines.push('        $this->assertTrue(true); // No exception means success');
    } else if (plan.isPaginated) {
      // Paginated operation
      const itemType = op.pagination?.itemType;
      const itemName = itemType?.kind === 'model' ? className(itemType.name) : null;
      const fixtureName = itemName ? `list_${toSnakeCase(itemName)}` : null;

      if (fixtureName) {
        lines.push(`        $fixture = $this->loadFixture('${fixtureName}');`);
      } else {
        lines.push("        $fixture = ['data' => [], 'list_metadata' => ['after' => null]];");
      }
      lines.push('        $client = $this->createMockClient([');
      lines.push("            ['status' => 200, 'body' => $fixture],");
      lines.push('        ]);');
      lines.push('');

      const callArgs = buildTestCallArgs(op, plan, ctx);
      lines.push(`        $result = $client->${propName}()->${method}(${callArgs});`);
      lines.push(`        $this->assertInstanceOf(\\${ctx.namespacePascal}\\PaginatedResponse::class, $result);`);
    } else if (plan.responseModelName) {
      // Model response
      const modelName = className(plan.responseModelName);
      const fixtureName = toSnakeCase(plan.responseModelName);

      lines.push(`        $fixture = $this->loadFixture('${fixtureName}');`);
      lines.push('        $client = $this->createMockClient([');
      lines.push("            ['status' => 200, 'body' => $fixture],");
      lines.push('        ]);');
      lines.push('');

      const callArgs = buildTestCallArgs(op, plan, ctx);
      lines.push(`        $result = $client->${propName}()->${method}(${callArgs});`);
      lines.push(`        $this->assertInstanceOf(\\${ctx.namespacePascal}\\Models\\${modelName}::class, $result);`);
    } else {
      // Generic response
      lines.push('        $client = $this->createMockClient([');
      lines.push("            ['status' => 200, 'body' => []],");
      lines.push('        ]);');
      lines.push('');

      const callArgs = buildTestCallArgs(op, plan, ctx);
      lines.push(`        $result = $client->${propName}()->${method}(${callArgs});`);
      lines.push('        $this->assertIsArray($result);');
    }

    lines.push('    }');
  }

  lines.push('}');

  return {
    path: `tests/Resources/${resourceName}Test.php`,
    content: lines.join('\n'),
    integrateTarget: false,
    headerPlacement: 'skip',
  };
}

function generateClientTest(ctx: EmitterContext): GeneratedFile {
  return {
    path: 'tests/ClientTest.php',
    content: `<?php

namespace Tests\\${ctx.namespacePascal};

use PHPUnit\\Framework\\TestCase;
use ${ctx.namespacePascal}\\${ctx.namespacePascal};
use ${ctx.namespacePascal}\\Exceptions\\ConfigurationException;

class ClientTest extends TestCase
{
    public function testConstructorRequiresApiKey(): void
    {
        // Unset env var if set
        putenv('WORKOS_API_KEY');

        $this->expectException(ConfigurationException::class);
        new ${ctx.namespacePascal}(apiKey: '');
    }

    public function testConstructorAcceptsApiKey(): void
    {
        $client = new ${ctx.namespacePascal}(apiKey: 'test_key');
        $this->assertInstanceOf(${ctx.namespacePascal}::class, $client);
    }
}`,
    integrateTarget: false,
    headerPlacement: 'skip',
  };
}

function buildTestCallArgs(op: Operation, plan: any, ctx: EmitterContext): string {
  const args: string[] = [];

  // Path params
  for (const p of op.pathParams) {
    args.push(`'test_${p.name}'`);
  }

  // Required body fields
  if (plan.hasBody && op.requestBody?.kind === 'model') {
    const bodyModel = ctx.spec.models.find((m) => m.name === (op.requestBody as any).name);
    if (bodyModel) {
      for (const f of bodyModel.fields.filter((f: any) => f.required)) {
        const phpName = fieldName(f.name);
        args.push(`${phpName}: ${generateTestValue(f.type)}`);
      }
    }
  }

  return args.join(', ');
}

function generateTestValue(ref: any): string {
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
          return 'null';
      }
    case 'enum':
      return "'test_value'";
    case 'array':
      return '[]';
    case 'model':
      return '[]';
    default:
      return "'test_value'";
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function toSnakeCase(str: string): string {
  return str
    .replace(/([A-Z])/g, '_$1')
    .replace(/^_/, '')
    .toLowerCase();
}
