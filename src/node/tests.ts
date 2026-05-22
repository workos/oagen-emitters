import fs from 'node:fs';
import path from 'node:path';
import type { ApiSpec, Service, Operation, Model, TypeRef, EmitterContext, GeneratedFile } from '@workos/oagen';
import { planOperation, toCamelCase } from '@workos/oagen';
import { unwrapListModel, ID_PREFIXES } from './fixtures.js';
import {
  fieldName,
  wireFieldName,
  fileName,
  resolveServiceDir,
  servicePropertyName,
  resolveMethodName,
  resolveInterfaceName,
  resolveServiceName,
  wireInterfaceName,
} from './naming.js';
import { generateFixtures } from './fixtures.js';
import { resolveResourceClassName, resolveResourceDir } from './resources.js';
import {
  assignModelsToServices,
  createServiceDirResolver,
  uncoveredOperations,
  relativeImport,
  isListMetadataModel,
  isListWrapperModel,
  modelHasNewFields,
  computeNonEventReachable,
} from './utils.js';
import { groupByMount } from '../shared/resolved-ops.js';
import { isNodeOwnedService } from './options.js';

type BaselineMethod = {
  params: Array<{ name: string; type: string; optional?: boolean; passingStyle?: string }>;
  returnType?: string;
};

function baselineMethodFor(service: Service, method: string, ctx: EmitterContext): BaselineMethod | undefined {
  const serviceClass = resolveResourceClassName(service, ctx);
  return ctx.apiSurface?.classes?.[serviceClass]?.methods?.[method]?.[0] as BaselineMethod | undefined;
}

function optionsObjectParam(method: BaselineMethod | undefined): { name: string; type: string } | undefined {
  if (!method || method.params.length !== 1) return undefined;
  const [param] = method.params;
  if (param.name !== 'options') return undefined;
  if (param.passingStyle && param.passingStyle !== 'options_object') return undefined;
  if (!param.type || /^(Record|object|any|unknown)\b/.test(param.type)) return undefined;
  return { name: param.name, type: param.type };
}

function autoPaginatableItemType(returnType: string | undefined): string | undefined {
  return returnType?.match(/\bAutoPaginatable<\s*([A-Za-z_$][\w$]*)/)?.[1];
}

