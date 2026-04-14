import type { ApiSpec, Service, Operation, EmitterContext, GeneratedFile } from '@workos/oagen';
import { planOperation } from '@workos/oagen';
import {
  className,
  fixtureFileName,
  fieldName as csFieldName,
  methodName as csMethodName,
  resolveMethodName,
  serviceTypeName,
} from './naming.js';
import { resolveResourceClassName, sortPathParamsByTemplateOrder, optionsClassName } from './resources.js';
import { generateFixtures, generateModelFixture } from './fixtures.js';
import { isListWrapperModel } from './models.js';
import { groupByMount, buildResolvedLookup, lookupResolved, buildHiddenParams } from '../shared/resolved-ops.js';

/**
 * Generate C# test files and JSON fixtures.
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

  // Generate per-mount-target test files
  const mountGroups = groupByMount(ctx);
  const testEntries: Array<{ name: string; operations: Operation[] }> =
    mountGroups.size > 0
      ? [...mountGroups].map(([name, group]) => ({ name, operations: group.operations }))
      : spec.services.map((s) => ({
          name: resolveResourceClassName(s, ctx),
          operations: s.operations,
        }));

  for (const { name: mountName, operations } of testEntries) {
    if (operations.length === 0) continue;
    const mergedService: Service = { name: mountName, operations };
    const testFile = generateServiceTest(mergedService, spec, ctx);
    if (testFile) files.push(testFile);
  }

  return files;
}

function generateServiceTest(service: Service, spec: ApiSpec, ctx: EmitterContext): GeneratedFile | null {
  if (service.operations.length === 0) return null;

  const resolvedName = resolveResourceClassName(service, ctx);
  const svcType = serviceTypeName(resolvedName);
  const testClassName = `${svcType}Test`;
  const testFile = `Tests/${testClassName}.cs`;

  const lines: string[] = [];
  lines.push(`namespace ${ctx.namespacePascal}Tests`);
  lines.push('{');
  lines.push('    using System.Collections.Generic;');
  lines.push('    using System.Net;');
  lines.push('    using System.Net.Http;');
  lines.push('    using System.Threading.Tasks;');
  lines.push(`    using ${ctx.namespacePascal};`);
  lines.push('    using Xunit;');
  lines.push('');
  lines.push(`    public class ${testClassName}`);
  lines.push('    {');
  lines.push('        private readonly HttpMock httpMock;');
  lines.push(`        private readonly ${svcType} service;`);
  lines.push('');
  lines.push(`        public ${testClassName}()`);
  lines.push('        {');
  lines.push('            this.httpMock = new HttpMock();');
  lines.push(`            var client = new WorkOSClient(new WorkOSOptions`);
  lines.push('            {');
  lines.push('                ApiKey = "sk_test",');
  lines.push('                ClientId = "client_test",');
  lines.push('                HttpClient = this.httpMock.HttpClient,');
  lines.push('            });');
  lines.push(`            this.service = new ${svcType}(client);`);
  lines.push('        }');

  const emittedTestMethods = new Set<string>();
  const resolvedLookupForTests = buildResolvedLookup(ctx);

  for (const op of service.operations) {
    const plan = planOperation(op);
    const method = resolveCsMethodName(op, resolvedName, ctx);
    const isPaginated = plan.isPaginated;
    const isDelete = plan.isDelete;
    const resolvedOp = lookupResolved(op, resolvedLookupForTests);
    const isUrlBuilder = resolvedOp?.urlBuilder ?? false;
    const isUnionSplit = (resolvedOp?.wrappers?.length ?? 0) > 0;

    // Union-split operations (e.g. POST /user_management/authenticate) don't
    // expose the base method or options class — only the typed wrappers —
    // so skip the generic base test; the wrapper loop below emits tests for
    // each AuthenticateWith* / CreateOAuthApplication variant instead.
    if (isUnionSplit) continue;

    if (emittedTestMethods.has(method)) continue;
    emittedTestMethods.add(method);

    const testName = `Test${method}`;
    const expectedPath = buildExpectedPath(op);
    if (isUrlBuilder) {
      // URL-builder operations return a string synchronously without issuing
      // an HTTP request. Assert the URL structure instead of mocking HTTP.
      const callArgs = buildMethodCallArgs(op, plan, ctx, resolvedName);
      lines.push('');
      lines.push('        [Fact]');
      lines.push(`        public void ${testName}()`);
      lines.push('        {');
      lines.push(`            var url = this.service.${method}(${callArgs});`);
      lines.push('            Assert.NotNull(url);');
      lines.push(`            Assert.Contains("${expectedPath}", url);`);
      lines.push('            Assert.Empty(this.httpMock.CapturedRequests);');
      lines.push('        }');
      continue;
    }
    if (isPaginated && op.pagination) {
      // Paginated test
      let fixturePath: string | null = null;
      const paginationItemType = op.pagination.itemType;
      if (paginationItemType.kind === 'model') {
        const itemModel = spec.models.find((m) => m.name === paginationItemType.name);
        if (itemModel) {
          let resolved = itemModel;
          if (isListWrapperModel(itemModel)) {
            const dataField = itemModel.fields.find((f) => f.name === 'data');
            if (dataField && dataField.type.kind === 'array' && dataField.type.items.kind === 'model') {
              const inner = spec.models.find((m) => m.name === (dataField.type as any).items.name);
              if (inner) resolved = inner;
            }
          }
          fixturePath = `testdata/list_${fixtureFileName(resolved.name)}.json`;
        }
      }

      lines.push('');
      lines.push('        [Fact]');
      lines.push(`        public async Task ${testName}()`);
      lines.push('        {');
      if (fixturePath) {
        lines.push(`            var fixture = System.IO.File.ReadAllText("${fixturePath}");`);
        lines.push(
          `            this.httpMock.MockResponse(HttpMethod.Get, "${expectedPath}", HttpStatusCode.OK, fixture);`,
        );
      } else {
        lines.push(
          `            this.httpMock.MockResponse(HttpMethod.Get, "${expectedPath}", HttpStatusCode.OK, "{\\"data\\":[],\\"list_metadata\\":{\\"before\\":null,\\"after\\":null}}");`,
        );
      }
      const callArgs = buildMethodCallArgs(op, plan, ctx, resolvedName);
      lines.push(`            var result = await this.service.${method}(${callArgs});`);
      lines.push('            Assert.NotNull(result);');
      if (fixturePath) {
        lines.push('            Assert.NotEmpty(result.Data);');
      }
      lines.push(`            this.httpMock.AssertRequestWasMade(HttpMethod.Get, "${expectedPath}");`);
      lines.push('        }');

      // Empty list test
      const emptyTestName = `Test${method}Empty`;
      if (!emittedTestMethods.has(emptyTestName)) {
        emittedTestMethods.add(emptyTestName);
        const callArgsEmpty = buildMethodCallArgs(op, plan, ctx, resolvedName);
        lines.push('');
        lines.push('        [Fact]');
        lines.push(`        public async Task ${emptyTestName}()`);
        lines.push('        {');
        lines.push(
          `            this.httpMock.MockResponse(HttpMethod.Get, "${expectedPath}", HttpStatusCode.OK, "{\\"data\\":[],\\"list_metadata\\":{\\"before\\":null,\\"after\\":null}}");`,
        );
        lines.push(`            var result = await this.service.${method}(${callArgsEmpty});`);
        lines.push('            Assert.NotNull(result);');
        lines.push('            Assert.Empty(result.Data);');
        lines.push('        }');
      }
    } else if (isDelete) {
      lines.push('');
      lines.push('        [Fact]');
      lines.push(`        public async Task ${testName}()`);
      lines.push('        {');
      lines.push(
        `            this.httpMock.MockResponse(HttpMethod.Delete, "${expectedPath}", HttpStatusCode.NoContent, "");`,
      );
      const callArgs = buildMethodCallArgs(op, plan, ctx, resolvedName);
      lines.push(`            await this.service.${method}(${callArgs});`);
      lines.push(`            this.httpMock.AssertRequestWasMade(HttpMethod.Delete, "${expectedPath}");`);
      lines.push('        }');
    } else if (plan.responseModelName) {
      const respModel = plan.responseModelName;
      const fixturePath = `testdata/${fixtureFileName(respModel)}.json`;
      const httpMethodCs = op.httpMethod.charAt(0).toUpperCase() + op.httpMethod.slice(1).toLowerCase();

      const isArrayResp = !isPaginated && op.response?.kind === 'array';
      const shapeSeed = buildRequestShapeSeed(op, plan, ctx, resolvedName);

      lines.push('');
      lines.push('        [Fact]');
      lines.push(`        public async Task ${testName}()`);
      lines.push('        {');
      lines.push(`            var fixture = System.IO.File.ReadAllText("${fixturePath}");`);
      if (isArrayResp) {
        // Wrap single-object fixture in array for List<T> deserialization
        lines.push(
          `            this.httpMock.MockResponse(HttpMethod.${httpMethodCs}, "${expectedPath}", HttpStatusCode.OK, "[" + fixture + "]");`,
        );
      } else {
        lines.push(
          `            this.httpMock.MockResponse(HttpMethod.${httpMethodCs}, "${expectedPath}", HttpStatusCode.OK, fixture);`,
        );
      }
      const callArgs = shapeSeed.seededCallArgs ?? buildMethodCallArgs(op, plan, ctx, resolvedName);
      if (shapeSeed.setupLines.length > 0) {
        for (const setupLine of shapeSeed.setupLines) {
          lines.push(`            ${setupLine}`);
        }
      }
      lines.push(`            var result = await this.service.${method}(${callArgs});`);
      lines.push('            Assert.NotNull(result);');
      if (!isArrayResp) {
        const respModelDef = spec.models.find((m) => m.name === respModel);
        if (respModelDef) {
          const assertions = buildFixtureAssertions(respModelDef, spec);
          for (const assertion of assertions) {
            lines.push(`            ${assertion}`);
          }
        }
      }

      lines.push(`            this.httpMock.AssertRequestWasMade(HttpMethod.${httpMethodCs}, "${expectedPath}");`);
      for (const assertLine of shapeSeed.assertLines) {
        lines.push(`            ${assertLine}`);
      }
      lines.push('        }');
    } else {
      lines.push('');
      lines.push('        [Fact]');
      lines.push(`        public async Task ${testName}()`);
      lines.push('        {');
      const httpMethodCs = op.httpMethod.charAt(0).toUpperCase() + op.httpMethod.slice(1).toLowerCase();
      lines.push(
        `            this.httpMock.MockResponse(HttpMethod.${httpMethodCs}, "${expectedPath}", HttpStatusCode.OK, "");`,
      );
      const callArgs = buildMethodCallArgs(op, plan, ctx, resolvedName);
      lines.push(`            await this.service.${method}(${callArgs});`);
      lines.push(`            this.httpMock.AssertRequestWasMade(HttpMethod.${httpMethodCs}, "${expectedPath}");`);
      lines.push('        }');
    }
  }

  // Auto-paging tests (P0-5)
  const resolvedLookupForPaging = buildResolvedLookup(ctx);
  for (const op of service.operations) {
    const plan = planOperation(op);
    if (!plan.isPaginated || !op.pagination) continue;

    const method = resolveCsMethodName(op, resolvedName, ctx);
    const autoPagingTestName = `Test${method}AutoPagingAsync`;
    if (emittedTestMethods.has(autoPagingTestName)) continue;
    emittedTestMethods.add(autoPagingTestName);

    const expectedPath = buildExpectedPath(op);
    const paginationItemType = op.pagination.itemType;
    let itemTypeName: string | null = null;
    let fixtureName: string | null = null;

    if (paginationItemType.kind === 'model') {
      const itemModel = spec.models.find((m) => m.name === paginationItemType.name);
      if (itemModel) {
        let resolved = itemModel;
        if (isListWrapperModel(itemModel)) {
          const dataField = itemModel.fields.find((f) => f.name === 'data');
          if (dataField && dataField.type.kind === 'array' && dataField.type.items.kind === 'model') {
            const inner = spec.models.find((m) => m.name === (dataField.type as any).items.name);
            if (inner) resolved = inner;
          }
        }
        itemTypeName = className(resolved.name);
        fixtureName = fixtureFileName(resolved.name);
      }
    }

    if (!itemTypeName || !fixtureName) continue;

    const callArgs = buildMethodCallArgs(op, plan, ctx, resolvedName);
    // Remove the trailing options arg since auto-paging uses the same options
    const autoPagingArgs = callArgs;

    // Test with two pages
    lines.push('');
    lines.push('        [Fact]');
    lines.push(`        public async Task ${autoPagingTestName}()`);
    lines.push('        {');
    lines.push(`            var fixture = System.IO.File.ReadAllText("testdata/${fixtureName}.json");`);
    lines.push(
      `            var page1 = "{\\"data\\":[" + fixture + "],\\"list_metadata\\":{\\"before\\":null,\\"after\\":\\"cursor_123\\"}}";`,
    );
    lines.push(
      `            var page2 = "{\\"data\\":[" + fixture + "],\\"list_metadata\\":{\\"before\\":null,\\"after\\":null}}";`,
    );
    lines.push(
      `            this.httpMock.MockSequentialResponses(HttpMethod.Get, "${expectedPath}", HttpStatusCode.OK, new[] { page1, page2 });`,
    );
    lines.push('');
    lines.push(`            var items = new List<${itemTypeName}>();`);
    lines.push(`            await foreach (var item in this.service.${method}AutoPagingAsync(${autoPagingArgs}))`);
    lines.push('            {');
    lines.push('                items.Add(item);');
    lines.push('            }');
    lines.push('');
    lines.push('            Assert.Equal(2, items.Count);');
    lines.push('        }');

    // Test with empty first page
    const emptyTestName = `Test${method}AutoPagingAsyncEmpty`;
    if (!emittedTestMethods.has(emptyTestName)) {
      emittedTestMethods.add(emptyTestName);
      lines.push('');
      lines.push('        [Fact]');
      lines.push(`        public async Task ${emptyTestName}()`);
      lines.push('        {');
      lines.push(`            var empty = "{\\"data\\":[],\\"list_metadata\\":{\\"before\\":null,\\"after\\":null}}";`);
      lines.push(
        `            this.httpMock.MockSequentialResponses(HttpMethod.Get, "${expectedPath}", HttpStatusCode.OK, new[] { empty });`,
      );
      lines.push('');
      lines.push(`            var items = new List<${itemTypeName}>();`);
      lines.push(`            await foreach (var item in this.service.${method}AutoPagingAsync(${autoPagingArgs}))`);
      lines.push('            {');
      lines.push('                items.Add(item);');
      lines.push('            }');
      lines.push('');
      lines.push('            Assert.Empty(items);');
      lines.push('        }');
    }
  }

  // Wrapper/convenience method tests (P0-6)
  for (const op of service.operations) {
    const resolvedOp = lookupResolved(op, resolvedLookupForPaging);
    if (!resolvedOp?.wrappers || resolvedOp.wrappers.length === 0) continue;

    for (const wrapper of resolvedOp.wrappers) {
      const wrapperMethod = csMethodName(wrapper.name);
      const wrapperTestName = `Test${wrapperMethod}`;
      if (emittedTestMethods.has(wrapperTestName)) continue;
      emittedTestMethods.add(wrapperTestName);

      const expectedPath = buildExpectedPath(op);
      const httpMethodCs = op.httpMethod.charAt(0).toUpperCase() + op.httpMethod.slice(1).toLowerCase();
      const responseType = wrapper.responseModelName;

      lines.push('');
      lines.push('        [Fact]');
      lines.push(`        public async Task ${wrapperTestName}()`);
      lines.push('        {');

      if (responseType) {
        const fixturePath = `testdata/${fixtureFileName(responseType)}.json`;
        lines.push(`            var fixture = System.IO.File.ReadAllText("${fixturePath}");`);
        lines.push(
          `            this.httpMock.MockResponse(HttpMethod.${httpMethodCs}, "${expectedPath}", HttpStatusCode.OK, fixture);`,
        );
      } else {
        lines.push(
          `            this.httpMock.MockResponse(HttpMethod.${httpMethodCs}, "${expectedPath}", HttpStatusCode.OK, "");`,
        );
      }

      // Build wrapper call args
      const wrapperArgs: string[] = [];
      for (const p of sortPathParamsByTemplateOrder(op)) {
        wrapperArgs.push(`"test_${p.name}"`);
      }
      wrapperArgs.push(`new ${wrapperMethod}Options()`);

      if (responseType) {
        lines.push(`            var result = await this.service.${wrapperMethod}(${wrapperArgs.join(', ')});`);
        lines.push('            Assert.NotNull(result);');
      } else {
        lines.push(`            await this.service.${wrapperMethod}(${wrapperArgs.join(', ')});`);
      }

      lines.push(`            this.httpMock.AssertRequestWasMade(HttpMethod.${httpMethodCs}, "${expectedPath}");`);
      lines.push('        }');
    }
  }

  // Error tests — pick the first non-URL-builder operation so the error
  // assertions run against a real HTTP call.
  const sampleOp = service.operations.find((o) => !(lookupResolved(o, resolvedLookupForTests)?.urlBuilder ?? false));
  if (sampleOp) {
    const plan = planOperation(sampleOp);
    const method = resolveCsMethodName(sampleOp, resolvedName, ctx);
    const callArgs = buildMethodCallArgs(sampleOp, plan, ctx, resolvedName);

    // 401
    lines.push('');
    lines.push('        [Fact]');
    lines.push(`        public async Task TestError401()`);
    lines.push('        {');
    lines.push(
      `            this.httpMock.MockResponseForAnyRequest(HttpStatusCode.Unauthorized, "{\\"code\\":\\"unauthorized\\",\\"message\\":\\"Unauthorized\\"}");`,
    );
    if (plan.isPaginated || plan.isDelete || !plan.responseModelName) {
      lines.push(
        `            await Assert.ThrowsAsync<AuthenticationError>(() => this.service.${method}(${callArgs}));`,
      );
    } else {
      lines.push(
        `            await Assert.ThrowsAsync<AuthenticationError>(() => this.service.${method}(${callArgs}));`,
      );
    }
    lines.push('        }');

    // 404
    lines.push('');
    lines.push('        [Fact]');
    lines.push(`        public async Task TestError404()`);
    lines.push('        {');
    lines.push(
      `            this.httpMock.MockResponseForAnyRequest(HttpStatusCode.NotFound, "{\\"code\\":\\"not_found\\",\\"message\\":\\"Not Found\\"}");`,
    );
    lines.push(`            await Assert.ThrowsAsync<NotFoundError>(() => this.service.${method}(${callArgs}));`);
    lines.push('        }');

    // 422
    lines.push('');
    lines.push('        [Fact]');
    lines.push(`        public async Task TestError422()`);
    lines.push('        {');
    lines.push(
      `            this.httpMock.MockResponseForAnyRequest((HttpStatusCode)422, "{\\"code\\":\\"unprocessable_entity\\",\\"message\\":\\"Unprocessable\\"}");`,
    );
    lines.push(
      `            await Assert.ThrowsAsync<UnprocessableEntityError>(() => this.service.${method}(${callArgs}));`,
    );
    lines.push('        }');

    // 429
    lines.push('');
    lines.push('        [Fact]');
    lines.push(`        public async Task TestError429()`);
    lines.push('        {');
    lines.push(
      `            this.httpMock.MockResponseForAnyRequest((HttpStatusCode)429, "{\\"code\\":\\"too_many_requests\\",\\"message\\":\\"Too Many Requests\\"}");`,
    );
    lines.push(
      `            await Assert.ThrowsAsync<RateLimitExceededError>(() => this.service.${method}(${callArgs}));`,
    );
    lines.push('        }');

    // 500
    lines.push('');
    lines.push('        [Fact]');
    lines.push(`        public async Task TestError500()`);
    lines.push('        {');
    lines.push(
      `            this.httpMock.MockResponseForAnyRequest(HttpStatusCode.InternalServerError, "{\\"code\\":\\"server_error\\",\\"message\\":\\"Server Error\\"}");`,
    );
    lines.push(`            await Assert.ThrowsAsync<ServerError>(() => this.service.${method}(${callArgs}));`);
    lines.push('        }');
  }

  lines.push('    }');
  lines.push('}');

  return {
    path: testFile,
    content: lines.join('\n'),
    overwriteExisting: true,
  };
}

function resolveCsMethodName(op: Operation, mountName: string, ctx: EmitterContext): string {
  return resolveMethodName(op, { name: mountName, operations: [op] }, ctx);
}

function buildMethodCallArgs(op: Operation, plan: any, ctx: EmitterContext, mountName: string): string {
  const args: string[] = [];

  // Path params
  for (const p of sortPathParamsByTemplateOrder(op)) {
    args.push(`"test_${p.name}"`);
  }

  // Bearer auth override param (e.g., SSO GetProfile uses access_token)
  const hasBearerOverride = op.security?.some((s: any) => s.schemeName !== 'bearerAuth') ?? false;
  if (hasBearerOverride) {
    const bearerParamName = op.security!.find((s: any) => s.schemeName !== 'bearerAuth')!.schemeName;
    args.push(`"test_${bearerParamName}"`);
  }

  // Options struct if needed
  const resolvedLookup = buildResolvedLookup(ctx);
  const resolvedOp = lookupResolved(op, resolvedLookup);
  const hidden = buildHiddenParams(resolvedOp);
  const hasVisibleQueryParams = op.queryParams.filter((qp) => !hidden.has(qp.name)).length > 0;
  const hasBody = plan.hasBody && op.requestBody;
  let hasVisibleBodyFields = false;
  if (hasBody && op.requestBody?.kind === 'model') {
    const bodyModel = ctx.spec.models.find((m) => op.requestBody?.kind === 'model' && m.name === op.requestBody.name);
    if (bodyModel) hasVisibleBodyFields = bodyModel.fields.some((f) => !hidden.has(f.name));
  } else if (hasBody) {
    hasVisibleBodyFields = true;
  }

  if (hasVisibleBodyFields || hasVisibleQueryParams) {
    const method = resolveCsMethodName(op, mountName, ctx);
    const optName = optionsClassName(mountName, method);
    args.push(`new ${optName}()`);
  }

  return args.join(', ');
}

/**
 * Seed required request fields on the generated options expression and
 * produce matching body/query assertions. Catches snake_case mapping
 * regressions and missing-required-field bugs without requiring
 * hand-written tests.
 */
