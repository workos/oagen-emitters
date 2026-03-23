import type { ApiSpec, Service, Operation, Model, TypeRef, EmitterContext, GeneratedFile } from '@workos/oagen';
import { planOperation, toCamelCase } from '@workos/oagen';
import {
  fieldName,
  wireFieldName,
  fileName,
  serviceDirName,
  servicePropertyName,
  resolveMethodName,
  resolveServiceName,
} from './naming.js';
import { generateFixtures } from './fixtures.js';

export function generateTests(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  // Generate fixture JSON files
  const fixtures = generateFixtures(spec, ctx);
  for (const f of fixtures) {
    files.push({ path: f.path, content: f.content, headerPlacement: 'skip' });
  }

  // Build model lookup for response field assertions
  const modelMap = new Map(spec.models.map((m) => [m.name, m]));

  // Generate test files per service
  for (const service of spec.services) {
    files.push(generateServiceTest(service, spec, ctx, modelMap));
  }

  return files;
}

function generateServiceTest(
  service: Service,
  spec: ApiSpec,
  ctx: EmitterContext,
  modelMap: Map<string, Model>,
): GeneratedFile {
  const resolvedName = resolveServiceName(service, ctx);
  const serviceDir = serviceDirName(resolvedName);
  const serviceClass = resolvedName;
  const serviceProp = servicePropertyName(resolvedName);
  const testPath = `src/${serviceDir}/${fileName(resolvedName)}.spec.ts`;

  const plans = service.operations.map((op) => ({
    op,
    plan: planOperation(op),
    method: resolveMethodName(op, service, ctx),
  }));

  const lines: string[] = [];

  lines.push("import fetch from 'jest-fetch-mock';");

  // Conditionally import test utilities based on what test types exist
  const hasPaginated = plans.some((p) => p.plan.isPaginated);
  const hasBody = plans.some((p) => p.plan.hasBody && p.plan.responseModelName);
  const testUtils = ['fetchOnce', 'fetchURL'];
  if (hasPaginated) testUtils.push('fetchSearchParams');
  if (hasBody) testUtils.push('fetchBody');
  lines.push('import {');
  for (const util of testUtils) {
    lines.push(`  ${util},`);
  }
  lines.push("} from '../common/utils/test-utils';");
  lines.push("import { WorkOS } from '../workos';");
  lines.push('');

  // Import fixtures
  const fixtureImports = new Set<string>();
  for (const { op, plan } of plans) {
    if (plan.isPaginated && op.pagination) {
      const itemModelName = op.pagination.itemType.kind === 'model' ? op.pagination.itemType.name : null;
      if (itemModelName) {
        fixtureImports.add(
          `import list${itemModelName}Fixture from './fixtures/list-${fileName(itemModelName)}.fixture.json';`,
        );
      }
    } else if (plan.responseModelName) {
      fixtureImports.add(
        `import ${toCamelCase(plan.responseModelName)}Fixture from './fixtures/${fileName(plan.responseModelName)}.fixture.json';`,
      );
    }
  }
  for (const imp of fixtureImports) {
    lines.push(imp);
  }

  lines.push('');
  lines.push("const workos = new WorkOS('sk_test_Sz3IQjepeSWaI4cMS4ms4sMuU');");
  lines.push('');
  lines.push(`describe('${serviceClass}', () => {`);
  lines.push('  beforeEach(() => fetch.resetMocks());');

  for (const { op, plan, method } of plans) {
    lines.push('');
    lines.push(`  describe('${method}', () => {`);

    if (plan.isPaginated) {
      renderPaginatedTest(lines, op, plan, method, serviceProp, modelMap);
    } else if (plan.isDelete) {
      renderDeleteTest(lines, op, method, serviceProp);
    } else if (plan.hasBody && plan.responseModelName) {
      renderBodyTest(lines, op, plan, method, serviceProp, modelMap);
    } else if (plan.responseModelName) {
      renderGetTest(lines, op, plan, method, serviceProp, modelMap);
    } else {
      renderVoidTest(lines, op, method, serviceProp);
    }

    // Error case test for all non-void operations
    if (plan.responseModelName || plan.isPaginated) {
      renderErrorTest(lines, op, plan, method, serviceProp);
    }

    lines.push('  });');
  }

  lines.push('});');

  return { path: testPath, content: lines.join('\n'), skipIfExists: true };
}