export function generateTests(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  // Generate fixture JSON files
  const fixtures = generateFixtures(spec, ctx);
  for (const f of fixtures) {
    files.push({ path: f.path, content: f.content, headerPlacement: 'skip', skipIfExists: true });
  }

  // Build model lookup for response field assertions
  const modelMap = new Map(spec.models.map((m) => [m.name, m]));

  // Generate test files per mount target — merges all sub-services into one
  // test file. Skip operations already covered by existing hand-written classes.
  const mountGroups = groupByMount(ctx);

  // Build mount-target → property name map so tests use the same accessor
  // as the generated client, even when the mount target name doesn't match
  // any IR service name directly.
  const mountAccessors = new Map<string, string>();
  for (const r of ctx.resolvedOperations ?? []) {
    if (!mountAccessors.has(r.mountOn)) {
      mountAccessors.set(r.mountOn, servicePropertyName(r.mountOn));
    }
  }

  const testEntries: Array<{ name: string; operations: Operation[] }> =
    mountGroups.size > 0
      ? [...mountGroups].map(([name, group]) => ({ name, operations: group.operations }))
      : spec.services.map((s) => ({ name: resolveResourceClassName(s, ctx), operations: s.operations }));

  // When integrating into an existing SDK, only generate tests for services
  // that have a registered property on the WorkOS class.  The WorkOS client
  // file uses skipIfExists, so new service properties aren't added — tests
  // referencing workos.<service> would fail at compile time.
  const baselineWorkOSProps = new Set<string>();
  if (ctx.apiSurface?.classes?.['WorkOS']?.methods) {
    // The extractor stores property accessors as methods
    for (const name of Object.keys(ctx.apiSurface.classes['WorkOS'].methods)) {
      baselineWorkOSProps.add(name);
    }
  }
  if (ctx.apiSurface?.classes?.['WorkOS']?.properties) {
    for (const name of Object.keys(ctx.apiSurface.classes['WorkOS'].properties)) {
      baselineWorkOSProps.add(name);
    }
  }

  for (const { name: mountName, operations } of testEntries) {
    if (operations.length === 0) continue;
    const mergedService: Service = { name: mountName, operations };
    const isOwnedService = isNodeOwnedService(ctx, mountName, resolveResourceClassName(mergedService, ctx));
    const ops = isOwnedService ? operations : uncoveredOperations(mergedService, ctx);
    if (ops.length === 0) continue;

    // Skip tests for services without a WorkOS property in the baseline
    const propName = mountAccessors.get(mountName) ?? servicePropertyName(mountName);
    if (ctx.apiSurface && baselineWorkOSProps.size > 0 && !baselineWorkOSProps.has(propName)) continue;

    // Skip when the resource class diverges from the mount accessor — this
    // happens for services with constructor-incompatible baselines (e.g.
    // hand-written `Webhooks(crypto)` forks the emitted ops onto
    // `WebhooksEndpoints`). The generated test would do
    // `workos.<propName>.fooMethod(...)`, but those methods live on a
    // different class, so the test would fail to compile.
    const resourceClass = resolveResourceClassName(mergedService, ctx);
    if (resourceClass !== mountName) continue;

    const testService = ops.length < operations.length ? { ...mergedService, operations: ops } : mergedService;
    files.push(generateServiceTest(testService, spec, ctx, modelMap, mountAccessors));
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
  mountAccessors?: Map<string, string>,
): GeneratedFile {
  const resolvedName = resolveResourceClassName(service, ctx);
  const serviceDir = resolveResourceDir(service, ctx);
  const serviceClass = resolvedName;
  // Accessor stays un-suffixed so `client.organizationMembership` resolves even
  // when the class was renamed to dodge a model-name collision.
  const serviceProp = mountAccessors?.get(service.name) ?? servicePropertyName(resolveServiceName(service, ctx));
  const testPath = `src/${serviceDir}/${fileName(resolvedName)}.spec.ts`;

  const plans = service.operations.map((op) => ({
    op,
    plan: planOperation(op),
    method: resolveMethodName(op, service, ctx),
  }));

  // Sort plans to match the existing file's method order (same as resources.ts).
  if (ctx.overlayLookup?.methodByOperation) {
    const methodOrder = new Map<string, number>();
    let pos = 0;
    for (const [, info] of ctx.overlayLookup.methodByOperation) {
      if (!methodOrder.has(info.methodName)) {
        methodOrder.set(info.methodName, pos++);
      }
    }
    if (methodOrder.size > 0) {
      plans.sort((a, b) => {
        const aPos = methodOrder.get(a.method) ?? Number.MAX_SAFE_INTEGER;
        const bPos = methodOrder.get(b.method) ?? Number.MAX_SAFE_INTEGER;
        return aPos - bPos;
      });
    }
  }

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
        // List fixtures are always generated in the current service's directory
        // (the service owning the list operation), not in the model's home service.
        // Always use a local import path.
        const fixturePath = `./fixtures/list-${fileName(itemModelName)}.json`;
        fixtureImports.add(`import list${itemModelName}Fixture from '${fixturePath}';`);
      }
    } else if (plan.responseModelName) {
      const respService = modelToService.get(plan.responseModelName);
      const respDir = resolveDir(respService);
      const fixturePath =
        respDir === serviceDir
          ? `./fixtures/${fileName(plan.responseModelName)}.json`
          : `../${respDir}/fixtures/${fileName(plan.responseModelName)}.json`;
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

  // Generate per-entity assertion helpers for models used in 2+ tests.
  // This deduplicates the field assertion blocks that would otherwise be
  // copy-pasted across list/find/create/update test cases.
  const { lines: helperLines, helpers: entityHelperNames } = generateEntityHelpers(plans, modelMap, ctx);
  for (const line of helperLines) {
    lines.push(line);
  }

  lines.push(`describe('${serviceClass}', () => {`);
  lines.push('  beforeEach(() => fetch.resetMocks());');

  for (const { op, plan, method } of plans) {
    const existingMethod = baselineMethodFor(service, method, ctx);
    lines.push('');
    lines.push(`  describe('${method}', () => {`);

    if (plan.isPaginated) {
      renderPaginatedTest(lines, op, plan, method, serviceProp, modelMap, ctx, entityHelperNames, existingMethod);
    } else if (plan.isDelete) {
      renderDeleteTest(lines, op, plan, method, serviceProp, modelMap, ctx, existingMethod);
    } else if (plan.hasBody && plan.responseModelName) {
      renderBodyTest(lines, op, plan, method, serviceProp, modelMap, ctx, entityHelperNames, existingMethod);
    } else if (plan.responseModelName) {
      renderGetTest(lines, op, plan, method, serviceProp, modelMap, ctx, entityHelperNames, existingMethod);
    } else {
      renderVoidTest(lines, op, plan, method, serviceProp, modelMap, ctx, existingMethod);
    }

    lines.push('  });');
  }

  lines.push('});');

  return { path: testPath, content: lines.join('\n'), overwriteExisting: true };
}

/** Compute the test value for a single path parameter.
 *  Uses distinct values per param name so multi-param paths don't all get 'test_id'.
 */
