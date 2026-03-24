import type { ApiSpec, Service, Operation, Model, TypeRef, EmitterContext, GeneratedFile } from '@workos/oagen';
import { planOperation, toCamelCase } from '@workos/oagen';
import { unwrapListModel } from './fixtures.js';
import {
  fieldName,
  wireFieldName,
  fileName,
  serviceDirName,
  servicePropertyName,
  resolveMethodName,
  resolveServiceName,
  resolveInterfaceName,
} from './naming.js';
import { generateFixtures } from './fixtures.js';
import { createServiceDirResolver, isServiceCoveredByExisting, relativeImport } from './utils.js';
import { assignModelsToServices } from '@workos/oagen';

export function generateTests(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  // Generate fixture JSON files
  const fixtures = generateFixtures(spec, ctx);
  for (const f of fixtures) {
    files.push({ path: f.path, content: f.content, headerPlacement: 'skip' });
  }

  // Build model lookup for response field assertions
  const modelMap = new Map(spec.models.map((m) => [m.name, m]));

  // Generate test files per service — skip services whose endpoints are fully
  // covered by existing hand-written service classes.
  for (const service of spec.services) {
    if (isServiceCoveredByExisting(service, ctx)) continue;
    files.push(generateServiceTest(service, spec, ctx, modelMap));
  }

  // Generate serializer round-trip tests
  const serializerTests = generateSerializerTests(spec, ctx);
  for (const f of serializerTests) {
    files.push(f);
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

  // Compute model-to-service mapping so fixture imports use the correct cross-service path.
  // A test for service A may reference a response model owned by service B — the fixture
  // lives in service B's fixtures directory, not service A's.
  const { modelToService, resolveDir } = createServiceDirResolver(spec.models, spec.services, ctx);

  const lines: string[] = [];

  lines.push("import fetch from 'jest-fetch-mock';");

  // Conditionally import test utilities based on what test types exist
  const hasPaginated = plans.some((p) => p.plan.isPaginated);
  const hasBody = plans.some((p) => p.plan.hasBody);
  const testUtils = ['fetchOnce', 'fetchURL', 'fetchMethod'];
  if (hasPaginated) testUtils.push('fetchSearchParams');
  if (hasBody) testUtils.push('fetchBody');
  lines.push('import {');
  for (const util of testUtils) {
    lines.push(`  ${util},`);
  }
  lines.push("} from '../common/utils/test-utils';");
  lines.push("import { WorkOS } from '../workos';");
  lines.push('');

  // Import fixtures — use correct cross-service paths when the response model
  // is owned by a different service than the current test file.
  const fixtureImports = new Set<string>();
  for (const { op, plan } of plans) {
    if (plan.isPaginated && op.pagination) {
      let itemModelName = op.pagination.itemType.kind === 'model' ? op.pagination.itemType.name : null;
      if (itemModelName) {
        // Unwrap list wrapper models to match the fixture file naming in fixtures.ts
        const rawModel = modelMap.get(itemModelName);
        if (rawModel) {
          const unwrapped = unwrapListModel(rawModel, modelMap);
          if (unwrapped) {
            itemModelName = unwrapped.name;
          }
        }
        const itemService = modelToService.get(itemModelName);
        const itemDir = resolveDir(itemService);
        const fixturePath =
          itemDir === serviceDir
            ? `./fixtures/list-${fileName(itemModelName)}.fixture.json`
            : `../${itemDir}/fixtures/list-${fileName(itemModelName)}.fixture.json`;
        fixtureImports.add(`import list${itemModelName}Fixture from '${fixturePath}';`);
      }
    } else if (plan.responseModelName) {
      const respService = modelToService.get(plan.responseModelName);
      const respDir = resolveDir(respService);
      const fixturePath =
        respDir === serviceDir
          ? `./fixtures/${fileName(plan.responseModelName)}.fixture.json`
          : `../${respDir}/fixtures/${fileName(plan.responseModelName)}.fixture.json`;
      fixtureImports.add(`import ${toCamelCase(plan.responseModelName)}Fixture from '${fixturePath}';`);
    }
    // NOTE: Request body fixtures are not imported for body tests because
    // fixtures use wire format (snake_case) but methods expect domain types
    // (camelCase).  Body tests use `{} as any` instead.
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
      renderDeleteTest(lines, op, plan, method, serviceProp);
    } else if (plan.hasBody && plan.responseModelName) {
      renderBodyTest(lines, op, plan, method, serviceProp, modelMap);
    } else if (plan.responseModelName) {
      renderGetTest(lines, op, plan, method, serviceProp, modelMap);
    } else {
      renderVoidTest(lines, op, plan, method, serviceProp);
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

/**
 * Extract static path segments for URL assertions.
 * For a path like `/users/{id}/email_verification/send`, returns
 * ['/users/', '/email_verification/send'] so tests assert all distinct segments.
 */
function staticPathSegments(path: string): string[] {
  // Split on `{...}` placeholders and filter out empty strings
  return path.split(/\{[^}]+\}/).filter((s) => s.length > 0);
}

/** Compute the test value for a single path parameter. */
function pathParamTestValue(param: { type: TypeRef } | undefined): string {
  if (param?.type.kind === 'enum' && param.type.values?.length) {
    const first = param.type.values[0];
    return typeof first === 'string' ? first : String(first);
  }
  return 'test_id';
}

/** Build test arguments for all path params (handles multiple path params). */
function buildTestPathArgs(op: Operation): string {
  // Detect path template variables (may be more than op.pathParams if spec is incomplete)
  const templateVars = [...op.path.matchAll(/\{(\w+)\}/g)].map(([, name]) => fieldName(name));
  const declaredNames = new Set(op.pathParams.map((p) => fieldName(p.name)));
  const paramByName = new Map(op.pathParams.map((p) => [fieldName(p.name), p]));
  // Merge declared + template vars, deduplicate, preserve order
  const allVars: string[] = [];
  for (const p of op.pathParams) allVars.push(fieldName(p.name));
  for (const v of templateVars) {
    if (!declaredNames.has(v)) allVars.push(v);
  }
  return allVars.map((varName) => `'${pathParamTestValue(paramByName.get(varName))}'`).join(', ');
}

/** Get a URL-safe string that should appear in the path for assertions. */
function buildTestPathAssertionValue(op: Operation): string {
  const paramByName = new Map(op.pathParams.map((p) => [fieldName(p.name), p]));
  // Use the first path param's test value for the assertion
  if (op.pathParams.length > 0) {
    return pathParamTestValue(paramByName.get(fieldName(op.pathParams[0].name)));
  }
  const templateVars = [...op.path.matchAll(/\{(\w+)\}/g)].map(([, name]) => fieldName(name));
  return templateVars.length > 0 ? 'test_id' : '';
}

function renderPaginatedTest(
  lines: string[],
  op: Operation,
  plan: any,
  method: string,
  serviceProp: string,
  modelMap: Map<string, Model>,
): void {
  let itemModelName = op.pagination?.itemType.kind === 'model' ? op.pagination.itemType.name : 'Item';
  // Unwrap list wrapper models to match the fixture file naming in fixtures.ts
  const rawModel = itemModelName !== 'Item' ? modelMap.get(itemModelName) : null;
  if (rawModel) {
    const unwrapped = unwrapListModel(rawModel, modelMap);
    if (unwrapped) {
      itemModelName = unwrapped.name;
    }
  }
  const pathArgs = buildTestPathArgs(op);

  lines.push("    it('returns paginated results', async () => {");
  lines.push(`      fetchOnce(list${itemModelName}Fixture);`);
  lines.push('');
  lines.push(
    `      const { data, listMetadata } = await workos.${serviceProp}.${method}(${pathArgs ? pathArgs + ', ' : ''});`,
  );
  lines.push('');
  lines.push("      expect(fetchMethod()).toBe('GET');");
  // Fix #12: Full URL path assertion instead of toContain()
  const expectedPath = buildExpectedPath(op);
  lines.push(`      expect(new URL(String(fetchURL())).pathname).toBe('${expectedPath}');`);
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

  // Edge case: handles empty results
  lines.push('');
  lines.push("    it('handles empty results', async () => {");
  lines.push('      fetchOnce({ data: [], list_metadata: { before: null, after: null } });');
  lines.push('');
  lines.push(`      const { data } = await workos.${serviceProp}.${method}(${pathArgs ? pathArgs + ', ' : ''});`);
  lines.push('');
  lines.push('      expect(data).toEqual([]);');
  lines.push('    });');

  // Edge case: forwards pagination params
  lines.push('');
  lines.push("    it('forwards pagination params', async () => {");
  lines.push(`      fetchOnce(list${itemModelName}Fixture);`);
  lines.push('');
  lines.push(
    `      await workos.${serviceProp}.${method}(${pathArgs ? pathArgs + ', ' : ''}{ limit: 10, after: 'cursor_abc' });`,
  );
  lines.push('');
  lines.push("      expect(fetchSearchParams().get('limit')).toBe('10');");
  lines.push("      expect(fetchSearchParams().get('after')).toBe('cursor_abc');");
  lines.push('    });');
}

function renderDeleteTest(lines: string[], op: Operation, plan: any, method: string, serviceProp: string): void {
  const pathArgs = buildTestPathArgs(op);
  // Include body argument when the delete operation has a request body,
  // matching the generated method signature from renderDeleteWithBodyMethod
  const args = plan.hasBody ? (pathArgs ? `${pathArgs}, {} as any` : '{} as any') : pathArgs;

  lines.push("    it('sends a DELETE request', async () => {");
  lines.push('      fetchOnce({}, { status: 204 });');
  lines.push('');
  lines.push(`      await workos.${serviceProp}.${method}(${args});`);
  lines.push('');
  lines.push("      expect(fetchMethod()).toBe('DELETE');");
  // Fix #12: Full URL path assertion instead of toContain()
  const expectedPathDel = buildExpectedPath(op);
  lines.push(`      expect(new URL(String(fetchURL())).pathname).toBe('${expectedPathDel}');`);
  if (plan.hasBody) {
    lines.push('      expect(fetchBody()).toBeDefined();');
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

  // Fix #10: Build realistic payload from request body model fields
  const payload = buildTestPayload(op, modelMap);
  const payloadArg = payload ? payload.camelCaseObj : '{}';

  lines.push("    it('sends the correct request and returns result', async () => {");
  lines.push(`      fetchOnce(${fixture});`);
  lines.push('');
  lines.push(`      const result = await workos.${serviceProp}.${method}(${allArgs});`);
  lines.push('');
  lines.push(`      expect(fetchMethod()).toBe('${op.httpMethod.toUpperCase()}');`);

  // Fix #12: Full URL path assertion instead of toContain()
  const expectedPath = buildExpectedPath(op);
  lines.push(`      expect(new URL(String(fetchURL())).pathname).toBe('${expectedPath}');`);

  // Fix #10: Assert serialized wire format of request body
  if (payload) {
    lines.push(`      expect(fetchBody()).toEqual(expect.objectContaining(${payload.snakeCaseObj}));`);
  } else {
    lines.push('      expect(fetchBody()).toBeDefined();');
  }

  // Fix #11: Response field assertions (no redundant toBeDefined())
  const responseModel = modelMap.get(responseModelName);
  if (responseModel) {
    const assertions = buildFieldAssertions(responseModel, 'result');
    if (assertions.length > 0) {
      for (const assertion of assertions) {
        lines.push(`      ${assertion}`);
      }
    } else {
      lines.push('      expect(result).toBeDefined();');
    }
  } else {
    lines.push('      expect(result).toBeDefined();');
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
  lines.push(`      expect(fetchMethod()).toBe('${op.httpMethod.toUpperCase()}');`);
  // Fix #12: Full URL path assertion instead of toContain()
  const expectedPathGet = buildExpectedPath(op);
  lines.push(`      expect(new URL(String(fetchURL())).pathname).toBe('${expectedPathGet}');`);

  // Fix #11: Response field assertions (no redundant toBeDefined())
  const responseModel = modelMap.get(responseModelName);
  if (responseModel) {
    const assertions = buildFieldAssertions(responseModel, 'result');
    if (assertions.length > 0) {
      for (const assertion of assertions) {
        lines.push(`      ${assertion}`);
      }
    } else {
      lines.push('      expect(result).toBeDefined();');
    }
  } else {
    lines.push('      expect(result).toBeDefined();');
  }

  lines.push('    });');
}

function renderVoidTest(lines: string[], op: Operation, plan: any, method: string, serviceProp: string): void {
  const pathArgs = buildTestPathArgs(op);
  // Include body argument when the operation has a request body,
  // matching the generated method signature from renderVoidMethod
  const args = plan.hasBody ? (pathArgs ? `${pathArgs}, {} as any` : '{} as any') : pathArgs;

  lines.push("    it('sends the request', async () => {");
  lines.push('      fetchOnce({});');
  lines.push('');
  lines.push(`      await workos.${serviceProp}.${method}(${args});`);
  lines.push('');
  lines.push(`      expect(fetchMethod()).toBe('${op.httpMethod.toUpperCase()}');`);
  // Fix #12: Full URL path assertion instead of toContain()
  const expectedPathVoid = buildExpectedPath(op);
  lines.push(`      expect(new URL(String(fetchURL())).pathname).toBe('${expectedPathVoid}');`);
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

/**
 * Build the expected full URL path for an operation, substituting path params
 * with their test values. Returns a string like '/organizations/test_id'.
 */
function buildExpectedPath(op: Operation): string {
  let path = op.path;
  for (const param of op.pathParams) {
    path = path.replace(`{${param.name}}`, 'test_id');
  }
  return path;
}

/**
 * Build a realistic test payload for a request body model.
 * Returns { camelCaseObj, snakeCaseObj } as inline JS object literal strings,
 * or null if the request body is not a named model.
 *
 * camelCaseObj is what the SDK consumer passes (e.g. { organizationName: 'Test' })
 * snakeCaseObj is the expected wire format (e.g. { organization_name: 'Test' })
 */
function buildTestPayload(
  op: Operation,
  modelMap: Map<string, Model>,
): { camelCaseObj: string; snakeCaseObj: string } | null {
  if (!op.requestBody || op.requestBody.kind !== 'model') return null;

  const model = modelMap.get(op.requestBody.name);
  if (!model) return null;

  const fields = model.fields.filter((f) => f.required);
  // Only use primitive/literal fields that we can generate deterministic values for
  const usableFields = fields.filter((f) => fixtureValueForType(f.type, f.name) !== null);

  if (usableFields.length === 0) return null;

  const camelEntries: string[] = [];
  const snakeEntries: string[] = [];

  for (const field of usableFields) {
    const value = fixtureValueForType(field.type, field.name)!;
    const camelKey = fieldName(field.name);
    const snakeKey = wireFieldName(field.name);
    camelEntries.push(`${camelKey}: ${value}`);
    snakeEntries.push(`${snakeKey}: ${value}`);
  }

  return {
    camelCaseObj: `{ ${camelEntries.join(', ')} }`,
    snakeCaseObj: `{ ${snakeEntries.join(', ')} }`,
  };
}

/**
 * Check whether a TypeRef involves nested serialization (model refs, arrays of models,
 * date-time formats, etc.) that would require non-trivial serialize/deserialize logic.
 */
function hasNestedSerialization(ref: TypeRef): boolean {
  switch (ref.kind) {
    case 'model':
      return true;
    case 'array':
      return hasNestedSerialization(ref.items);
    case 'nullable':
      return hasNestedSerialization(ref.inner);
    case 'union':
      return ref.variants.some(hasNestedSerialization);
    case 'primitive':
      return ref.format === 'date-time' || ref.format === 'int64';
    case 'map':
      return hasNestedSerialization(ref.valueType);
    case 'literal':
    case 'enum':
      return false;
  }
}

/**
 * Determine whether a model has any fields that require non-trivial serialization.
 * Simple flat models (all primitives without special formats) are excluded.
 */
function modelNeedsRoundTripTest(model: Model): boolean {
  return model.fields.some((field) => hasNestedSerialization(field.type));
}

/**
 * Generate serializer round-trip tests for models that have both serialize and
 * deserialize functions and have nested types requiring non-trivial serialization.
 */
function generateSerializerTests(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const modelToService = assignModelsToServices(spec.models, spec.services);
  const serviceNameMap = new Map<string, string>();
  for (const service of spec.services) {
    serviceNameMap.set(service.name, resolveServiceName(service, ctx));
  }
  const resolveDir = (irService: string | undefined) =>
    irService ? serviceDirName(serviceNameMap.get(irService) ?? irService) : 'common';

  // Only generate round-trip tests for models with nested serialization
  const eligibleModels = spec.models.filter(modelNeedsRoundTripTest);

  if (eligibleModels.length === 0) return files;

  // Group eligible models by service directory for one test file per service
  const modelsByDir = new Map<string, Model[]>();
  for (const model of eligibleModels) {
    const service = modelToService.get(model.name);
    const dirName = resolveDir(service);
    if (!modelsByDir.has(dirName)) {
      modelsByDir.set(dirName, []);
    }
    modelsByDir.get(dirName)!.push(model);
  }

  for (const [dirName, models] of modelsByDir) {
    const testPath = `src/${dirName}/serializers.spec.ts`;
    const lines: string[] = [];

    // Collect imports
    const serializerImports: string[] = [];
    const fixtureImports: string[] = [];

    for (const model of models) {
      const domainName = resolveInterfaceName(model.name, ctx);
      const service = modelToService.get(model.name);
      const modelDir = resolveDir(service);
      const serializerPath = `src/${modelDir}/serializers/${fileName(model.name)}.serializer.ts`;
      const fixturePath = `src/${modelDir}/fixtures/${fileName(model.name)}.fixture.json`;

      serializerImports.push(
        `import { deserialize${domainName}, serialize${domainName} } from '${relativeImport(testPath, serializerPath)}';`,
      );
      fixtureImports.push(
        `import ${toCamelCase(model.name)}Fixture from '${relativeImport(testPath, fixturePath)}.json';`,
      );
    }

    for (const imp of serializerImports) {
      lines.push(imp);
    }
    for (const imp of fixtureImports) {
      lines.push(imp);
    }
    lines.push('');

    for (const model of models) {
      const domainName = resolveInterfaceName(model.name, ctx);
      const fixtureName = `${toCamelCase(model.name)}Fixture`;

      lines.push(`describe('${domainName}Serializer', () => {`);
      lines.push("  it('round-trips through serialize/deserialize', () => {");
      lines.push(`    const fixture = ${fixtureName};`);
      lines.push(`    const deserialized = deserialize${domainName}(fixture);`);
      lines.push(`    const reserialized = serialize${domainName}(deserialized);`);
      lines.push('    expect(reserialized).toEqual(fixture);');
      lines.push('  });');
      lines.push('});');
      lines.push('');
    }

    files.push({
      path: testPath,
      content: lines.join('\n'),
      skipIfExists: true,
      integrateTarget: false,
    });
  }

  return files;
}
