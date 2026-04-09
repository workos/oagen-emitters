import type { ApiSpec, Service, Operation, EmitterContext, GeneratedFile } from '@workos/oagen';
import { planOperation, toSnakeCase } from '@workos/oagen';
import { fileName, fieldName as goFieldName, resolveMethodName, methodName as goMethodName } from './naming.js';
import { resolveResourceClassName, paramsStructName, sortPathParamsByTemplateOrder } from './resources.js';
import { buildServiceAccessPaths } from './client.js';
import { generateFixtures } from './fixtures.js';
import { isListWrapperModel } from './models.js';
import { groupByMount, buildResolvedLookup, lookupResolved, buildHiddenParams } from '../shared/resolved-ops.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_MODULE_PATH = 'github.com/workos/workos-go/v6';

/** Resolve the Go module path from the output directory's go.mod, or use default. */
function resolveModulePath(ctx: EmitterContext): string {
  if (ctx.outputDir) {
    const goModPath = resolve(ctx.outputDir, 'go.mod');
    if (existsSync(goModPath)) {
      const content = readFileSync(goModPath, 'utf-8');
      const match = content.match(/^module\s+(\S+)/m);
      if (match) return match[1];
    }
  }
  return DEFAULT_MODULE_PATH;
}

/**
 * Generate Go test files and JSON fixtures.
 */
export function generateTests(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  // Generate shared test helpers file
  const helperLines: string[] = [];
  helperLines.push(`package ${ctx.namespace}_test`);
  helperLines.push('');
  helperLines.push('import (');
  helperLines.push('\t"net/http"');
  helperLines.push('\t"net/http/httptest"');
  helperLines.push('\t"os"');
  helperLines.push('\t"testing"');
  helperLines.push('');
  helperLines.push(`\t"${resolveModulePath(ctx)}"`);
  helperLines.push('\t"github.com/stretchr/testify/require"');
  helperLines.push(')');
  helperLines.push('');
  helperLines.push('func ptrString(s string) *string { return &s }');
  helperLines.push('func ptrInt(i int) *int { return &i }');
  helperLines.push('');
  helperLines.push(
    `func setupTestServer(t *testing.T, method, path, fixturePath string) (*httptest.Server, *${ctx.namespace}.Client) {`,
  );
  helperLines.push('\tt.Helper()');
  helperLines.push('\tserver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {');
  helperLines.push('\t\trequire.Equal(t, method, r.Method)');
  helperLines.push('\t\trequire.Equal(t, path, r.URL.Path)');
  helperLines.push('\t\tw.Header().Set("Content-Type", "application/json")');
  helperLines.push('\t\tfixture, err := os.ReadFile(fixturePath)');
  helperLines.push('\t\tif err != nil {');
  helperLines.push('\t\t\tt.Fatalf("failed to read fixture: %v", err)');
  helperLines.push('\t\t}');
  helperLines.push('\t\tw.Write(fixture)');
  helperLines.push('\t}))');
  helperLines.push(`\tclient := ${ctx.namespace}.NewClient("sk_test", ${ctx.namespace}.WithBaseURL(server.URL))`);
  helperLines.push('\treturn server, client');
  helperLines.push('}');
  helperLines.push('');
  files.push({
    path: 'helpers_test.go',
    content: helperLines.join('\n'),
    overwriteExisting: true,
  });

  // Generate fixture JSON files
  const fixtures = generateFixtures(spec);
  for (const fixture of fixtures) {
    files.push({
      path: fixture.path,
      content: fixture.content,
      headerPlacement: 'skip',
    });
  }

  // Build access path map
  const accessPaths = buildServiceAccessPaths(spec.services, ctx);

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
    const testFile = generateServiceTest(mergedService, spec, ctx, accessPaths);
    if (testFile) files.push(testFile);
  }

  return files;
}