interface RequestShapeSeed {
  setupLines: string[];
  seededCallArgs: string | null;
  assertLines: string[];
}

function buildRequestShapeSeed(op: Operation, plan: any, ctx: EmitterContext, mountName: string): RequestShapeSeed {
  const resolvedLookup = buildResolvedLookup(ctx);
  const resolvedOp = lookupResolved(op, resolvedLookup);
  const hidden = buildHiddenParams(resolvedOp);

  // Collect required simple fields that we can seed with a string literal.
  const bodySeeds: Array<{ wire: string; prop: string; value: string }> = [];
  const querySeeds: Array<{ wire: string; prop: string; value: string }> = [];

  const hasBody = plan.hasBody && op.requestBody;
  if (hasBody && op.requestBody?.kind === 'model') {
    const bodyModel = ctx.spec.models.find((m) => op.requestBody?.kind === 'model' && m.name === op.requestBody.name);
    if (bodyModel) {
      for (const field of bodyModel.fields) {
        if (hidden.has(field.name)) continue;
        if (!field.required) continue;
        if (!isSeedableStringRef(field.type)) continue;
        bodySeeds.push({
          wire: field.name,
          prop: csFieldName(field.name),
          value: `test_${field.name}`,
        });
        if (bodySeeds.length >= 2) break;
      }
    }
  }

  // Wire names already covered by body seeds. For operations that duplicate a
  // body field as a query param (e.g. POST /sso/token lists `code` in both),
  // the generated options class only exposes the field once and the service
  // call sends it via the body — so skip the query assertion to avoid a
  // false-failing `AssertQueryParam`.
  const bodyWireNames = new Set(bodySeeds.map((s) => s.wire));
  for (const param of op.queryParams) {
    if (hidden.has(param.name)) continue;
    if (!param.required) continue;
    if (!isSeedableStringRef(param.type)) continue;
    // Skip pagination fields — they're set by the caller or the autopaging loop
    if (['before', 'after', 'limit', 'order'].includes(param.name)) continue;
    if (bodyWireNames.has(param.name)) continue;
    querySeeds.push({
      wire: param.name,
      prop: csFieldName(param.name),
      value: `test_${param.name}`,
    });
    if (querySeeds.length >= 2) break;
  }

  if (bodySeeds.length === 0 && querySeeds.length === 0) {
    return { setupLines: [], seededCallArgs: null, assertLines: [] };
  }

  const method = resolveCsMethodName(op, mountName, ctx);
  const optName = optionsClassName(mountName, method);

  // Rebuild call args with a seeded options variable named `options`.
  const args: string[] = [];
  for (const p of sortPathParamsByTemplateOrder(op)) {
    args.push(`"test_${p.name}"`);
  }
  const hasBearerOverride = op.security?.some((s: any) => s.schemeName !== 'bearerAuth') ?? false;
  if (hasBearerOverride) {
    const bearerParamName = op.security!.find((s: any) => s.schemeName !== 'bearerAuth')!.schemeName;
    args.push(`"test_${bearerParamName}"`);
  }
  args.push('options');

  const setupLines: string[] = [`var options = new ${optName}();`];
  for (const s of [...bodySeeds, ...querySeeds]) {
    setupLines.push(`options.${s.prop} = "${s.value}";`);
  }

  const assertLines: string[] = [];
  for (const s of bodySeeds) {
    assertLines.push(`await this.httpMock.AssertRequestBodyContainsAsync("${s.wire}", "${s.value}");`);
  }
  for (const s of querySeeds) {
    assertLines.push(`this.httpMock.AssertQueryParam("${s.wire}", "${s.value}");`);
  }

  return { setupLines, seededCallArgs: args.join(', '), assertLines };
}