function pathParamTestValue(param: { type: TypeRef; name?: string } | undefined, paramName?: string): string {
  if (param?.type.kind === 'enum' && param.type.values?.length) {
    const first = param.type.values[0];
    return typeof first === 'string' ? first : String(first);
  }
  // Use distinct values for different path params to detect ordering bugs
  const name = paramName ?? (param as any)?.name;
  if (name) return `test_${fieldName(name)}`;
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
  return allVars.map((varName) => `'${pathParamTestValue(paramByName.get(varName), varName)}'`).join(', ');
}

function renderPaginatedTest(
  lines: string[],
  op: Operation,
  plan: any,
  method: string,
  serviceProp: string,
  modelMap: Map<string, Model>,
  ctx?: EmitterContext,
  entityHelpers?: Set<string>,
  baselineMethod?: BaselineMethod,
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
  const optionsArg = buildOptionsObjectTestArg(op, plan, baselineMethod, modelMap, ctx);
  const baselineItemType = autoPaginatableItemType(baselineMethod?.returnType);
  const generatedItemType = ctx ? resolveInterfaceName(itemModelName, ctx) : null;
  const skipFieldAssertions = Boolean(baselineItemType && generatedItemType && baselineItemType !== generatedItemType);

  lines.push("    it('returns paginated results', async () => {");
  lines.push(`      fetchOnce(list${itemModelName}Fixture);`);
  lines.push('');
  lines.push(`      const { data, listMetadata } = await workos.${serviceProp}.${method}(${optionsArg ?? pathArgs});`);
  lines.push('');
  lines.push("      expect(fetchMethod()).toBe('GET');");
  // Fix #12: Full URL path assertion instead of toContain()
  const expectedPath = buildExpectedPath(op);
  lines.push(`      expect(new URL(String(fetchURL())).pathname).toBe('${expectedPath}');`);
  lines.push("      expect(fetchSearchParams()).toHaveProperty('order');");
  lines.push('      expect(Array.isArray(data)).toBe(true);');
  lines.push('      expect(listMetadata).toBeDefined();');

  // Assert on first item fields — use entity helper if available
  const paginatedHelperName = ctx ? `expect${resolveInterfaceName(itemModelName, ctx)}` : null;
  if (skipFieldAssertions) {
    lines.push('      expect(data.length).toBeGreaterThan(0);');
  } else if (paginatedHelperName && entityHelpers?.has(paginatedHelperName)) {
    lines.push('      expect(data.length).toBeGreaterThan(0);');
    lines.push(`      ${paginatedHelperName}(data[0]);`);
  } else {
    const itemModel = modelMap.get(itemModelName);
    if (itemModel) {
      const assertions = buildFieldAssertions(itemModel, 'data[0]', modelMap);
      if (assertions.length > 0) {
        lines.push('      expect(data.length).toBeGreaterThan(0);');
        for (const assertion of assertions) {
          lines.push(`      ${assertion}`);
        }
      }
    }
  }

  lines.push('    });');
}