function generateServiceTest(
  service: Service,
  spec: ApiSpec,
  ctx: EmitterContext,
  _accessPaths: Map<string, string>,
): GeneratedFile | null {
  if (service.operations.length === 0) return null;

  const resolvedName = resolveResourceClassName(service, ctx);
  const accessorName = resolvedName;
  const testFile = `${toSnakeCase(resolvedName)}_test.go`;

  const lines: string[] = [];
  lines.push(`package ${ctx.namespace}_test`);
  lines.push('');
  // Check if any operation uses POST/PUT/PATCH with visible model body fields (for import needs).
  // Union-type bodies don't trigger body validation so don't need io/json imports.
  const resolvedLookupForImports = buildResolvedLookup(ctx);
  const hasBodyOps = service.operations.some((op) => {
    const httpMethod = op.httpMethod.toUpperCase();
    if (httpMethod !== 'POST' && httpMethod !== 'PUT' && httpMethod !== 'PATCH') return false;
    if (op.requestBody?.kind !== 'model') return false;
    const resolved = lookupResolved(op, resolvedLookupForImports);
    const hidden = buildHiddenParams(resolved);
    const bodyModel = spec.models.find((m) => op.requestBody?.kind === 'model' && m.name === op.requestBody.name);
    if (bodyModel) return bodyModel.fields.some((f) => !hidden.has(f.name));
    return false;
  });

  lines.push('import (');
  lines.push('\t"context"');
  if (hasBodyOps) {
    lines.push('\t"encoding/json"');
    lines.push('\t"io"');
  }
  lines.push('\t"net/http"');
  lines.push('\t"net/http/httptest"');
  lines.push('\t"os"');
  lines.push('\t"testing"');
  lines.push('');
  lines.push(`\t"${resolveModulePath(ctx)}"`);
  lines.push('\t"github.com/stretchr/testify/require"');
  lines.push(')');
  lines.push('');
  // Test helpers (ptrString, ptrInt, setupTestServer) are in helpers_test.go

  // Deduplicate test functions by method name
  const emittedTestMethods = new Set<string>();
  for (const op of service.operations) {
    const plan = planOperation(op);
    const method = resolveGoMethodName(op, resolvedName, ctx);
    const isPaginated = plan.isPaginated;
    const isDelete = plan.isDelete;

    // Skip duplicate method names (same dedup as resources.ts)
    if (emittedTestMethods.has(method)) continue;
    emittedTestMethods.add(method);

    const testName = `Test${accessorName}_${method}`;

    if (isPaginated && op.pagination) {
      // Pagination test
      // Find the right fixture -- apply the same unwrap logic as fixtures.ts
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
          fixturePath = `testdata/list_${fileName(resolved.name)}.json`;
        }
      }

      const expectedPath = buildExpectedPath(op);

      // Find a filter param to populate (prefer 'limit', then first visible string param)
      const resolvedLookupPag = buildResolvedLookup(ctx);
      const resolvedOpPag = lookupResolved(op, resolvedLookupPag);
      const hiddenPag = buildHiddenParams(resolvedOpPag);
      const visibleQPs = op.queryParams.filter((qp) => !hiddenPag.has(qp.name));
      const limitParam = visibleQPs.find((qp) => qp.name === 'limit');
      const filterParam =
        limitParam ?? visibleQPs.find((qp) => qp.type.kind === 'primitive' && qp.type.type === 'string');

      lines.push(`func ${testName}(t *testing.T) {`);
      lines.push('\tserver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {');
      lines.push(`\t\trequire.Equal(t, "${op.httpMethod.toUpperCase()}", r.Method)`);
      lines.push(`\t\trequire.Equal(t, "${expectedPath}", r.URL.Path)`);
      // Assert filter param in query string
      if (filterParam) {
        const expectedVal = filterParam.name === 'limit' ? '10' : `test_${filterParam.name}`;
        lines.push(`\t\trequire.Equal(t, "${expectedVal}", r.URL.Query().Get("${filterParam.name}"))`);
      }
      lines.push('\t\tw.Header().Set("Content-Type", "application/json")');
      lines.push('\t\tw.WriteHeader(http.StatusOK)');
      if (fixturePath) {
        lines.push(`\t\tfixture, err := os.ReadFile("${fixturePath}")`);
        lines.push('\t\tif err != nil {');
        lines.push('\t\t\tt.Fatalf("failed to read fixture: %v", err)');
        lines.push('\t\t}');
        lines.push('\t\tw.Write(fixture)');
      } else {
        lines.push('\t\tw.Write([]byte(`{"data":[],"list_metadata":{"before":null,"after":null}}`))');
      }
      lines.push('\t}))');
      lines.push('\tdefer server.Close()');
      lines.push('');
      lines.push(`\tclient := ${ctx.namespace}.NewClient("sk_test", ${ctx.namespace}.WithBaseURL(server.URL))`);

      // Build method call with populated filter param
      const callArgs = buildMethodCallArgsWithFilter(op, plan, ctx, resolvedName, filterParam);
      lines.push(`\titer := client.${accessorName}().${method}(${callArgs})`);
      lines.push('\trequire.NotNil(t, iter)');
      if (fixturePath) {
        lines.push('\trequire.True(t, iter.Next())');
        lines.push('\trequire.NoError(t, iter.Err())');
        lines.push('\titem := iter.Current()');
        lines.push('\trequire.NotNil(t, item)');
      }
      lines.push('}');
      lines.push('');

      // Empty pagination test
      lines.push(`func ${testName}_Empty(t *testing.T) {`);
      lines.push('\tserver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {');
      lines.push('\t\tw.Header().Set("Content-Type", "application/json")');
      lines.push('\t\tw.WriteHeader(http.StatusOK)');
      lines.push('\t\tw.Write([]byte(`{"data":[],"list_metadata":{"before":null,"after":null}}`))');
      lines.push('\t}))');
      lines.push('\tdefer server.Close()');
      lines.push('');
      lines.push(`\tclient := ${ctx.namespace}.NewClient("sk_test", ${ctx.namespace}.WithBaseURL(server.URL))`);
      lines.push(`\titer := client.${accessorName}().${method}(${callArgs})`);
      lines.push('\trequire.False(t, iter.Next())');
      lines.push('\trequire.NoError(t, iter.Err())');
      lines.push('}');
      lines.push('');
    } else if (isDelete) {
      // Delete test
      const expectedPath = buildExpectedPath(op);
      lines.push(`func ${testName}(t *testing.T) {`);
      lines.push('\tserver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {');
      lines.push(`\t\trequire.Equal(t, "${op.httpMethod.toUpperCase()}", r.Method)`);
      lines.push(`\t\trequire.Equal(t, "${expectedPath}", r.URL.Path)`);
      lines.push('\t\tw.WriteHeader(http.StatusNoContent)');
      lines.push('\t}))');
      lines.push('\tdefer server.Close()');
      lines.push('');
      lines.push(`\tclient := ${ctx.namespace}.NewClient("sk_test", ${ctx.namespace}.WithBaseURL(server.URL))`);

      const callArgs = buildMethodCallArgs(op, plan, ctx, resolvedName);
      lines.push(`\terr := client.${accessorName}().${method}(${callArgs})`);
      lines.push('\trequire.NoError(t, err)');
      lines.push('}');
      lines.push('');
    } else if (plan.responseModelName) {
      // Success test
      const respModel = plan.responseModelName;
      const isArrayResponse = !isPaginated && op.response?.kind === 'array';
      const fixturePath = `testdata/${fileName(respModel)}.json`;
      const expectedPath = buildExpectedPath(op);

      const httpMethodUpper = op.httpMethod.toUpperCase();
      const isBodyMethod = httpMethodUpper === 'POST' || httpMethodUpper === 'PUT' || httpMethodUpper === 'PATCH';

      lines.push(`func ${testName}(t *testing.T) {`);
      lines.push('\tserver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {');
      lines.push(`\t\trequire.Equal(t, "${httpMethodUpper}", r.Method)`);
      lines.push(`\t\trequire.Equal(t, "${expectedPath}", r.URL.Path)`);

      // Validate request body for POST/PUT/PATCH when body fields are actually sent.
      // Skip for union-type bodies (test sends empty Body interface{}) and operations
      // where all body fields are hidden.
      const resolvedLookup = buildResolvedLookup(ctx);
      const resolvedOp = lookupResolved(op, resolvedLookup);
      const hiddenSet = buildHiddenParams(resolvedOp);
      let hasVisibleBody = false;
      if (isBodyMethod && op.requestBody?.kind === 'model') {
        const bodyModel = spec.models.find((m) => op.requestBody?.kind === 'model' && m.name === op.requestBody.name);
        if (bodyModel) {
          hasVisibleBody = bodyModel.fields.some((f) => !hiddenSet.has(f.name));
        }
      }
      // Don't validate body for union types -- test sends nil Body
      if (hasVisibleBody) {
        lines.push('\t\tbody, _ := io.ReadAll(r.Body)');
        lines.push('\t\tvar bodyMap map[string]interface{}');
        lines.push('\t\trequire.NoError(t, json.Unmarshal(body, &bodyMap))');
      }

      lines.push('\t\tw.Header().Set("Content-Type", "application/json")');
      lines.push('\t\tw.WriteHeader(http.StatusOK)');
      if (isArrayResponse) {
        lines.push(`\t\tfixture, err := os.ReadFile("${fixturePath}")`);
        lines.push('\t\tif err != nil {');
        lines.push('\t\t\tt.Fatalf("failed to read fixture: %v", err)');
        lines.push('\t\t}');
        lines.push('\t\tw.Write([]byte("[" + string(fixture) + "]"))');
      } else {
        lines.push(`\t\tfixture, err := os.ReadFile("${fixturePath}")`);
        lines.push('\t\tif err != nil {');
        lines.push('\t\t\tt.Fatalf("failed to read fixture: %v", err)');
        lines.push('\t\t}');
        lines.push('\t\tw.Write(fixture)');
      }
      lines.push('\t}))');
      lines.push('\tdefer server.Close()');
      lines.push('');
      lines.push(`\tclient := ${ctx.namespace}.NewClient("sk_test", ${ctx.namespace}.WithBaseURL(server.URL))`);

      const callArgs = buildMethodCallArgs(op, plan, ctx, resolvedName);
      lines.push(`\tresult, err := client.${accessorName}().${method}(${callArgs})`);
      lines.push('\trequire.NoError(t, err)');
      if (isArrayResponse) {
        lines.push('\trequire.NotEmpty(t, result)');
      } else {
        lines.push('\trequire.NotNil(t, result)');
        // Add specific field value assertions from fixture data
        const respModelDef = spec.models.find((m) => m.name === respModel);
        if (respModelDef) {
          const fixtureAssertions = buildFixtureAssertions(respModelDef, ctx.namespace);
          for (const assertion of fixtureAssertions) {
            lines.push(`\t${assertion}`);
          }
        }
      }
      lines.push('}');
      lines.push('');
    } else {
      // Void response test
      const expectedPath = buildExpectedPath(op);
      lines.push(`func ${testName}(t *testing.T) {`);
      lines.push('\tserver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {');
      lines.push(`\t\trequire.Equal(t, "${op.httpMethod.toUpperCase()}", r.Method)`);
      lines.push(`\t\trequire.Equal(t, "${expectedPath}", r.URL.Path)`);
      lines.push('\t\tw.WriteHeader(http.StatusOK)');
      lines.push('\t}))');
      lines.push('\tdefer server.Close()');
      lines.push('');
      lines.push(`\tclient := ${ctx.namespace}.NewClient("sk_test", ${ctx.namespace}.WithBaseURL(server.URL))`);

      const callArgs = buildMethodCallArgs(op, plan, ctx, resolvedName);
      lines.push(`\terr := client.${accessorName}().${method}(${callArgs})`);
      lines.push('\trequire.NoError(t, err)');
      lines.push('}');
      lines.push('');
    }
  }

  // Generate tests for union split wrapper methods (e.g., AuthenticateWithPassword)
  const resolvedLookup = buildResolvedLookup(ctx);
  for (const op of service.operations) {
    const resolved = lookupResolved(op, resolvedLookup);
    if (!resolved?.wrappers || resolved.wrappers.length === 0) continue;

    for (const wrapper of resolved.wrappers) {
      const wrapperMethod = goMethodName(wrapper.name);
      if (emittedTestMethods.has(wrapperMethod)) continue;
      emittedTestMethods.add(wrapperMethod);

      const wrapperParamsStruct = `${wrapperMethod}Params`;
      const responseType = wrapper.responseModelName;
      const testName = `Test${accessorName}_${wrapperMethod}`;
      const fixturePath = responseType ? `testdata/${fileName(responseType)}.json` : null;

      const wrapperCallArgs: string[] = ['context.Background()'];
      for (const p of sortPathParamsByTemplateOrder(op)) {
        wrapperCallArgs.push(`"test_${p.name}"`);
      }
      wrapperCallArgs.push(`&${ctx.namespace}.${wrapperParamsStruct}{}`);

      lines.push(
        ...generateWrapperTestLines(
          testName,
          accessorName,
          wrapperMethod,
          op.httpMethod.toUpperCase(),
          buildExpectedPath(op),
          fixturePath,
          wrapperCallArgs.join(', '),
          responseType,
          ctx.namespace,
        ),
      );
    }
  }

  // Error test (one per file: 401)
  const sampleOp = service.operations[0];
  if (sampleOp) {
    const plan = planOperation(sampleOp);
    const method = resolveGoMethodName(sampleOp, resolvedName, ctx);
    const callArgs = buildMethodCallArgs(sampleOp, plan, ctx, resolvedName);

    lines.push(`func Test${accessorName}_Error401(t *testing.T) {`);
    lines.push('\tserver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {');
    lines.push('\t\tw.Header().Set("Content-Type", "application/json")');
    lines.push('\t\tw.WriteHeader(http.StatusUnauthorized)');
    lines.push('\t\tw.Write([]byte(`{"code":"unauthorized","message":"Unauthorized"}`))');
    lines.push('\t}))');
    lines.push('\tdefer server.Close()');
    lines.push('');
    lines.push(`\tclient := ${ctx.namespace}.NewClient("sk_test", ${ctx.namespace}.WithBaseURL(server.URL))`);

    if (plan.isPaginated) {
      lines.push(`\titer := client.${accessorName}().${method}(${callArgs})`);
      lines.push('\trequire.False(t, iter.Next())');
      lines.push(`\trequire.IsType(t, &${ctx.namespace}.AuthenticationError{}, iter.Err())`);
    } else if (plan.isDelete || !plan.responseModelName) {
      lines.push(`\terr := client.${accessorName}().${method}(${callArgs})`);
      lines.push(`\trequire.IsType(t, &${ctx.namespace}.AuthenticationError{}, err)`);
    } else {
      lines.push(`\t_, err := client.${accessorName}().${method}(${callArgs})`);
      lines.push(`\trequire.IsType(t, &${ctx.namespace}.AuthenticationError{}, err)`);
    }
    lines.push('}');
    lines.push('');

    // Error 404 test
    lines.push(`func Test${accessorName}_Error404(t *testing.T) {`);
    lines.push('\tserver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {');
    lines.push('\t\tw.Header().Set("Content-Type", "application/json")');
    lines.push('\t\tw.WriteHeader(http.StatusNotFound)');
    lines.push('\t\tw.Write([]byte(`{"code":"not_found","message":"Not Found"}`))');
    lines.push('\t}))');
    lines.push('\tdefer server.Close()');
    lines.push('');
    lines.push(`\tclient := ${ctx.namespace}.NewClient("sk_test", ${ctx.namespace}.WithBaseURL(server.URL))`);

    if (plan.isPaginated) {
      lines.push(`\titer := client.${accessorName}().${method}(${callArgs})`);
      lines.push('\trequire.False(t, iter.Next())');
      lines.push(`\trequire.IsType(t, &${ctx.namespace}.NotFoundError{}, iter.Err())`);
    } else if (plan.isDelete || !plan.responseModelName) {
      lines.push(`\terr := client.${accessorName}().${method}(${callArgs})`);
      lines.push(`\trequire.IsType(t, &${ctx.namespace}.NotFoundError{}, err)`);
    } else {
      lines.push(`\t_, err := client.${accessorName}().${method}(${callArgs})`);
      lines.push(`\trequire.IsType(t, &${ctx.namespace}.NotFoundError{}, err)`);
    }
    lines.push('}');
    lines.push('');

    // Error 422 test
    lines.push(`func Test${accessorName}_Error422(t *testing.T) {`);
    lines.push('\tserver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {');
    lines.push('\t\tw.Header().Set("Content-Type", "application/json")');
    lines.push('\t\tw.WriteHeader(422)');
    lines.push('\t\tw.Write([]byte(`{"code":"unprocessable_entity","message":"Unprocessable"}`))');
    lines.push('\t}))');
    lines.push('\tdefer server.Close()');
    lines.push('');
    lines.push(`\tclient := ${ctx.namespace}.NewClient("sk_test", ${ctx.namespace}.WithBaseURL(server.URL))`);

    if (plan.isPaginated) {
      lines.push(`\titer := client.${accessorName}().${method}(${callArgs})`);
      lines.push('\trequire.False(t, iter.Next())');
      lines.push(`\trequire.IsType(t, &${ctx.namespace}.UnprocessableEntityError{}, iter.Err())`);
    } else if (plan.isDelete || !plan.responseModelName) {
      lines.push(`\terr := client.${accessorName}().${method}(${callArgs})`);
      lines.push(`\trequire.IsType(t, &${ctx.namespace}.UnprocessableEntityError{}, err)`);
    } else {
      lines.push(`\t_, err := client.${accessorName}().${method}(${callArgs})`);
      lines.push(`\trequire.IsType(t, &${ctx.namespace}.UnprocessableEntityError{}, err)`);
    }
    lines.push('}');
    lines.push('');
  }

  return {
    path: testFile,
    content: lines.join('\n'),
    overwriteExisting: true,
  };
}