/** Build test arguments for all path params (handles multiple path params). */
function buildTestPathArgs(op: Operation): string {
  // Detect path template variables (may be more than op.pathParams if spec is incomplete)
  const templateVars = [...op.path.matchAll(/\{(\w+)\}/g)].map(([, name]) => fieldName(name));
  const declaredNames = new Set(op.pathParams.map((p) => fieldName(p.name)));
  // Merge declared + template vars, deduplicate, preserve order
  const allVars: string[] = [];
  for (const p of op.pathParams) {
    allVars.push(fieldName(p.name));
  }
  for (const v of templateVars) {
    if (!declaredNames.has(v)) allVars.push(v);
  }
  return allVars.map(() => "'test_id'").join(', ');
}

function renderPaginatedTest(
  lines: string[],
  op: Operation,
  plan: any,
  method: string,
  serviceProp: string,
  modelMap: Map<string, Model>,
): void {
  const itemModelName = op.pagination?.itemType.kind === 'model' ? op.pagination.itemType.name : 'Item';
  const pathArgs = buildTestPathArgs(op);

  lines.push("    it('returns paginated results', async () => {");
  lines.push(`      fetchOnce(list${itemModelName}Fixture);`);
  lines.push('');
  lines.push(
    `      const { data, listMetadata } = await workos.${serviceProp}.${method}(${pathArgs ? pathArgs + ', ' : ''});`,
  );
  lines.push('');
  lines.push(`      expect(fetchURL()).toContain('${op.path.split('{')[0]}');`);
  lines.push("      expect(fetchSearchParams()).toHaveProperty('order');");
  lines.push('      expect(Array.isArray(data)).toBe(true);');
  lines.push('      expect(listMetadata).toBeDefined();');

  // Assert on first item fields when item model is available
  const itemModel = modelMap.get(itemModelName);
  if (itemModel) {
    const assertions = buildFieldAssertions(itemModel, 'data[0]');
    if (assertions.length > 0) {
      lines.push('      expect(data.length).toBeGreaterThan(0);');
      for (const assertion of assertions) {
        lines.push(`      ${assertion}`);
      }
    }
  }

  lines.push('    });');
}

function renderDeleteTest(lines: string[], op: Operation, method: string, serviceProp: string): void {
  const pathArgs = buildTestPathArgs(op);

  lines.push("    it('sends a DELETE request', async () => {");
  lines.push('      fetchOnce({}, { status: 204 });');
  lines.push('');
  lines.push(`      await workos.${serviceProp}.${method}(${pathArgs});`);
  lines.push('');
  lines.push(`      expect(fetchURL()).toContain('${op.path.split('{')[0]}');`);
  if (pathArgs) {
    lines.push("      expect(fetchURL()).toContain('test_id');");
  }
  lines.push('    });');
}

function renderBodyTest(
  lines: string[],
  op: Operation,
  plan: any,
  method: string,
  serviceProp: string,
  modelMap: Map<string, Model>,
): void {
  const responseModelName = plan.responseModelName!;
  const fixture = `${toCamelCase(responseModelName)}Fixture`;
  const pathArgs = buildTestPathArgs(op);
  const allArgs = pathArgs ? `${pathArgs}, {} as any` : '{} as any';

  lines.push("    it('sends the correct request and returns result', async () => {");
  lines.push(`      fetchOnce(${fixture});`);
  lines.push('');
  lines.push(`      const result = await workos.${serviceProp}.${method}(${allArgs});`);
  lines.push('');
  lines.push(`      expect(fetchURL()).toContain('${op.path.split('{')[0]}');`);
  if (pathArgs) {
    lines.push("      expect(fetchURL()).toContain('test_id');");
  }
  lines.push('      expect(fetchBody()).toBeDefined();');
  lines.push('      expect(result).toBeDefined();');

  // Response field assertions
  const responseModel = modelMap.get(responseModelName);
  if (responseModel) {
    const assertions = buildFieldAssertions(responseModel, 'result');
    for (const assertion of assertions) {
      lines.push(`      ${assertion}`);
    }
  }

  lines.push('    });');
}