function renderDeleteTest(
  lines: string[],
  op: Operation,
  plan: any,
  method: string,
  serviceProp: string,
  modelMap: Map<string, Model>,
  ctx?: EmitterContext,
  baselineMethod?: BaselineMethod,
): void {
  const pathArgs = buildTestPathArgs(op);
  // Build realistic payload for body-bearing delete operations
  const payload = plan.hasBody ? buildTestPayload(op, modelMap) : null;
  const bodyArg = plan.hasBody ? (payload ? payload.camelCaseObj : fallbackBodyArg(op, modelMap)) : '';
  const optionsArg = buildOptionsObjectTestArg(op, plan, baselineMethod, modelMap, ctx);
  const args = optionsArg ?? (plan.hasBody ? (pathArgs ? `${pathArgs}, ${bodyArg}` : bodyArg) : pathArgs);

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
    if (payload) {
      lines.push(`      expect(fetchBody()).toEqual(expect.objectContaining(${payload.snakeCaseObj}));`);
    } else {
      lines.push('      expect(fetchBody()).toBeDefined();');
    }
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
  ctx?: EmitterContext,
  entityHelpers?: Set<string>,
  baselineMethod?: BaselineMethod,
): void {
  const responseModelName = plan.responseModelName!;
  const fixture = `${toCamelCase(responseModelName)}Fixture`;
  const pathArgs = buildTestPathArgs(op);

  // Build realistic payload from request body model fields
  const payload = buildTestPayload(op, modelMap);
  const payloadArg = payload ? payload.camelCaseObj : fallbackBodyArg(op, modelMap);
  const optionsArg = buildOptionsObjectTestArg(op, plan, baselineMethod, modelMap, ctx);
  const allArgs = optionsArg ?? (pathArgs ? `${pathArgs}, ${payloadArg}` : payloadArg);

  const isArrayResponse = !!plan.isArrayResponse;
  const fixtureExpr = isArrayResponse ? `[${fixture}]` : fixture;
  const accessor = isArrayResponse ? 'result[0]' : 'result';

  lines.push("    it('sends the correct request and returns result', async () => {");
  lines.push(`      fetchOnce(${fixtureExpr});`);
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

  if (isArrayResponse) {
    lines.push('      expect(Array.isArray(result)).toBe(true);');
  }

  // Use entity helper if available, otherwise inline assertions
  const bodyHelperName = ctx ? `expect${resolveInterfaceName(responseModelName, ctx)}` : null;
  if (bodyHelperName && entityHelpers?.has(bodyHelperName)) {
    lines.push(`      ${bodyHelperName}(${accessor});`);
  } else {
    const responseModel = modelMap.get(responseModelName);
    if (responseModel) {
      const assertions = buildFieldAssertions(responseModel, accessor, modelMap);
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
  ctx?: EmitterContext,
  entityHelpers?: Set<string>,
  baselineMethod?: BaselineMethod,
): void {
  const responseModelName = plan.responseModelName!;
  const fixture = `${toCamelCase(responseModelName)}Fixture`;
  const pathArgs = buildTestPathArgs(op);
  const optionsArg = buildOptionsObjectTestArg(op, plan, baselineMethod, modelMap, ctx);

  const isArrayResponse = !!plan.isArrayResponse;
  const fixtureExpr = isArrayResponse ? `[${fixture}]` : fixture;
  const accessor = isArrayResponse ? 'result[0]' : 'result';

  lines.push("    it('returns the expected result', async () => {");
  lines.push(`      fetchOnce(${fixtureExpr});`);
  lines.push('');
  lines.push(`      const result = await workos.${serviceProp}.${method}(${optionsArg ?? pathArgs});`);
  lines.push('');
  lines.push(`      expect(fetchMethod()).toBe('${op.httpMethod.toUpperCase()}');`);
  // Fix #12: Full URL path assertion instead of toContain()
  const expectedPathGet = buildExpectedPath(op);
  lines.push(`      expect(new URL(String(fetchURL())).pathname).toBe('${expectedPathGet}');`);
  if (isArrayResponse) {
    lines.push('      expect(Array.isArray(result)).toBe(true);');
  }

  // Use entity helper if available, otherwise inline assertions
  const helperName = ctx ? `expect${resolveInterfaceName(responseModelName, ctx)}` : null;
  if (helperName && entityHelpers?.has(helperName)) {
    lines.push(`      ${helperName}(${accessor});`);
  } else {
    const responseModel = modelMap.get(responseModelName);
    if (responseModel) {
      const assertions = buildFieldAssertions(responseModel, accessor, modelMap);
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
  }

  lines.push('    });');
}

function renderVoidTest(
  lines: string[],
  op: Operation,
  plan: any,
  method: string,
  serviceProp: string,
  modelMap: Map<string, Model>,
  ctx?: EmitterContext,
  baselineMethod?: BaselineMethod,
): void {
  const pathArgs = buildTestPathArgs(op);
  // Build realistic payload for body-bearing void operations
  const payload = plan.hasBody ? buildTestPayload(op, modelMap) : null;
  const bodyArg = plan.hasBody ? (payload ? payload.camelCaseObj : fallbackBodyArg(op, modelMap)) : '';
  const optionsArg = buildOptionsObjectTestArg(op, plan, baselineMethod, modelMap, ctx);
  const args = optionsArg ?? (plan.hasBody ? (pathArgs ? `${pathArgs}, ${bodyArg}` : bodyArg) : pathArgs);

  lines.push("    it('sends the request', async () => {");
  lines.push('      fetchOnce({});');
  lines.push('');
  lines.push(`      await workos.${serviceProp}.${method}(${args});`);
  lines.push('');
  lines.push(`      expect(fetchMethod()).toBe('${op.httpMethod.toUpperCase()}');`);
  // Fix #12: Full URL path assertion instead of toContain()
  const expectedPathVoid = buildExpectedPath(op);
  lines.push(`      expect(new URL(String(fetchURL())).pathname).toBe('${expectedPathVoid}');`);
  if (plan.hasBody && payload) {
    lines.push(`      expect(fetchBody()).toEqual(expect.objectContaining(${payload.snakeCaseObj}));`);
  }
  lines.push('    });');
}

function buildOptionsObjectTestArg(
  op: Operation,
  plan: any,
  baselineMethod: BaselineMethod | undefined,
  modelMap: Map<string, Model>,
  ctx?: EmitterContext,
): string | null {
  const optionParam = optionsObjectParam(baselineMethod);
  if (!optionParam) return null;

  const entries: string[] = [];
  for (const param of op.pathParams) {
    const localName = fieldName(param.name);
    const optionField = resolveOptionsObjectField(localName, optionParam.type, ctx);
    entries.push(`${optionField}: ${JSON.stringify(pathParamTestValue(param, localName))}`);
  }

  if (plan.hasBody) {
    const payload = buildTestPayload(op, modelMap);
    if (payload) entries.push(...objectLiteralEntries(payload.camelCaseObj));
  }

  return `{ ${entries.join(', ')} }`;
}

function objectLiteralEntries(literal: string): string[] {
  const trimmed = literal.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return [];
  const body = trimmed.slice(1, -1).trim();
  return body ? body.split(',').map((entry) => entry.trim()) : [];
}

function resolveOptionsObjectField(localName: string, optionType: string, ctx?: EmitterContext): string {
  const fields = ctx?.apiSurface?.interfaces?.[optionType]?.fields;
  if (!fields) return localName;
  if (fields[localName]) return localName;
  if (localName === 'omId' && fields.organizationMembershipId) return 'organizationMembershipId';
  return localName;
}

/**
 * Generate per-entity assertion helper functions for models used in 2+ tests.
 * Returns lines like: function expectConnection(result: any) { expect(...) }
 */
/**
 * Generate per-entity assertion helper functions for models used in 2+ tests.
 * Returns { lines, helpers } where helpers is a Set of helper function names.
 */
function generateEntityHelpers(
  plans: { op: Operation; plan: any; method: string }[],
  modelMap: Map<string, Model>,
  ctx: EmitterContext,
): { lines: string[]; helpers: Set<string> } {
  // Count how many tests reference each response model
  const modelUsage = new Map<string, number>();
  for (const { op, plan } of plans) {
    let modelName: string | null = null;
    if (plan.isPaginated && op.pagination?.itemType.kind === 'model') {
      modelName = op.pagination.itemType.name;
      const rawModel = modelMap.get(modelName);
      if (rawModel) {
        const unwrapped = unwrapListModel(rawModel, modelMap);
        if (unwrapped) modelName = unwrapped.name;
      }
    } else if (plan.responseModelName) {
      modelName = plan.responseModelName;
    }
    if (modelName) {
      modelUsage.set(modelName, (modelUsage.get(modelName) ?? 0) + 1);
    }
  }

  const lines: string[] = [];
  const helpers = new Set<string>();
  for (const [modelName, count] of modelUsage) {
    if (count < 2) continue;
    const model = modelMap.get(modelName);
    if (!model) continue;
    const assertions = buildFieldAssertions(model, 'result', modelMap);
    if (assertions.length === 0) continue;

    const domainName = resolveInterfaceName(modelName, ctx);
    const helperName = `expect${domainName}`;
    if (helpers.has(helperName)) continue;
    helpers.add(helperName);

    lines.push(`function ${helperName}(result: any) {`);
    for (const assertion of assertions) {
      lines.push(`  ${assertion}`);
    }
    lines.push('}');
    lines.push('');
  }
  return { lines, helpers };
}

/**
 * Build field-level assertions for top-level primitive fields of a response model.
 * Returns lines like: expect(result.fieldName).toBe(fixtureValue);
 *
 * When the top level has no assertable primitive fields (e.g. wrapper types
 * whose only required fields are nested models), recurse one level into those
 * nested models so we still get meaningful assertions instead of a bare
 * `toBeDefined()`.
 */
function isDateTimeFieldType(type: TypeRef): boolean {
  if (type.kind === 'primitive') return type.format === 'date-time';
  if (type.kind === 'nullable') return isDateTimeFieldType(type.inner);
  return false;
}

function buildFieldAssertions(model: Model, accessor: string, modelMap?: Map<string, Model>): string[] {
  const assertions: string[] = [];

  for (const field of model.fields) {
    if (!field.required) continue;
    const domainField = fieldName(field.name);
    // `string` + `format: 'date-time'` is deserialized to `Date` by the
    // serializer (see `mapPrimitive` in type-map.ts). Asserting against a
    // string literal would fail Object.is — compare via `.toISOString()`.
    const isDateTime = isDateTimeFieldType(field.type);
    const fieldAccessor = isDateTime ? `${accessor}.${domainField}.toISOString()` : `${accessor}.${domainField}`;
    // When a field has an example value, use it as the expected assertion value
    if (field.example !== undefined) {
      // A null example on a nullable field must assert `toBeNull()` on the
      // raw value — calling `.toISOString()` on null throws at runtime, and
      // `.toBe(null)` against any non-null value never matches.
      if (field.example === null) {
        assertions.push(`expect(${accessor}.${domainField}).toBeNull();`);
        continue;
      }
      if (typeof field.example === 'object') {
        // Objects and arrays need toEqual with JSON serialization
        assertions.push(`expect(${accessor}.${domainField}).toEqual(${JSON.stringify(field.example)});`);
      } else {
        const exampleLiteral = typeof field.example === 'string' ? `'${field.example}'` : String(field.example);
        assertions.push(`expect(${fieldAccessor}).toBe(${exampleLiteral});`);
      }
      continue;
    }
    const value = fixtureValueForType(field.type, field.name, model.name);
    if (value === null) continue;
    assertions.push(`expect(${fieldAccessor}).toBe(${value});`);
  }

  // When no primitive assertions were found (e.g. wrapper types like
  // ResetPasswordResponse { user: User }), recurse one level into nested
  // model-type fields to generate assertions on their primitive fields.
  if (assertions.length === 0 && modelMap) {
    for (const field of model.fields) {
      if (!field.required) continue;
      if (field.type.kind === 'model') {
        const nestedModel = modelMap.get(field.type.name);
        if (nestedModel) {
          const nestedAccessor = `${accessor}.${fieldName(field.name)}`;
          // Recurse without modelMap to limit depth to one level
          const nested = buildFieldAssertions(nestedModel, nestedAccessor);
          assertions.push(...nested);
        }
      }
    }
  }

  return assertions;
}

/**
 * Return a JS literal string for the expected fixture value of a field.
 * Returns null for types that cannot be deterministically generated.
 * When a modelMap is provided, recursively builds object literals for nested model types.
 * When wire is true, uses snake_case keys for nested model objects (wire format).
 */
function fixtureValueForType(
  ref: TypeRef,
  name: string,
  modelName: string,
  modelMap?: Map<string, Model>,
  wire?: boolean,
): string | null {
  switch (ref.kind) {
    case 'primitive':
      return fixtureValueForPrimitive(ref.type, ref.format, name, modelName);
    case 'literal':
      return typeof ref.value === 'string' ? `'${ref.value}'` : String(ref.value);
    case 'enum':
      // Use the first enum value as a realistic fixture value
      if (ref.values?.length) {
        const first = ref.values[0];
        return typeof first === 'string' ? `'${first}'` : String(first);
      }
      return null;
    case 'array': {
      // For arrays of primitives/enums, generate a single-element array assertion.
      // For arrays of models/complex types, return null to skip the assertion —
      // the fixture will have populated items that we can't predict here.
      const itemValue = fixtureValueForType(ref.items, name, modelName, modelMap, wire);
      if (itemValue !== null) return `[${itemValue}]`;
      return null;
    }
    case 'model': {
      if (!modelMap) return null;
      const nested = modelMap.get(ref.name);
      if (!nested) return null;
      const requiredFields = nested.fields.filter((f) => f.required);
      const entries: string[] = [];
      for (const field of requiredFields) {
        const value = fixtureValueForType(field.type, field.name, nested.name, modelMap, wire);
        if (value === null) return null; // Can't build a complete object
        const key = wire ? wireFieldName(field.name) : fieldName(field.name);
        entries.push(`${key}: ${value}`);
      }
      return `{ ${entries.join(', ')} }`;
    }
    default:
      return null;
  }
}

function fixtureValueForPrimitive(
  type: string,
  format: string | undefined,
  name: string,
  modelName: string,
): string | null {
  switch (type) {
    case 'string':
      if (format === 'date-time') return "'2023-01-01T00:00:00.000Z'";
      if (format === 'date') return "'2023-01-01'";
      if (format === 'uuid') return "'00000000-0000-0000-0000-000000000000'";
      if (name === 'id') {
        const prefix = ID_PREFIXES[modelName] ?? '';
        return `'${prefix}01234'`;
      }
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
    path = path.replace(`{${param.name}}`, pathParamTestValue(param, fieldName(param.name)));
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
  if (!op.requestBody) return null;

  // For discriminated unions, build a payload from the first variant so the
  // generated test produces a value that satisfies the union type.  Without
  // this, emitted tests pass `{} as any` for union bodies — fine for older
  // permissive runtimes, but the dispatch switch now throws on unknown
  // discriminator values, so the tests would fail before hitting fetch.
  let model: Model | undefined;
  if (op.requestBody.kind === 'union') {
    const firstVariant = op.requestBody.variants.find((v) => v.kind === 'model');
    if (!firstVariant || firstVariant.kind !== 'model') return null;
    model = modelMap.get(firstVariant.name);
  } else if (op.requestBody.kind === 'model') {
    model = modelMap.get(op.requestBody.name);
  }
  if (!model) return null;

  const requiredFields = model.fields.filter((f) => f.required);
  // Only use fields that we can generate deterministic values for (primitives, enums, and nested models)
  const usableRequired = requiredFields.filter(
    (f) => fixtureValueForType(f.type, f.name, model.name, modelMap) !== null,
  );

  let chosenFields: typeof model.fields;
  if (requiredFields.length > 0) {
    // Only generate a typed payload when ALL required fields have fixture values.
    // A partial payload missing required fields would fail TypeScript type checking.
    if (usableRequired.length < requiredFields.length) return null;
    chosenFields = usableRequired;
  } else {
    // All-optional model (e.g. PATCH `Update<X>` bodies). Pick the first few
    // optional fields with available fixture values so the test asserts the
    // wire format instead of falling back to `expect(fetchBody()).toBeDefined()`.
    const usableOptional = model.fields.filter(
      (f) => !f.required && fixtureValueForType(f.type, f.name, model.name, modelMap) !== null,
    );
    if (usableOptional.length === 0) return null;
    chosenFields = usableOptional.slice(0, 2);
  }

  const camelEntries: string[] = [];
  const snakeEntries: string[] = [];

  for (const field of chosenFields) {
    const camelValue = fixtureValueForType(field.type, field.name, model.name, modelMap)!;
    const wireValue = fixtureValueForType(field.type, field.name, model.name, modelMap, true)!;
    const camelKey = fieldName(field.name);
    const snakeKey = wireFieldName(field.name);
    camelEntries.push(`${camelKey}: ${camelValue}`);
    snakeEntries.push(`${snakeKey}: ${wireValue}`);
  }

  return {
    camelCaseObj: `{ ${camelEntries.join(', ')} }`,
    snakeCaseObj: `{ ${snakeEntries.join(', ')} }`,
  };
}

/**
 * Compute a fallback body argument when buildTestPayload returns null.
 * If the request body model has no required fields (all optional), an empty
 * object `{}` is a valid value and doesn't need a type assertion. Otherwise,
 * fall back to `{} as any` to bypass type checking for complex required fields.
 */
function fallbackBodyArg(op: Operation, modelMap: Map<string, Model>): string {
  if (!op.requestBody) return '{} as any';
  let model: Model | undefined;
  if (op.requestBody.kind === 'union') {
    const firstVariant = op.requestBody.variants.find((v) => v.kind === 'model');
    if (firstVariant && firstVariant.kind === 'model') model = modelMap.get(firstVariant.name);
  } else if (op.requestBody.kind === 'model') {
    model = modelMap.get(op.requestBody.name);
  }
  if (!model) return '{} as any';
  const hasRequiredFields = model.fields.some((f) => f.required);
  return hasRequiredFields ? '{} as any' : '{}';
}

/**
 * Determine whether a model should get a round-trip serializer test.
 * Includes all models with at least one field — every model gets both
 * serialize and deserialize functions, so all benefit from round-trip testing.
 */
function modelNeedsRoundTripTest(model: Model): boolean {
  return model.fields.length > 0;
}

function fixtureIsHandOwned(fixturePath: string, ctx: EmitterContext): boolean {
  const root = ctx.outputDir ?? ctx.targetDir;
  if (!root) return false;
  return fs.existsSync(path.join(root, fixturePath));
}

/**
 * Generate serializer round-trip tests for models that have both serialize and
 * deserialize functions and have nested types requiring non-trivial serialization.
 */
function generateSerializerTests(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const modelToService = assignModelsToServices(spec.models, spec.services, ctx.modelHints);
  const serviceNameMap = new Map<string, string>();
  for (const service of spec.services) {
    serviceNameMap.set(service.name, resolveResourceClassName(service, ctx));
  }
  const resolveDir = (irService: string | undefined) =>
    irService ? resolveServiceDir(serviceNameMap.get(irService) ?? irService) : 'common';

  // Only generate round-trip tests for models with fields that have serializers generated.
  // Skip list metadata and list wrapper models since their serializers are not emitted.
  // Skip models unchanged from baseline (no new fields) since their serializers are not regenerated.
  // Skip models unreachable from non-event services (no model/serializer files generated).
  const nonEventReachable = computeNonEventReachable(spec.services, spec.models);
  const generatedSerializerModels = (ctx as any)._generatedSerializerModels as Set<string> | undefined;
  const eligibleModels = spec.models.filter((m) => {
    const service = modelToService.get(m.name);
    return (
      nonEventReachable.has(m.name) &&
      modelNeedsRoundTripTest(m) &&
      !isListMetadataModel(m) &&
      !isListWrapperModel(m) &&
      (generatedSerializerModels?.has(m.name) ?? (modelHasNewFields(m, ctx) || isNodeOwnedService(ctx, service)))
    );
  });

  if (eligibleModels.length === 0) return files;

  // Use the skipped-serialize set computed by the serializer generator.
  // It's stashed on the context during generateSerializers.
  const serializeSkipped: Set<string> = (ctx as any)._skippedSerializeModels ?? new Set<string>();
  // Response-reachable models — anything outside this set is request-only
  // and has no `deserialize<X>` to test. `undefined` means "no usage info,
  // assume deserialize exists" (standalone generation, smoke tests).
  const responseReachableModels: Set<string> | undefined = (ctx as any)._responseReachableModels;

  // Group eligible models by service directory for one test file per service
  const modelsByDir = new Map<string, Model[]>();
  for (const model of eligibleModels) {
    const service = modelToService.get(model.name);
    const dirName = resolveDir(service);
    const fixturePath = `src/${dirName}/fixtures/${fileName(model.name)}.json`;
    if (!fixtureIsHandOwned(fixturePath, ctx)) continue;
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
    const interfaceImports: string[] = [];
    const fixtureImports: string[] = [];
    const deserializeOnlyModels = new Set<string>();
    const serializeOnlyModels = new Set<string>();

    for (const model of models) {
      const domainName = resolveInterfaceName(model.name, ctx);
      const service = modelToService.get(model.name);
      const modelDir = resolveDir(service);
      const serializerPath = `src/${modelDir}/serializers/${fileName(model.name)}.serializer.ts`;
      const interfacePath = `src/${modelDir}/interfaces/${fileName(model.name)}.interface.ts`;
      const fixturePath = `src/${modelDir}/fixtures/${fileName(model.name)}.json`;
      // Request-only models (e.g. `CreateWebhookEndpoint`) have no
      // `deserialize<X>` emitted, so they can only be tested via serialize.
      // This check has to come first: a hand-owned fixture would otherwise
      // route through the deserialize-only branch, which then imports a
      // function that doesn't exist.
      const isRequestOnly = responseReachableModels !== undefined && !responseReachableModels.has(model.name);
      const deserializeOnly =
        !isRequestOnly && (serializeSkipped.has(model.name) || fixtureIsHandOwned(fixturePath, ctx));
      const serializeOnly = isRequestOnly;
      if (deserializeOnly) deserializeOnlyModels.add(model.name);
      if (serializeOnly) serializeOnlyModels.add(model.name);

      if (deserializeOnly) {
        serializerImports.push(
          `import { deserialize${domainName} } from '${relativeImport(testPath, serializerPath)}';`,
        );
      } else if (serializeOnly) {
        serializerImports.push(`import { serialize${domainName} } from '${relativeImport(testPath, serializerPath)}';`);
      } else {
        serializerImports.push(
          `import { deserialize${domainName}, serialize${domainName} } from '${relativeImport(testPath, serializerPath)}';`,
        );
      }
      const wireName = wireInterfaceName(domainName);
      interfaceImports.push(`import type { ${wireName} } from '${relativeImport(testPath, interfacePath)}';`);
      const camelName = toCamelCase(domainName);
      fixtureImports.push(`import ${camelName}Fixture from '${relativeImport(testPath, fixturePath)}';`);
    }

    for (const imp of serializerImports) {
      lines.push(imp);
    }
    for (const imp of interfaceImports) {
      lines.push(imp);
    }
    for (const imp of fixtureImports) {
      lines.push(imp);
    }
    lines.push('');

    for (const model of models) {
      const domainName = resolveInterfaceName(model.name, ctx);
      const fixtureName = `${toCamelCase(domainName)}Fixture`;
      const wireName = wireInterfaceName(domainName);

      if (deserializeOnlyModels.has(model.name)) {
        // Deserialize-only test for hand-owned fixtures or models without a serializer.
        lines.push(`describe('${domainName}Serializer', () => {`);
        lines.push("  it('deserializes correctly', () => {");
        lines.push(`    const fixture = ${fixtureName} as ${wireName};`);
        lines.push(`    const deserialized = deserialize${domainName}(fixture);`);
        lines.push('    expect(deserialized).toBeDefined();');
        lines.push('  });');
        lines.push('});');
      } else if (serializeOnlyModels.has(model.name)) {
        // Serialize-only test for request-body-only models without a deserializer.
        lines.push(`describe('${domainName}Serializer', () => {`);
        lines.push("  it('serializes correctly', () => {");
        lines.push(`    const fixture = ${fixtureName} as ${wireName};`);
        lines.push(`    const serialized = serialize${domainName}(fixture as any);`);
        lines.push('    expect(serialized).toBeDefined();');
        lines.push('  });');
        lines.push('});');
      } else {
        // Round-trip test
        lines.push(`describe('${domainName}Serializer', () => {`);
        lines.push("  it('round-trips through serialize/deserialize', () => {");
        lines.push(`    const fixture = ${fixtureName} as ${wireName};`);
        lines.push(`    const deserialized = deserialize${domainName}(fixture);`);
        lines.push(`    const reserialized = serialize${domainName}(deserialized);`);
        lines.push('    expect(reserialized).toEqual(expect.objectContaining(fixture));');
        lines.push('  });');
        lines.push('});');
      }
      lines.push('');
    }

    files.push({
      path: testPath,
      content: lines.join('\n'),
      overwriteExisting: true,
    });
  }

  return files;
}