function resolveGoMethodName(op: Operation, mountName: string, ctx: EmitterContext): string {
  return resolveMethodName(op, { name: mountName, operations: [op] }, ctx);
}

function buildMethodCallArgs(op: Operation, plan: any, ctx: EmitterContext, mountName: string): string {
  const args: string[] = ['context.Background()'];

  // Path params (sorted by template order)
  for (const p of sortPathParamsByTemplateOrder(op)) {
    args.push(`"test_${p.name}"`);
  }

  // Params struct if needed — must mirror resources.ts hasParams logic
  const resolvedLookup = buildResolvedLookup(ctx);
  const resolvedOp = lookupResolved(op, resolvedLookup);
  const hidden = buildHiddenParams(resolvedOp);
  const hasVisibleQueryParams = op.queryParams.filter((qp) => !hidden.has(qp.name)).length > 0;
  const hasBody = plan.hasBody && op.requestBody;
  let hasVisibleBodyFields = false;
  if (hasBody && op.requestBody?.kind === 'model') {
    const bodyModel = ctx.spec.models.find((m) => op.requestBody?.kind === 'model' && m.name === op.requestBody.name);
    if (bodyModel) {
      hasVisibleBodyFields = bodyModel.fields.some((f) => !hidden.has(f.name));
    }
  } else if (hasBody) {
    hasVisibleBodyFields = true;
  }

  if (hasVisibleBodyFields || hasVisibleQueryParams) {
    const method = resolveGoMethodName(op, mountName, ctx);
    const pName = paramsStructName(mountName, method);
    args.push(`&${ctx.namespace}.${pName}{}`);
  }

  return args.join(', ');
}