function renderGetTest(
  lines: string[],
  op: Operation,
  plan: any,
  method: string,
  serviceProp: string,
  modelMap: Map<string, Model>,
): void {
  const responseModelName = plan.responseModelName!;
  const fixture = `${toCamelCase(responseModelName)}Fixture`;
  const pathArgs = buildTestPathArgs(op);

  lines.push("    it('returns the expected result', async () => {");
  lines.push(`      fetchOnce(${fixture});`);
  lines.push('');
  lines.push(`      const result = await workos.${serviceProp}.${method}(${pathArgs});`);
  lines.push('');
  lines.push(`      expect(fetchURL()).toContain('${op.path.split('{')[0]}');`);
  if (pathArgs) {
    lines.push("      expect(fetchURL()).toContain('test_id');");
  }
  lines.push('      expect(result).toBeDefined();');

  // Response field assertions
  const responseModel = modelMap.get(responseModelName);
  if (responseModel) {
    const assertions = buildFieldAssertions(responseModel, 'result');
    for (const assertion of assertions) {
      lines.push(`      ${assertion}`);
    }
  }

  lines.push('    });');
}

function renderVoidTest(lines: string[], op: Operation, method: string, serviceProp: string): void {
  const pathArgs = buildTestPathArgs(op);

  lines.push("    it('sends the request', async () => {");
  lines.push('      fetchOnce({});');
  lines.push('');
  lines.push(`      await workos.${serviceProp}.${method}(${pathArgs});`);
  lines.push('');
  lines.push(`      expect(fetchURL()).toContain('${op.path.split('{')[0]}');`);
  if (pathArgs) {
    lines.push("      expect(fetchURL()).toContain('test_id');");
  }
  lines.push('    });');
}

function renderErrorTest(lines: string[], op: Operation, plan: any, method: string, serviceProp: string): void {
  const pathArgs = buildTestPathArgs(op);
  const isPaginated = plan.isPaginated;
  const hasBody = plan.hasBody;

  let args: string;
  if (isPaginated) {
    args = pathArgs || '';
  } else if (hasBody) {
    args = pathArgs ? `${pathArgs}, {} as any` : '{} as any';
  } else {
    args = pathArgs || '';
  }

  lines.push('');
  lines.push("    it('throws on unauthorized', async () => {");
  lines.push("      fetchOnce({ message: 'Unauthorized' }, { status: 401 });");
  lines.push('');
  lines.push(`      await expect(workos.${serviceProp}.${method}(${args})).rejects.toThrow();`);
  lines.push('    });');
}

/**
 * Build field-level assertions for top-level primitive fields of a response model.
 * Returns lines like: expect(result.fieldName).toBe(fixtureValue);
 */
function buildFieldAssertions(model: Model, accessor: string): string[] {
  const assertions: string[] = [];

  for (const field of model.fields) {
    if (!field.required) continue;
    const value = fixtureValueForType(field.type, field.name);
    if (value === null) continue;
    const domainField = fieldName(field.name);
    assertions.push(`expect(${accessor}.${domainField}).toBe(${value});`);
  }

  return assertions;
}

/**
 * Return a JS literal string for the expected fixture value of a primitive field.
 * Returns null for non-primitive or complex types (arrays, models, etc.).
 */
function fixtureValueForType(ref: TypeRef, name: string): string | null {
  switch (ref.kind) {
    case 'primitive':
      return fixtureValueForPrimitive(ref.type, ref.format, name);
    case 'literal':
      return typeof ref.value === 'string' ? `'${ref.value}'` : String(ref.value);
    default:
      return null;
  }
}

function fixtureValueForPrimitive(type: string, format: string | undefined, name: string): string | null {
  switch (type) {
    case 'string':
      if (format === 'date-time') return "'2023-01-01T00:00:00.000Z'";
      if (format === 'date') return "'2023-01-01'";
      if (format === 'uuid') return "'00000000-0000-0000-0000-000000000000'";
      if (name.includes('id')) return `'${wireFieldName(name)}_01234'`;
      if (name.includes('email')) return "'test@example.com'";
      if (name.includes('url') || name.includes('uri')) return "'https://example.com'";
      if (name.includes('name')) return "'Test'";
      return `'test_${wireFieldName(name)}'`;
    case 'integer':
      return '1';
    case 'number':
      return '1';
    case 'boolean':
      return 'true';
    default:
      return null;
  }
}
