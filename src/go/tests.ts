import type { ApiSpec, Service, Operation, EmitterContext, GeneratedFile } from '@workos/oagen';
import { planOperation, toSnakeCase } from '@workos/oagen';
import { fileName, resolveMethodName, methodName as goMethodName } from './naming.js';
import { resolveResourceClassName, paramsStructName } from './resources.js';
import { buildServiceAccessPaths } from './client.js';
import { generateFixtures } from './fixtures.js';
import { groupByMount, buildResolvedLookup, lookupResolved } from '../shared/resolved-ops.js';
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
  lines.push('import (');
  lines.push('\t"context"');
  lines.push('\t"net/http"');
  lines.push('\t"net/http/httptest"');
  lines.push('\t"os"');
  lines.push('\t"testing"');
  lines.push('');
  lines.push(`\t"${resolveModulePath(ctx)}"`);
  lines.push('\t"github.com/stretchr/testify/require"');
  lines.push(')');
  lines.push('');

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
      // Find the right fixture -- either a list fixture or a model fixture
      const itemModelName = op.pagination.itemType.kind === 'model' ? op.pagination.itemType.name : null;
      let fixturePath = itemModelName ? `testdata/list_${fileName(itemModelName)}.json` : null;

      lines.push(`func ${testName}(t *testing.T) {`);
      lines.push('\tserver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {');
      lines.push(`\t\trequire.Equal(t, "${op.httpMethod.toUpperCase()}", r.Method)`);
      lines.push('\t\tw.Header().Set("Content-Type", "application/json")');
      lines.push('\t\tw.WriteHeader(http.StatusOK)');
      if (fixturePath) {
        lines.push(`\t\tfixture, _ := os.ReadFile("${fixturePath}")`);
        lines.push('\t\tw.Write(fixture)');
      } else {
        lines.push('\t\tw.Write([]byte(`{"data":[],"list_metadata":{"before":null,"after":null}}`))');
      }
      lines.push('\t}))');
      lines.push('\tdefer server.Close()');
      lines.push('');
      lines.push(`\tclient := ${ctx.namespace}.NewClient("sk_test", ${ctx.namespace}.WithBaseURL(server.URL))`);

      // Build method call
      const callArgs = buildMethodCallArgs(op, plan, ctx, resolvedName);
      lines.push(`\titer := client.${accessorName}().${method}(${callArgs})`);
      lines.push('\trequire.NotNil(t, iter)');
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
      lines.push(`func ${testName}(t *testing.T) {`);
      lines.push('\tserver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {');
      lines.push(`\t\trequire.Equal(t, "${op.httpMethod.toUpperCase()}", r.Method)`);
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
      const fixturePath = `testdata/${fileName(respModel)}.json`;

      lines.push(`func ${testName}(t *testing.T) {`);
      lines.push('\tserver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {');
      lines.push(`\t\trequire.Equal(t, "${op.httpMethod.toUpperCase()}", r.Method)`);
      lines.push('\t\tw.Header().Set("Content-Type", "application/json")');
      lines.push('\t\tw.WriteHeader(http.StatusOK)');
      lines.push(`\t\tfixture, _ := os.ReadFile("${fixturePath}")`);
      lines.push('\t\tw.Write(fixture)');
      lines.push('\t}))');
      lines.push('\tdefer server.Close()');
      lines.push('');
      lines.push(`\tclient := ${ctx.namespace}.NewClient("sk_test", ${ctx.namespace}.WithBaseURL(server.URL))`);

      const callArgs = buildMethodCallArgs(op, plan, ctx, resolvedName);
      lines.push(`\tresult, err := client.${accessorName}().${method}(${callArgs})`);
      lines.push('\trequire.NoError(t, err)');
      lines.push('\trequire.NotNil(t, result)');
      lines.push('}');
      lines.push('');
    } else {
      // Void response test
      lines.push(`func ${testName}(t *testing.T) {`);
      lines.push('\tserver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {');
      lines.push(`\t\trequire.Equal(t, "${op.httpMethod.toUpperCase()}", r.Method)`);
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
      for (const p of op.pathParams) {
        wrapperCallArgs.push(`"test_${p.name}"`);
      }
      wrapperCallArgs.push(`&${ctx.namespace}.${wrapperParamsStruct}{}`);

      lines.push(
        ...generateWrapperTestLines(
          testName,
          accessorName,
          wrapperMethod,
          op.httpMethod.toUpperCase(),
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

  // Path params
  for (const p of op.pathParams) {
    args.push(`"test_${p.name}"`);
  }

  // Params struct if needed (uses service-prefixed name matching resources.ts)
  const hasQueryParams = op.queryParams.length > 0;
  const hasBody = plan.hasBody && op.requestBody;
  if (hasBody || hasQueryParams) {
    const method = resolveGoMethodName(op, mountName, ctx);
    const pName = paramsStructName(mountName, method);
    args.push(`&${ctx.namespace}.${pName}{}`);
  }

  return args.join(', ');
}

function generateWrapperTestLines(
  testName: string,
  accessorName: string,
  wrapperMethod: string,
  httpMethod: string,
  fixturePath: string | null,
  callArgs: string,
  responseType: string | null,
  namespace: string,
): string[] {
  const lines: string[] = [];
  const serverHandler = [
    '\tserver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {',
    `\t\trequire.Equal(t, "${httpMethod}", r.Method)`,
    '\t\tw.Header().Set("Content-Type", "application/json")',
    '\t\tw.WriteHeader(http.StatusOK)',
  ];
  if (fixturePath) {
    serverHandler.push(`\t\tfixture, _ := os.ReadFile("${fixturePath}")`);
    serverHandler.push('\t\tw.Write(fixture)');
  } else {
    serverHandler.push('\t\tw.Write([]byte(`{}`))');
  }
  serverHandler.push('\t}))');

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