/**
 * Build method call args with a populated filter param for list tests.
 * If filterParam is provided, populates it in the params struct initializer.
 */
function buildMethodCallArgsWithFilter(
  op: Operation,
  plan: any,
  ctx: EmitterContext,
  mountName: string,
  filterParam?: { name: string; type: import('@workos/oagen').TypeRef } | null,
): string {
  const args: string[] = ['context.Background()'];

  for (const p of sortPathParamsByTemplateOrder(op)) {
    args.push(`"test_${p.name}"`);
  }

  const resolvedLookup = buildResolvedLookup(ctx);
  const resolvedOp = lookupResolved(op, resolvedLookup);
  const hidden = buildHiddenParams(resolvedOp);
  const hasVisibleQueryParams = op.queryParams.filter((qp) => !hidden.has(qp.name)).length > 0;
  const hasBody = plan.hasBody && op.requestBody;
  let hasVisibleBodyFields = false;
  if (hasBody && op.requestBody?.kind === 'model') {
    const bodyModel = ctx.spec.models.find((m) => op.requestBody?.kind === 'model' && m.name === op.requestBody.name);
    if (bodyModel) {
      hasVisibleBodyFields = bodyModel.fields.some((f) => !hidden.has(f.name));
    }
  } else if (hasBody) {
    hasVisibleBodyFields = true;
  }

  if (hasVisibleBodyFields || hasVisibleQueryParams) {
    const method = resolveGoMethodName(op, mountName, ctx);
    const pName = paramsStructName(mountName, method);
    if (filterParam) {
      const isPaginationField = ['before', 'after', 'limit', 'order'].includes(filterParam.name);
      // Check if params struct embeds PaginationParams (has before/after/limit)
      const allQPs = op.queryParams.filter((qp) => !hidden.has(qp.name));
      const embedsPagination = ['before', 'after', 'limit'].every((name) => allQPs.some((qp) => qp.name === name));
      const goField = goFieldName(filterParam.name);

      let valExpr: string;
      if (filterParam.name === 'limit') {
        valExpr = `${goField}: ptrInt(10)`;
      } else {
        valExpr = `${goField}: ptrString("test_${filterParam.name}")`;
      }

      if (isPaginationField && embedsPagination) {
        // Pagination fields are embedded — set via embedded struct
        args.push(`&${ctx.namespace}.${pName}{PaginationParams: ${ctx.namespace}.PaginationParams{${valExpr}}}`);
      } else {
        args.push(`&${ctx.namespace}.${pName}{${valExpr}}`);
      }
    } else {
      args.push(`&${ctx.namespace}.${pName}{}`);
    }
  }

  return args.join(', ');
}