/**
 * A TypeRef is seedable as a string literal in a generated test when it maps
 * to C# `string` (plain strings, formats like email/uuid, dates-as-strings).
 * Enums and numeric types need dedicated representations and are skipped here.
 */
function isSeedableStringRef(ref: import('@workos/oagen').TypeRef): boolean {
  if (ref.kind !== 'primitive') return false;
  if (ref.type !== 'string') return false;
  // `binary` maps to byte[], not a string literal
  if (ref.format === 'binary') return false;
  return true;
}

function buildExpectedPath(op: Operation): string {
  let expected = op.path;
  for (const p of sortPathParamsByTemplateOrder(op)) {
    expected = expected.replace(`{${p.name}}`, `test_${p.name}`);
  }
  return expected;
}

function buildFixtureAssertions(model: import('@workos/oagen').Model, spec: ApiSpec): string[] {
  const assertions: string[] = [];

  // Compute the exact fixture payload the generator emits for this model so
  // we can assert against those values verbatim. Mapping regressions
  // (snake_case drift, nested field loss) fail deterministically instead of
  // silently passing NotEmpty checks.
  const modelMap = new Map(spec.models.map((m) => [m.name, m]));
  const enumMap = new Map(spec.enums.map((e) => [e.name, e]));
  let fixture: Record<string, unknown> = {};
  try {
    fixture = generateModelFixture(model, modelMap, enumMap);
  } catch {
    // Fall back to shape-only assertions if the fixture builder throws.
  }

  const idField = model.fields.find((f) => f.required && f.name === 'id');
  if (idField) {
    const idVal = fixture['id'];
    if (typeof idVal === 'string' && idVal.length > 0) {
      assertions.push(`Assert.Equal(${csStringLiteral(idVal)}, result.Id);`);
    } else {
      assertions.push(`Assert.NotEmpty(result.Id);`);
    }
  }

  // Assert up to 2 additional required simple fields using the exact fixture
  // value so snake_case mapping is verified. Skip date-time, binary, and
  // anything that doesn't come out of the fixture as a non-empty string.
  let extraCount = 0;
  for (const field of model.fields) {
    if (extraCount >= 2) break;
    if (field.name === 'id') continue;
    if (!field.required) continue;
    if (field.type.kind !== 'primitive' || field.type.type !== 'string') continue;
    if (field.type.format === 'date-time' || field.type.format === 'date') continue;
    if (field.type.format === 'binary') continue;
    const csField = csFieldName(field.name);
    const val = fixture[field.name];
    if (typeof val === 'string' && val.length > 0) {
      assertions.push(`Assert.Equal(${csStringLiteral(val)}, result.${csField});`);
    } else {
      assertions.push(`Assert.NotEmpty(result.${csField});`);
    }
    extraCount++;
  }

  return assertions;
}

/** Escape a JS string for use as a C# verbatim-friendly string literal. */
function csStringLiteral(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
}