/** Build the expected URL path with test placeholder values. */
function buildExpectedPath(op: Operation): string {
  let expected = op.path;
  for (const p of sortPathParamsByTemplateOrder(op)) {
    expected = expected.replace(`{${p.name}}`, `test_${p.name}`);
  }
  return expected;
}

function generateWrapperTestLines(
  testName: string,
  accessorName: string,
  wrapperMethod: string,
  httpMethod: string,
  expectedPath: string,
  fixturePath: string | null,
  callArgs: string,
  responseType: string | null,
  namespace: string,
): string[] {
  const lines: string[] = [];
  const serverHandler = [
    '\tserver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {',
    `\t\trequire.Equal(t, "${httpMethod}", r.Method)`,
    `\t\trequire.Equal(t, "${expectedPath}", r.URL.Path)`,
    '\t\tw.Header().Set("Content-Type", "application/json")',
    '\t\tw.WriteHeader(http.StatusOK)',
  ];
  if (fixturePath) {
    serverHandler.push(`\t\tfixture, err := os.ReadFile("${fixturePath}")`);
    serverHandler.push('\t\tif err != nil {');
    serverHandler.push('\t\t\tt.Fatalf("failed to read fixture: %v", err)');
    serverHandler.push('\t\t}');
    serverHandler.push('\t\tw.Write(fixture)');
  } else {
    serverHandler.push('\t\tw.Write([]byte(`{}`))');
  }
  serverHandler.push('\t}))');

  // Add body validation for wrapper POST methods before building handler lines
  const isWrapperBodyMethod = httpMethod === 'POST' || httpMethod === 'PUT' || httpMethod === 'PATCH';
  if (isWrapperBodyMethod) {
    const headerIdx = serverHandler.findIndex((l) => l.includes('w.Header().Set'));
    if (headerIdx >= 0) {
      serverHandler.splice(
        headerIdx,
        0,
        '\t\tbody, _ := io.ReadAll(r.Body)',
        '\t\tvar bodyMap map[string]interface{}',
        '\t\trequire.NoError(t, json.Unmarshal(body, &bodyMap))',
      );
    }
  }

  lines.push(`func ${testName}(t *testing.T) {`);
  lines.push(...serverHandler);
  lines.push('\tdefer server.Close()');
  lines.push('');
  lines.push(`\tclient := ${namespace}.NewClient("sk_test", ${namespace}.WithBaseURL(server.URL))`);

  if (responseType) {
    lines.push(`\tresult, err := client.${accessorName}().${wrapperMethod}(${callArgs})`);
    lines.push('\trequire.NoError(t, err)');
    lines.push('\trequire.NotNil(t, result)');
  } else {
    lines.push(`\terr := client.${accessorName}().${wrapperMethod}(${callArgs})`);
    lines.push('\trequire.NoError(t, err)');
  }

  lines.push('}');
  lines.push('');
  return lines;
}

/**
 * Build field value assertions from fixture data for a response model.
 * Returns Go assertion lines (without leading \t).
 * Checks id field and 1-2 other required string fields.
 */
function buildFixtureAssertions(model: import('@workos/oagen').Model, _namespace: string): string[] {
  const assertions: string[] = [];
  const fixtureValues = generateModelFixtureValues(model);

  // Priority: assert the 'id' field first
  const idField = model.fields.find((f) => f.required && f.name === 'id');
  if (idField && fixtureValues[idField.name] != null) {
    const goField = goFieldName(idField.name);
    const val = fixtureValues[idField.name];
    if (typeof val === 'string' && isGoStringSafe(val)) {
      assertions.push(`require.Equal(t, "${escapeGoString(val)}", result.${goField})`);
    } else {
      assertions.push(`require.NotEmpty(t, result.${goField})`);
    }
  }

  // Assert 1-2 other required string fields
  let extraCount = 0;
  for (const field of model.fields) {
    if (extraCount >= 2) break;
    if (field.name === 'id') continue;
    if (!field.required) continue;
    if (field.type.kind !== 'primitive' || field.type.type !== 'string') continue;
    const val = fixtureValues[field.name];
    if (val == null) continue;
    const goField = goFieldName(field.name);
    if (typeof val === 'string' && isGoStringSafe(val)) {
      assertions.push(`require.Equal(t, "${escapeGoString(val)}", result.${goField})`);
    } else {
      assertions.push(`require.NotEmpty(t, result.${goField})`);
    }
    extraCount++;
  }

  // Fallback: at least assert NotEmpty on the first required string field
  if (assertions.length === 0) {
    const targetField =
      model.fields.find((f) => f.required && f.name === 'id') ||
      model.fields.find((f) => f.required && f.type.kind === 'primitive' && f.type.type === 'string');
    if (targetField) {
      assertions.push(`require.NotEmpty(t, result.${goFieldName(targetField.name)})`);
    }
  }

  return assertions;
}

/** Check if a string value can be safely embedded in a Go double-quoted string. */
function isGoStringSafe(val: string): boolean {
  // Skip values that look like JSON objects/arrays or contain template expressions
  if (val.includes('{') || val.includes('}') || val.includes('`')) return false;
  return true;
}

/** Escape special characters for a Go double-quoted string. */
function escapeGoString(val: string): string {
  return val.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Generate fixture values for a model (same logic as fixtures.ts but inline). */
function generateModelFixtureValues(model: import('@workos/oagen').Model): Record<string, any> {
  const fixture: Record<string, any> = {};
  for (const field of model.fields) {
    if (field.example !== undefined) {
      fixture[field.name] = field.example;
    } else if (field.type.kind === 'primitive' && field.type.type === 'string') {
      if (field.name === 'id') {
        const prefix = (ID_PREFIXES as Record<string, string>)[model.name] ?? '';
        fixture[field.name] = `${prefix}01234`;
      } else if (field.name.includes('email')) {
        fixture[field.name] = 'test@example.com';
      } else if (field.name.includes('name')) {
        fixture[field.name] = 'Test';
      } else {
        fixture[field.name] = `test_${field.name}`;
      }
    }
  }
  return fixture;
}

// Re-import fixture ID prefixes
import { ID_PREFIXES } from './fixtures.js';
