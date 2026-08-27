import type {
  ApiSpec,
  Service,
  Operation,
  EmitterContext,
  GeneratedFile,
  TypeRef,
  Model,
  ResolvedOperation,
} from '@workos/oagen';
import { planOperation, toSnakeCase } from '@workos/oagen';
import {
  className,
  fileName,
  fieldName,
  domainFieldName,
  moduleName,
  resolveMethodName,
  buildMountDirMap,
  dirToModule,
} from './naming.js';
import { resolveResourceClassName, bodyParamName } from './resources.js';
import { buildServiceAccessPaths } from './client.js';
import { generateFixtures, generateModelFixture } from './fixtures.js';
import { isListWrapperModel, isListMetadataModel } from './models.js';
import { collectNonPaginatedResponseModelNames, collectReferencedListMetadataModels } from '../shared/model-utils.js';
import {
  scopedMountGroups,
  buildResolvedLookup,
  lookupResolved,
  buildHiddenParams,
  collectGroupedParamNames,
  isScopedRun,
  isModelInScope,
  fileExistsAfterRun,
} from '../shared/resolved-ops.js';
import { resolveWrapperParams } from '../shared/wrapper-utils.js';
import {
  type AggregateBlock,
  exclusivelyInScopeKeys,
  readPriorFile,
  reconcileScopedBlocks,
} from '../shared/scoped-aggregate-merge.js';
import { pythonLiteral } from './wrappers.js';
import { computeSchemaPlacement } from './shared-schemas.js';

/**
 * Resolve the Python class name to use for isinstance checks on paginated items.
 * For discriminated unions, generates the fixture and determines which variant
 * the discriminator value maps to. For regular models, returns the model class.
 */
function resolvePaginatedItemClass(itemName: string | null, spec: ApiSpec): string | null {
  if (!itemName) return null;
  const itemModel = spec.models.find((m) => m.name === itemName);
  if (!itemModel) return className(itemName);

  const disc = (itemModel as any).discriminator as { property: string; mapping: Record<string, string> } | undefined;
  if (!disc) return className(itemName);

  // Generate the fixture to determine which discriminator value appears
  const modelMap = new Map(spec.models.map((m) => [m.name, m]));
  const enumMap = new Map(spec.enums.map((e) => [e.name, e]));
  const fixture = generateModelFixture(itemModel, modelMap, enumMap);
  const discValue = fixture[disc.property];

  if (typeof discValue === 'string' && disc.mapping[discValue]) {
    return className(disc.mapping[discValue]);
  }

  // Fallback: first variant alphabetically
  const sortedEntries = Object.entries(disc.mapping).sort(([a], [b]) => a.localeCompare(b));
  if (sortedEntries.length > 0) return className(sortedEntries[0][1]);

  return className(itemName);
}

/** Push an async test method definition with @pytest.mark.asyncio decorator. */
function pushAsyncTestDef(lines: string[], def: string): void {
  lines.push('    @pytest.mark.asyncio');
  lines.push(def);
}

function buildDeleteSuccessResponseSetup(op: Operation): string {
  const statusCode = op.successResponses?.[0]?.statusCode ?? 204;
  if (statusCode === 204) {
    return 'httpx_mock.add_response(status_code=204)';
  }
  return `httpx_mock.add_response(status_code=${statusCode}, content=b"\\n")`;
}

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
      integrateTarget: true,
      overwriteExisting: true,
    });
  }

  // conftest.py, generated_helpers.py, test_pagination.py, and test_generated_client.py
  // are now hand-maintained in the target SDK (@oagen-ignore-file).

  // Build access path map for all services
  const accessPaths = buildServiceAccessPaths(spec.services, ctx);

  // Generate per-mount-target test files (merges all sub-services into one file)
  const mountGroups = scopedMountGroups(ctx);
  const testEntries: Array<{
    name: string;
    operations: Operation[];
    resolvedOps?: ResolvedOperation[];
  }> =
    mountGroups.size > 0 || ctx.scopedServices?.size
      ? [...mountGroups].map(([name, group]) => ({
          name,
          operations: group.operations,
          resolvedOps: group.resolvedOps,
        }))
      : spec.services.map((s) => ({
          name: resolveResourceClassName(s, ctx),
          operations: s.operations,
        }));

  for (const { name: mountName, operations, resolvedOps } of testEntries) {
    if (operations.length === 0) continue;
    const mergedService: Service = { name: mountName, operations };
    const testFile = generateServiceTest(mergedService, spec, ctx, accessPaths, resolvedOps);
    if (testFile) files.push(testFile);
  }

  // Model round-trip tests (P3-7): one file per service dir
  // (tests/test_<dir>_models_round_trip.py), each covering only that dir's
  // models regenerated this run. Unlike the former wholesale file — which a
  // scoped run skipped, leaving it stale until a full regen — a scoped run now
  // regenerates the selected services' round-trip tests in lockstep with their
  // models (fixing "selected model changed shape but its round-trip test still
  // asserts the old shape") and leaves untouched services' files alone.
  files.push(...generateModelRoundTripTests(spec, ctx));
  const legacyRoundTrip = retireLegacyRoundTripMonolith(ctx);
  if (legacyRoundTrip) files.push(legacyRoundTrip);

  return files;
}

function generateServiceTest(
  service: Service,
  spec: ApiSpec,
  ctx: EmitterContext,
  accessPaths: Map<string, string>,
  resolvedOps?: ResolvedOperation[],
): GeneratedFile | null {
  if (service.operations.length === 0) return null;

  const resolvedName = resolveResourceClassName(service, ctx);
  const propName = accessPaths.get(service.name) ?? toSnakeCase(resolvedName);

  const lines: string[] = [];

  lines.push('import json');
  lines.push('');
  lines.push('import pytest');
  lines.push(`from ${ctx.namespace} import WorkOSClient, AsyncWorkOSClient`);
  lines.push('from tests.generated_helpers import load_fixture');
  lines.push('');

  // Collect model and enum imports needed (response models, body field models, and enum params)
  const modelImports = new Set<string>();
  const enumImports = new Set<string>();
  for (const op of service.operations) {
    const plan = planOperation(op);
    if (plan.responseModelName) {
      modelImports.add(plan.responseModelName);
      // For non-paginated discriminated union responses, import the resolved variant class
      if (!plan.isPaginated) {
        const resolvedVariantClass = resolvePaginatedItemClass(plan.responseModelName, spec);
        if (resolvedVariantClass && resolvedVariantClass !== className(plan.responseModelName)) {
          const responseModel = spec.models.find((m) => m.name === plan.responseModelName);
          const disc =
            responseModel &&
            ((responseModel as any).discriminator as { property: string; mapping: Record<string, string> } | undefined);
          if (disc) {
            for (const variantName of Object.values(disc.mapping)) {
              if (className(variantName) === resolvedVariantClass) {
                modelImports.add(variantName);
                break;
              }
            }
          }
        }
      }
    }
    if (op.pagination?.itemType.kind === 'model') {
      modelImports.add(op.pagination.itemType.name);
      // Unwrap list wrapper to find the inner item model (may be a discriminated union)
      let paginationItemName = op.pagination.itemType.name;
      const wrapperModel = spec.models.find((m) => m.name === paginationItemName);
      if (wrapperModel && isListWrapperModel(wrapperModel)) {
        const dataField = wrapperModel.fields.find((f) => f.name === 'data');
        if (dataField && dataField.type.kind === 'array' && dataField.type.items.kind === 'model') {
          paginationItemName = dataField.type.items.name;
          modelImports.add(paginationItemName);
        }
      }
      // For discriminated union pagination items, import the variant that the fixture resolves to
      const resolvedVariantClass = resolvePaginatedItemClass(paginationItemName, spec);
      if (resolvedVariantClass && resolvedVariantClass !== className(paginationItemName)) {
        // Find the model name from the class name — reverse-lookup through the discriminator mapping
        const paginationModel = spec.models.find((m) => m.name === paginationItemName);
        const disc =
          paginationModel &&
          ((paginationModel as any).discriminator as { property: string; mapping: Record<string, string> } | undefined);
        if (disc) {
          for (const variantName of Object.values(disc.mapping)) {
            if (className(variantName) === resolvedVariantClass) {
              modelImports.add(variantName);
              break;
            }
          }
        }
      }
    }
    // Collect model-typed and enum-typed body fields (used as method arguments)
    if (plan.hasBody && op.requestBody?.kind === 'model') {
      const bodyModel = spec.models.find((m) => m.name === (op.requestBody as any).name);
      if (bodyModel) {
        const testGroupedParams = collectGroupedParamNames(op);
        for (const f of bodyModel.fields) {
          if (testGroupedParams.has(f.name)) continue;
          if (f.type.kind === 'model') modelImports.add(f.type.name);
          if (f.type.kind === 'nullable' && f.type.inner.kind === 'model') modelImports.add(f.type.inner.name);
          if (f.type.kind === 'array' && f.type.items.kind === 'model') modelImports.add(f.type.items.name);
          if (f.type.kind === 'enum') enumImports.add(f.type.name);
          if (f.type.kind === 'nullable' && f.type.inner.kind === 'enum') enumImports.add(f.type.inner.name);
        }
      }
    }
    // Collect enum-typed query params
    for (const param of op.queryParams) {
      if (param.type.kind === 'enum') enumImports.add(param.type.name);
      if (param.type.kind === 'nullable' && param.type.inner.kind === 'enum') enumImports.add(param.type.inner.name);
    }
  }

  // Filter out list wrapper models, but keep non-paginated response wrappers
  const nonPaginatedRefs = collectNonPaginatedResponseModelNames(spec.services);
  const actualImports = [...modelImports].filter((name) => {
    const model = spec.models.find((m) => m.name === name);
    if (!model) return true;
    if (isListWrapperModel(model) && !nonPaginatedRefs.has(name)) return false;
    return true;
  });

  // Group imports by their actual service directory (models may live in different services)
  const placement = computeSchemaPlacement(spec, ctx);
  const modelToServiceMap = placement.modelToService;
  const enumToServiceMap = placement.enumToService;
  const mountDirMap = buildMountDirMap(ctx);
  const resolveModelDir = (modelName: string) => {
    const svc = modelToServiceMap.get(modelName);
    return svc ? (mountDirMap.get(svc) ?? 'common') : 'common';
  };
  const resolveEnumDir = (enumName: string) => {
    const svc = enumToServiceMap.get(enumName);
    return svc ? (mountDirMap.get(svc) ?? 'common') : 'common';
  };

  const importsByDir = new Map<string, string[]>();
  for (const name of actualImports.sort()) {
    const modelDir = resolveModelDir(name);
    if (!importsByDir.has(modelDir)) importsByDir.set(modelDir, []);
    importsByDir.get(modelDir)!.push(className(name));
  }
  for (const name of [...enumImports].sort()) {
    const enumDir = resolveEnumDir(name);
    if (!importsByDir.has(enumDir)) importsByDir.set(enumDir, []);
    const existing = importsByDir.get(enumDir)!;
    const cn = className(name);
    if (!existing.includes(cn)) existing.push(cn);
  }

  for (const [modelDir, names] of [...importsByDir].sort()) {
    lines.push(`from ${ctx.namespace}.${dirToModule(modelDir)}.models import ${names.join(', ')}`);
  }

  const hasPaginated = service.operations.some((op) => op.pagination);
  if (hasPaginated) {
    lines.push(`from ${ctx.namespace}._pagination import AsyncPage, SyncPage`);
  }
  lines.push(
    `from ${ctx.namespace}._errors import AuthenticationError, BadRequestError, NotFoundError, RateLimitExceededError, ServerError, UnprocessableEntityError`,
  );

  // Import parameter group variant classes
  const groupVariantImports = new Set<string>();
  for (const op of service.operations) {
    for (const group of op.parameterGroups ?? []) {
      for (const variant of group.variants) {
        groupVariantImports.add(className(`${group.name}_${variant.name}`));
      }
    }
  }
  if (groupVariantImports.size > 0) {
    const mountDir = dirToModule(buildMountDirMap(ctx).get(service.name) ?? moduleName(service.name));
    lines.push(`from ${ctx.namespace}.${mountDir}._resource import ${[...groupVariantImports].join(', ')}`);
  }

  lines.push('');
  lines.push('');
  lines.push(`class Test${resolvedName}:`);

  const resolvedLookup = buildResolvedLookup(ctx);
  // Redirect/urlBuilder ops construct a URL instead of making an HTTP request;
  // the canonical marker is the `urlBuilder` hint on the resolved operation.
  const isRedirectEndpoint = (op: Operation): boolean => lookupResolved(op, resolvedLookup)?.urlBuilder ?? false;
  const emittedTestMethods = new Set<string>();
  for (const op of service.operations) {
    const plan = planOperation(op);
    const resolvedOp = lookupResolved(op, resolvedLookup);
    const hiddenParams = buildHiddenParams(resolvedOp);
    let method = resolveMethodName(op, service, ctx);

    // On name collision, fall back to the full snake_case operation name (match resource dedup)
    if (emittedTestMethods.has(method)) {
      const fallback = toSnakeCase(op.name);
      if (fallback !== method && !emittedTestMethods.has(fallback)) {
        method = fallback;
      } else {
        continue;
      }
    }
    emittedTestMethods.add(method);

    const isDelete = plan.isDelete;
    const isPaginated = plan.isPaginated;
    const isArrayResponse = op.response.kind === 'array' && op.response.items.kind === 'model';

    lines.push('');

    if (isPaginated) {
      const itemType = op.pagination!.itemType;
      let itemName = itemType.kind === 'model' ? itemType.name : null;
      // Unwrap list wrapper models to their inner item type for fixture names
      if (itemName) {
        const wrapperModel = spec.models.find((m) => m.name === itemName);
        if (wrapperModel && isListWrapperModel(wrapperModel)) {
          const dataField = wrapperModel.fields.find((f) => f.name === 'data');
          if (dataField && dataField.type.kind === 'array' && dataField.type.items.kind === 'model') {
            itemName = dataField.type.items.name;
          }
        }
      }
      // Skip fixture-based testing for models with no fields (discriminated unions)
      // Save the unwrapped name before nulling — needed for discriminator check below
      const unwrappedItemName = itemName;
      if (itemName) {
        const itemModel = spec.models.find((m) => m.name === itemName);
        if (itemModel && itemModel.fields.length === 0) itemName = null;
      }
      const fixtureName = itemName ? `list_${fileName(itemName)}.json` : null;

      // Determine the class name to use for isinstance checks on paginated items.
      // If the item model is a discriminated union (has a discriminator), the fixture
      // will deserialize to a concrete variant, so assert on that variant class.
      const paginatedItemClass = resolvePaginatedItemClass(itemName, spec);

      const paginatedArgs = buildTestArgs(op, spec, hiddenParams);
      lines.push(`    def test_${method}(self, workos, httpx_mock):`);
      if (fixtureName) {
        lines.push(`        httpx_mock.add_response(`);
        lines.push(`            json=load_fixture("${fixtureName}"),`);
        lines.push('        )');
        lines.push(`        page = workos.${propName}.${method}(${paginatedArgs})`);
        lines.push('        assert isinstance(page, SyncPage)');
        lines.push('        assert len(page.data) == 1');
        lines.push(`        assert isinstance(page.data[0], ${paginatedItemClass})`);

        lines.push('');
        lines.push(`    def test_${method}_empty_page(self, workos, httpx_mock):`);
        lines.push('        httpx_mock.add_response(json={"data": [], "list_metadata": {}})');
        lines.push(`        page = workos.${propName}.${method}(${paginatedArgs})`);

        lines.push('        assert isinstance(page, SyncPage)');
        lines.push('        assert page.data == []');
      } else {
        // Check if the unwrapped item is a discriminated union — test dispatch through pagination
        const discModel = unwrappedItemName ? spec.models.find((m) => m.name === unwrappedItemName) : null;
        const disc =
          discModel && (discModel as any).discriminator
            ? ((discModel as any).discriminator as {
                property: string;
                mapping: Record<string, string>;
              })
            : null;
        const discEntries = disc ? Object.entries(disc.mapping).sort(([a], [b]) => a.localeCompare(b)) : [];
        if (disc && discEntries.length > 0) {
          const [, firstVariantName] = discEntries[0];
          const variantFixture = `${fileName(firstVariantName)}.json`;
          const variantClass = className(firstVariantName);
          lines.push('        httpx_mock.add_response(');
          lines.push(`            json={"data": [load_fixture("${variantFixture}")], "list_metadata": {}},`);
          lines.push('        )');
          lines.push(`        page = workos.${propName}.${method}(${paginatedArgs})`);
          lines.push('        assert isinstance(page, SyncPage)');
          lines.push('        assert len(page.data) == 1');
          lines.push(`        assert isinstance(page.data[0], ${variantClass})`);
        } else {
          lines.push('        httpx_mock.add_response(json={"data": [], "list_metadata": {}})');
          lines.push(`        page = workos.${propName}.${method}(${paginatedArgs})`);
          lines.push('        assert isinstance(page, SyncPage)');
        }
      }
    } else if (isDelete) {
      lines.push(`    def test_${method}(self, workos, httpx_mock):`);
      lines.push(`        ${buildDeleteSuccessResponseSetup(op)}`);
      const args = buildTestArgs(op, spec, hiddenParams);
      lines.push(`        result = workos.${propName}.${method}(${args})`);
      lines.push('        assert result is None');
      // Request assertions for delete
      const deletePath = buildExpectedPath(op);
      lines.push('        request = httpx_mock.get_request()');
      lines.push(`        assert request.method == "DELETE"`);
      lines.push(`        assert request.url.path.endswith("/${deletePath}")`);
    } else if (isRedirectEndpoint(op)) {
      // Redirect endpoint: returns a URL string, no HTTP request made
      const args = buildTestArgs(op, spec, hiddenParams);
      lines.push(`    def test_${method}(self, workos):`);
      lines.push(`        result = workos.${propName}.${method}(${args})`);
      lines.push('        assert isinstance(result, str)');
      lines.push('        assert result.startswith("http")');
    } else if (isArrayResponse) {
      // Array response: returns List[Model]
      const modelClass = className(plan.responseModelName!);
      const fixtureName = `${fileName(plan.responseModelName!)}.json`;
      const args = buildTestArgs(op, spec, hiddenParams);
      lines.push(`    def test_${method}(self, workos, httpx_mock):`);
      lines.push(`        httpx_mock.add_response(json=[load_fixture("${fixtureName}")])`);
      lines.push(`        result = workos.${propName}.${method}(${args})`);
      lines.push('        assert isinstance(result, list)');
      lines.push(`        assert len(result) == 1`);
      lines.push(`        assert isinstance(result[0], ${modelClass})`);
    } else if (plan.responseModelName) {
      const modelName = plan.responseModelName;
      const fixtureName = `${fileName(modelName)}.json`;
      const modelClass = className(modelName);

      // For discriminated union responses, resolve to the concrete variant class
      const resolvedClass = resolvePaginatedItemClass(modelName, spec) ?? modelClass;
      // Pick assertable fields from the resolved variant, not the dispatcher
      const resolvedModelName =
        resolvedClass !== modelClass
          ? (() => {
              const responseModel = spec.models.find((m) => m.name === modelName);
              const disc = (responseModel as any)?.discriminator as { mapping: Record<string, string> } | undefined;
              if (disc) {
                for (const variantName of Object.values(disc.mapping)) {
                  if (className(variantName) === resolvedClass) return variantName;
                }
              }
              return modelName;
            })()
          : modelName;

      lines.push(`    def test_${method}(self, workos, httpx_mock):`);
      lines.push(`        httpx_mock.add_response(`);
      lines.push(`            json=load_fixture("${fixtureName}"),`);
      lines.push('        )');
      const args = buildTestArgs(op, spec, hiddenParams);
      lines.push(`        result = workos.${propName}.${method}(${args})`);
      lines.push(`        assert isinstance(result, ${resolvedClass})`);

      // Field-value assertions: verify at least 2 scalar fields from fixture
      const assertFields = pickAssertableFields(resolvedModelName, spec);
      for (const af of assertFields) {
        const op_ = af.isBool ? 'is' : '==';
        lines.push(`        assert result.${af.field} ${op_} ${af.value}`);
      }

      // Request assertions: verify HTTP method and URL path
      const expectedPath = buildExpectedPath(op);
      lines.push('        request = httpx_mock.get_request()');
      lines.push(`        assert request.method == "${op.httpMethod.toUpperCase()}"`);
      lines.push(`        assert request.url.path.endswith("/${expectedPath}")`);
      // For POST/PUT/PATCH with required body fields, verify specific field values
      if (plan.hasBody && ['post', 'put', 'patch'].includes(op.httpMethod.toLowerCase())) {
        const bodyModel = spec.models.find((m) => op.requestBody?.kind === 'model' && m.name === op.requestBody.name);
        const reqFields = bodyModel?.fields.filter((f) => f.required && !hiddenParams?.has(f.name)) ?? [];
        if (reqFields.length > 0) {
          lines.push('        body = json.loads(request.content)');
          for (const f of reqFields) {
            const testVal = generateTestValue(f.type, f.name);
            // Only assert primitives (strings, numbers, booleans) — skip complex types
            if (f.type.kind === 'primitive' || f.type.kind === 'enum' || f.type.kind === 'literal') {
              lines.push(`        assert body["${f.name}"] == ${testVal}`);
            } else {
              lines.push(`        assert "${f.name}" in body`);
            }
          }
        }
      }
    } else {
      lines.push(`    def test_${method}(self, workos, httpx_mock):`);
      lines.push('        httpx_mock.add_response(json={})');
      const args = buildTestArgs(op, spec, hiddenParams);
      lines.push(`        workos.${propName}.${method}(${args})`);
      // Request assertions for void-returning methods
      const voidPath = buildExpectedPath(op);
      lines.push('        request = httpx_mock.get_request()');
      lines.push(`        assert request.method == "${op.httpMethod.toUpperCase()}"`);
      lines.push(`        assert request.url.path.endswith("/${voidPath}")`);
    }

    if (op.queryParams.length > 0 && !isRedirectEndpoint(op)) {
      const queryArgs = buildQueryEncodingTestArgs(op, spec);
      const queryAssertions = buildQueryEncodingAssertions(op, spec);
      if (queryArgs && queryAssertions.length > 0) {
        const responseSetup = buildQueryEncodingResponseSetup(op, plan);
        lines.push('');
        lines.push(`    def test_${method}_encodes_query_params(self, workos, httpx_mock):`);
        for (const setupLine of responseSetup) {
          lines.push(`        ${setupLine}`);
        }
        lines.push(`        workos.${propName}.${method}(${queryArgs})`);
        lines.push('        request = httpx_mock.get_request()');
        for (const assertion of queryAssertions) {
          lines.push(`        ${assertion}`);
        }
      }
    }
  }

  // Generate tests for wrapper (union-split) methods (sync)
  emitWrapperTests(lines, resolvedOps, propName, spec, ctx, false);

  // Add a RequestOptions propagation test for the first non-redirect operation
  const firstRequestOptionsOp = service.operations.find((op) => !isRedirectEndpoint(op));
  if (firstRequestOptionsOp) {
    const roMethod = resolveMethodName(firstRequestOptionsOp, service, ctx);
    const roPlan = planOperation(firstRequestOptionsOp);
    const roResponseSetup = buildQueryEncodingResponseSetup(firstRequestOptionsOp, roPlan);
    const roArgs = buildTestArgs(
      firstRequestOptionsOp,
      spec,
      buildHiddenParams(lookupResolved(firstRequestOptionsOp, resolvedLookup)),
    );
    const roArgsWithOpts = roArgs
      ? `${roArgs}, request_options={"extra_headers": {"X-Custom": "value"}}`
      : 'request_options={"extra_headers": {"X-Custom": "value"}}';
    lines.push('');
    lines.push(`    def test_${roMethod}_with_request_options(self, workos, httpx_mock):`);
    for (const setupLine of roResponseSetup) {
      lines.push(`        ${setupLine}`);
    }
    lines.push(`        workos.${propName}.${roMethod}(${roArgsWithOpts})`);
    lines.push('        request = httpx_mock.get_request()');
    lines.push('        assert request.headers["X-Custom"] == "value"');
  }

  // Add an error test for the first non-delete, non-redirect operation
  const firstNonDelete = service.operations.find((op) => !planOperation(op).isDelete && !isRedirectEndpoint(op));
  if (firstNonDelete) {
    const method = resolveMethodName(firstNonDelete, service, ctx);
    lines.push('');
    lines.push(`    def test_${method}_unauthorized(self, workos, httpx_mock):`);
    lines.push('        httpx_mock.add_response(');
    lines.push('            status_code=401,');
    lines.push('            json={"message": "Unauthorized"},');
    lines.push('        )');
    lines.push('        with pytest.raises(AuthenticationError):');
    const args = buildTestArgs(firstNonDelete, spec, buildHiddenParams(lookupResolved(firstNonDelete, resolvedLookup)));
    lines.push(`            workos.${propName}.${method}(${args})`);

    lines.push('');
    lines.push(`    def test_${method}_not_found(self, httpx_mock):`);
    lines.push('        workos = WorkOSClient(api_key="sk_test_123", client_id="client_test", max_retries=0)');
    lines.push('        try:');
    lines.push('            httpx_mock.add_response(status_code=404, json={"message": "Not found"})');
    lines.push('            with pytest.raises(NotFoundError):');
    lines.push(`                workos.${propName}.${method}(${args})`);
    lines.push('        finally:');
    lines.push('            workos.close()');

    lines.push('');
    lines.push(`    def test_${method}_rate_limited(self, httpx_mock):`);
    lines.push('        workos = WorkOSClient(api_key="sk_test_123", client_id="client_test", max_retries=0)');
    lines.push('        try:');
    lines.push(
      '            httpx_mock.add_response(status_code=429, headers={"Retry-After": "0"}, json={"message": "Slow down"})',
    );
    lines.push('            with pytest.raises(RateLimitExceededError):');
    lines.push(`                workos.${propName}.${method}(${args})`);
    lines.push('        finally:');
    lines.push('            workos.close()');

    lines.push('');
    lines.push(`    def test_${method}_server_error(self, httpx_mock):`);
    lines.push('        workos = WorkOSClient(api_key="sk_test_123", client_id="client_test", max_retries=0)');
    lines.push('        try:');
    lines.push('            httpx_mock.add_response(status_code=500, json={"message": "Server error"})');
    lines.push('            with pytest.raises(ServerError):');
    lines.push(`                workos.${propName}.${method}(${args})`);
    lines.push('        finally:');
    lines.push('            workos.close()');
  }

  // Add 400/422 error tests for the first non-delete, non-redirect operation
  const firstErrorTargetOp = service.operations.find((op) => !planOperation(op).isDelete && !isRedirectEndpoint(op));
  if (firstErrorTargetOp) {
    const writeMethod = resolveMethodName(firstErrorTargetOp, service, ctx);
    const writeArgs = buildTestArgs(
      firstErrorTargetOp,
      spec,
      buildHiddenParams(lookupResolved(firstErrorTargetOp, resolvedLookup)),
    );

    lines.push('');
    lines.push(`    def test_${writeMethod}_bad_request(self, httpx_mock):`);
    lines.push('        workos = WorkOSClient(api_key="sk_test_123", client_id="client_test", max_retries=0)');
    lines.push('        try:');
    lines.push('            httpx_mock.add_response(status_code=400, json={"message": "Bad request"})');
    lines.push('            with pytest.raises(BadRequestError):');
    lines.push(`                workos.${propName}.${writeMethod}(${writeArgs})`);
    lines.push('        finally:');
    lines.push('            workos.close()');

    lines.push('');
    lines.push(`    def test_${writeMethod}_unprocessable(self, httpx_mock):`);
    lines.push('        workos = WorkOSClient(api_key="sk_test_123", client_id="client_test", max_retries=0)');
    lines.push('        try:');
    lines.push('            httpx_mock.add_response(status_code=422, json={"message": "Unprocessable"})');
    lines.push('            with pytest.raises(UnprocessableEntityError):');
    lines.push(`                workos.${propName}.${writeMethod}(${writeArgs})`);
    lines.push('        finally:');
    lines.push('            workos.close()');
  }

  // --- Async test class ---
  lines.push('');
  lines.push('');
  lines.push(`class TestAsync${resolvedName}:`);

  const asyncEmittedTestMethods = new Set<string>();
  for (const op of service.operations) {
    const plan = planOperation(op);
    const asyncResolvedOp = lookupResolved(op, resolvedLookup);
    const asyncHiddenParams = buildHiddenParams(asyncResolvedOp);
    let method = resolveMethodName(op, service, ctx);

    if (asyncEmittedTestMethods.has(method)) {
      const fallback = toSnakeCase(op.name);
      if (fallback !== method && !asyncEmittedTestMethods.has(fallback)) {
        method = fallback;
      } else {
        continue;
      }
    }
    asyncEmittedTestMethods.add(method);

    const isDelete = plan.isDelete;
    const isPaginated = plan.isPaginated;
    const isAsyncArrayResponse = op.response.kind === 'array' && op.response.items.kind === 'model';
    const asyncArgs = buildTestArgs(op, spec, asyncHiddenParams);

    lines.push('');

    if (isPaginated) {
      const itemType = op.pagination!.itemType;
      let itemName = itemType.kind === 'model' ? itemType.name : null;
      if (itemName) {
        const wrapperModel = spec.models.find((m) => m.name === itemName);
        if (wrapperModel && isListWrapperModel(wrapperModel)) {
          const dataField = wrapperModel.fields.find((f) => f.name === 'data');
          if (dataField && dataField.type.kind === 'array' && dataField.type.items.kind === 'model') {
            itemName = dataField.type.items.name;
          }
        }
      }
      // Skip fixture-based testing for models with no fields (discriminated unions)
      // Save the unwrapped name before nulling — needed for discriminator check below
      const unwrappedItemName = itemName;
      if (itemName) {
        const itemModel = spec.models.find((m) => m.name === itemName);
        if (itemModel && itemModel.fields.length === 0) itemName = null;
      }
      const fixtureName = itemName ? `list_${fileName(itemName)}.json` : null;

      const asyncPaginatedItemClass = resolvePaginatedItemClass(itemName, spec);

      pushAsyncTestDef(lines, `    async def test_${method}(self, async_workos, httpx_mock):`);
      if (fixtureName) {
        lines.push(`        httpx_mock.add_response(json=load_fixture("${fixtureName}"))`);
        lines.push(`        page = await async_workos.${propName}.${method}(${asyncArgs})`);
        lines.push('        assert isinstance(page, AsyncPage)');
        lines.push('        assert len(page.data) == 1');
        lines.push(`        assert isinstance(page.data[0], ${asyncPaginatedItemClass})`);

        lines.push('');
        pushAsyncTestDef(lines, `    async def test_${method}_empty_page(self, async_workos, httpx_mock):`);
        lines.push('        httpx_mock.add_response(json={"data": [], "list_metadata": {}})');
        lines.push(`        page = await async_workos.${propName}.${method}(${asyncArgs})`);
        lines.push('        assert isinstance(page, AsyncPage)');
        lines.push('        assert page.data == []');
      } else {
        // Check if the unwrapped item is a discriminated union — test dispatch through pagination
        const discModel = unwrappedItemName ? spec.models.find((m) => m.name === unwrappedItemName) : null;
        const disc =
          discModel && (discModel as any).discriminator
            ? ((discModel as any).discriminator as {
                property: string;
                mapping: Record<string, string>;
              })
            : null;
        const discEntries = disc ? Object.entries(disc.mapping).sort(([a], [b]) => a.localeCompare(b)) : [];
        if (disc && discEntries.length > 0) {
          const [, firstVariantName] = discEntries[0];
          const variantFixture = `${fileName(firstVariantName)}.json`;
          const variantClass = className(firstVariantName);
          lines.push('        httpx_mock.add_response(');
          lines.push(`            json={"data": [load_fixture("${variantFixture}")], "list_metadata": {}},`);
          lines.push('        )');
          lines.push(`        page = await async_workos.${propName}.${method}(${asyncArgs})`);
          lines.push('        assert isinstance(page, AsyncPage)');
          lines.push('        assert len(page.data) == 1');
          lines.push(`        assert isinstance(page.data[0], ${variantClass})`);
        } else {
          lines.push('        httpx_mock.add_response(json={"data": [], "list_metadata": {}})');
          lines.push(`        page = await async_workos.${propName}.${method}(${asyncArgs})`);
          lines.push('        assert isinstance(page, AsyncPage)');
        }
      }
    } else if (isDelete) {
      const deletePath = buildExpectedPath(op);
      pushAsyncTestDef(lines, `    async def test_${method}(self, async_workos, httpx_mock):`);
      lines.push(`        ${buildDeleteSuccessResponseSetup(op)}`);
      lines.push(`        result = await async_workos.${propName}.${method}(${asyncArgs})`);
      lines.push('        assert result is None');
      lines.push('        request = httpx_mock.get_request()');
      lines.push(`        assert request.method == "DELETE"`);
      lines.push(`        assert request.url.path.endswith("/${deletePath}")`);
    } else if (isRedirectEndpoint(op)) {
      // Redirect methods are sync (def, not async def) even in the async class
      lines.push(`    def test_${method}(self, async_workos):`);
      lines.push(`        result = async_workos.${propName}.${method}(${asyncArgs})`);
      lines.push('        assert isinstance(result, str)');
      lines.push('        assert result.startswith("http")');
    } else if (isAsyncArrayResponse) {
      const modelClass = className(plan.responseModelName!);
      const fixtureName = `${fileName(plan.responseModelName!)}.json`;
      pushAsyncTestDef(lines, `    async def test_${method}(self, async_workos, httpx_mock):`);
      lines.push(`        httpx_mock.add_response(json=[load_fixture("${fixtureName}")])`);
      lines.push(`        result = await async_workos.${propName}.${method}(${asyncArgs})`);
      lines.push('        assert isinstance(result, list)');
      lines.push(`        assert len(result) == 1`);
      lines.push(`        assert isinstance(result[0], ${modelClass})`);
    } else if (plan.responseModelName) {
      const modelName = plan.responseModelName;
      const fixtureName = `${fileName(modelName)}.json`;
      const modelClass = className(modelName);

      // For discriminated union responses, resolve to the concrete variant class
      const asyncResolvedClass = resolvePaginatedItemClass(modelName, spec) ?? modelClass;
      const asyncResolvedModelName =
        asyncResolvedClass !== modelClass
          ? (() => {
              const responseModel = spec.models.find((m) => m.name === modelName);
              const disc = (responseModel as any)?.discriminator as { mapping: Record<string, string> } | undefined;
              if (disc) {
                for (const variantName of Object.values(disc.mapping)) {
                  if (className(variantName) === asyncResolvedClass) return variantName;
                }
              }
              return modelName;
            })()
          : modelName;

      pushAsyncTestDef(lines, `    async def test_${method}(self, async_workos, httpx_mock):`);
      lines.push(`        httpx_mock.add_response(json=load_fixture("${fixtureName}"))`);
      lines.push(`        result = await async_workos.${propName}.${method}(${asyncArgs})`);
      lines.push(`        assert isinstance(result, ${asyncResolvedClass})`);
      // Field-value assertions
      const assertFields = pickAssertableFields(asyncResolvedModelName, spec);
      for (const af of assertFields) {
        const op_ = af.isBool ? 'is' : '==';
        lines.push(`        assert result.${af.field} ${op_} ${af.value}`);
      }
      // Request assertions
      const expectedPath = buildExpectedPath(op);
      lines.push('        request = httpx_mock.get_request()');
      lines.push(`        assert request.method == "${op.httpMethod.toUpperCase()}"`);
      lines.push(`        assert request.url.path.endswith("/${expectedPath}")`);
    } else {
      const voidPath = buildExpectedPath(op);
      pushAsyncTestDef(lines, `    async def test_${method}(self, async_workos, httpx_mock):`);
      lines.push('        httpx_mock.add_response(json={})');
      lines.push(`        await async_workos.${propName}.${method}(${asyncArgs})`);
      lines.push('        request = httpx_mock.get_request()');
      lines.push(`        assert request.method == "${op.httpMethod.toUpperCase()}"`);
      lines.push(`        assert request.url.path.endswith("/${voidPath}")`);
    }

    if (op.queryParams.length > 0 && !isRedirectEndpoint(op)) {
      const queryArgs = buildQueryEncodingTestArgs(op, spec);
      const queryAssertions = buildQueryEncodingAssertions(op, spec);
      if (queryArgs && queryAssertions.length > 0) {
        const responseSetup = buildQueryEncodingResponseSetup(op, plan);
        lines.push('');
        pushAsyncTestDef(lines, `    async def test_${method}_encodes_query_params(self, async_workos, httpx_mock):`);
        for (const setupLine of responseSetup) {
          lines.push(`        ${setupLine}`);
        }
        lines.push(`        await async_workos.${propName}.${method}(${queryArgs})`);
        lines.push('        request = httpx_mock.get_request()');
        for (const assertion of queryAssertions) {
          lines.push(`        ${assertion}`);
        }
      }
    }
  }

  // Generate tests for wrapper (union-split) methods (async)
  emitWrapperTests(lines, resolvedOps, propName, spec, ctx, true);

  // Add async RequestOptions propagation test
  const asyncFirstRequestOptionsOp = service.operations.find((op) => !isRedirectEndpoint(op));
  if (asyncFirstRequestOptionsOp) {
    const asyncRoMethod = resolveMethodName(asyncFirstRequestOptionsOp, service, ctx);
    const asyncRoPlan = planOperation(asyncFirstRequestOptionsOp);
    const asyncRoResponseSetup = buildQueryEncodingResponseSetup(asyncFirstRequestOptionsOp, asyncRoPlan);
    const asyncRoArgs = buildTestArgs(
      asyncFirstRequestOptionsOp,
      spec,
      buildHiddenParams(lookupResolved(asyncFirstRequestOptionsOp, resolvedLookup)),
    );
    const asyncRoArgsWithOpts = asyncRoArgs
      ? `${asyncRoArgs}, request_options={"extra_headers": {"X-Custom": "value"}}`
      : 'request_options={"extra_headers": {"X-Custom": "value"}}';
    lines.push('');
    pushAsyncTestDef(
      lines,
      `    async def test_${asyncRoMethod}_with_request_options(self, async_workos, httpx_mock):`,
    );
    for (const setupLine of asyncRoResponseSetup) {
      lines.push(`        ${setupLine}`);
    }
    lines.push(`        await async_workos.${propName}.${asyncRoMethod}(${asyncRoArgsWithOpts})`);
    lines.push('        request = httpx_mock.get_request()');
    lines.push('        assert request.headers["X-Custom"] == "value"');
  }

  // Async error tests for the first non-delete operation
  const asyncFirstNonDelete = service.operations.find((op) => !planOperation(op).isDelete && !isRedirectEndpoint(op));
  if (asyncFirstNonDelete) {
    const asyncErrMethod = resolveMethodName(asyncFirstNonDelete, service, ctx);
    const asyncErrArgs = buildTestArgs(
      asyncFirstNonDelete,
      spec,
      buildHiddenParams(lookupResolved(asyncFirstNonDelete, resolvedLookup)),
    );
    lines.push('');
    pushAsyncTestDef(lines, `    async def test_${asyncErrMethod}_unauthorized(self, async_workos, httpx_mock):`);
    lines.push('        httpx_mock.add_response(status_code=401, json={"message": "Unauthorized"})');
    lines.push('        with pytest.raises(AuthenticationError):');
    lines.push(`            await async_workos.${propName}.${asyncErrMethod}(${asyncErrArgs})`);
    lines.push('');
    pushAsyncTestDef(lines, `    async def test_${asyncErrMethod}_not_found(self, httpx_mock):`);
    lines.push('        workos = AsyncWorkOSClient(api_key="sk_test_123", client_id="client_test", max_retries=0)');
    lines.push('        try:');
    lines.push('            httpx_mock.add_response(status_code=404, json={"message": "Not found"})');
    lines.push('            with pytest.raises(NotFoundError):');
    lines.push(`                await workos.${propName}.${asyncErrMethod}(${asyncErrArgs})`);
    lines.push('        finally:');
    lines.push('            await workos.close()');
    lines.push('');
    pushAsyncTestDef(lines, `    async def test_${asyncErrMethod}_rate_limited(self, httpx_mock):`);
    lines.push('        workos = AsyncWorkOSClient(api_key="sk_test_123", client_id="client_test", max_retries=0)');
    lines.push('        try:');
    lines.push(
      '            httpx_mock.add_response(status_code=429, headers={"Retry-After": "0"}, json={"message": "Slow down"})',
    );
    lines.push('            with pytest.raises(RateLimitExceededError):');
    lines.push(`                await workos.${propName}.${asyncErrMethod}(${asyncErrArgs})`);
    lines.push('        finally:');
    lines.push('            await workos.close()');
    lines.push('');
    pushAsyncTestDef(lines, `    async def test_${asyncErrMethod}_server_error(self, httpx_mock):`);
    lines.push('        workos = AsyncWorkOSClient(api_key="sk_test_123", client_id="client_test", max_retries=0)');
    lines.push('        try:');
    lines.push('            httpx_mock.add_response(status_code=500, json={"message": "Server error"})');
    lines.push('            with pytest.raises(ServerError):');
    lines.push(`                await workos.${propName}.${asyncErrMethod}(${asyncErrArgs})`);
    lines.push('        finally:');
    lines.push('            await workos.close()');
  }

  // Async 400/422 error tests for the first non-delete, non-redirect operation
  const asyncFirstErrorTargetOp = service.operations.find(
    (op) => !planOperation(op).isDelete && !isRedirectEndpoint(op),
  );
  if (asyncFirstErrorTargetOp) {
    const asyncWriteMethod = resolveMethodName(asyncFirstErrorTargetOp, service, ctx);
    const asyncWriteArgs = buildTestArgs(
      asyncFirstErrorTargetOp,
      spec,
      buildHiddenParams(lookupResolved(asyncFirstErrorTargetOp, resolvedLookup)),
    );

    lines.push('');
    pushAsyncTestDef(lines, `    async def test_${asyncWriteMethod}_bad_request(self, httpx_mock):`);
    lines.push('        workos = AsyncWorkOSClient(api_key="sk_test_123", client_id="client_test", max_retries=0)');
    lines.push('        try:');
    lines.push('            httpx_mock.add_response(status_code=400, json={"message": "Bad request"})');
    lines.push('            with pytest.raises(BadRequestError):');
    lines.push(`                await workos.${propName}.${asyncWriteMethod}(${asyncWriteArgs})`);
    lines.push('        finally:');
    lines.push('            await workos.close()');

    lines.push('');
    pushAsyncTestDef(lines, `    async def test_${asyncWriteMethod}_unprocessable(self, httpx_mock):`);
    lines.push('        workos = AsyncWorkOSClient(api_key="sk_test_123", client_id="client_test", max_retries=0)');
    lines.push('        try:');
    lines.push('            httpx_mock.add_response(status_code=422, json={"message": "Unprocessable"})');
    lines.push('            with pytest.raises(UnprocessableEntityError):');
    lines.push(`                await workos.${propName}.${asyncWriteMethod}(${asyncWriteArgs})`);
    lines.push('        finally:');
    lines.push('            await workos.close()');
  }

  return {
    path: `tests/test_${fileName(resolvedName)}.py`,
    content: lines.join('\n'),
    integrateTarget: true,
    overwriteExisting: true,
  };
}

/**
 * Emit tests for wrapper (union-split) methods.
 *
 * For each resolved operation that has wrappers, emit a test per wrapper
 * that calls the wrapper method, asserts the response type, and verifies
 * that constant defaults appear in the request body.
 */
function emitWrapperTests(
  lines: string[],
  resolvedOps: ResolvedOperation[] | undefined,
  propName: string,
  spec: ApiSpec,
  ctx: EmitterContext,
  isAsync: boolean,
): void {
  if (!resolvedOps) return;

  for (const r of resolvedOps) {
    if (!r.wrappers || r.wrappers.length === 0) continue;

    for (const wrapper of r.wrappers) {
      const method = wrapper.name;
      const wrapperParams = resolveWrapperParams(wrapper, ctx);
      const resolvedResponseClass = wrapper.responseModelName
        ? (resolvePaginatedItemClass(wrapper.responseModelName, spec) ?? className(wrapper.responseModelName))
        : null;
      const fixtureName = wrapper.responseModelName ? `${fileName(wrapper.responseModelName)}.json` : null;

      // Build test args for required wrapper params
      const argParts: string[] = [];
      for (const { paramName, field, isOptional } of wrapperParams) {
        if (isOptional) continue;
        const pyName = fieldName(paramName);
        const testVal = field ? generateTestValue(field.type, field.name) : '"test_value"';
        argParts.push(`${pyName}=${testVal}`);
      }
      const args = argParts.join(', ');

      lines.push('');
      if (isAsync) {
        pushAsyncTestDef(lines, `    async def test_${method}(self, async_workos, httpx_mock):`);
        if (fixtureName) {
          lines.push(`        httpx_mock.add_response(json=load_fixture("${fixtureName}"))`);
          lines.push(`        result = await async_workos.${propName}.${method}(${args})`);
          if (resolvedResponseClass) {
            lines.push(`        assert isinstance(result, ${resolvedResponseClass})`);
          }
        } else {
          lines.push('        httpx_mock.add_response(json={})');
          lines.push(`        await async_workos.${propName}.${method}(${args})`);
        }
      } else {
        lines.push(`    def test_${method}(self, workos, httpx_mock):`);
        if (fixtureName) {
          lines.push(`        httpx_mock.add_response(json=load_fixture("${fixtureName}"))`);
          lines.push(`        result = workos.${propName}.${method}(${args})`);
          if (resolvedResponseClass) {
            lines.push(`        assert isinstance(result, ${resolvedResponseClass})`);
          }
        } else {
          lines.push('        httpx_mock.add_response(json={})');
          lines.push(`        workos.${propName}.${method}(${args})`);
        }
      }

      // Assert the request body contains the correct defaults
      lines.push('        request = httpx_mock.get_request()');
      lines.push(`        assert request.method == "${r.operation.httpMethod.toUpperCase()}"`);

      if (Object.keys(wrapper.defaults).length > 0) {
        lines.push('        body = json.loads(request.content)');
        for (const [key, value] of Object.entries(wrapper.defaults)) {
          lines.push(`        assert body["${key}"] == ${pythonLiteral(value)}`);
        }
      }
    }
  }
}

/**
 * Pick up to N scalar fields from a model fixture to use for value assertions.
 * Returns tuples of [snake_case_field_name, python_literal_value].
 */
function pickAssertableFields(
  modelName: string,
  spec: ApiSpec,
  maxFields: number = 2,
): { field: string; value: string; isBool?: boolean }[] {
  const modelMap = new Map(spec.models.map((m) => [m.name, m]));
  const enumMap = new Map(spec.enums.map((e) => [e.name, e]));
  const model = modelMap.get(modelName);
  if (!model) return [];

  const fixture = generateModelFixture(model, modelMap, enumMap);
  const results: { field: string; value: string; isBool?: boolean }[] = [];

  for (const f of model.fields) {
    if (results.length >= maxFields) break;
    const val = fixture[f.name];
    if (val === undefined || val === null) continue;
    if (typeof val === 'string') {
      // Skip strings containing characters that are hard to represent as Python literals
      if (val.includes('"') || val.includes("'") || val.includes('{') || val.includes('\\') || val.includes('\n'))
        continue;
      // DOMAIN identifier: asserted as `result.<attr>` (honors `domainName`).
      results.push({ field: domainFieldName(f), value: `"${val}"` });
    } else if (typeof val === 'boolean') {
      // Use "is True/False" to satisfy ruff E712
      results.push({
        field: domainFieldName(f),
        value: val ? 'True' : 'False',
        isBool: true,
      });
    } else if (typeof val === 'number') {
      results.push({ field: domainFieldName(f), value: String(val) });
    }
  }
  return results;
}

/**
 * Build a Python string literal for the expected request URL suffix.
 * Replaces path params with their test values.
 */
function buildExpectedPath(op: Operation): string {
  let path = op.path.replace(/^\//, '');
  for (const param of op.pathParams) {
    path = path.replace(`{${param.name}}`, `test_${param.name}`);
  }
  return path;
}

/**
 * Build test arguments string for an operation call.
 */
function buildTestArgs(op: Operation, spec: ApiSpec, hiddenParams?: Set<string>): string {
  const args: string[] = [];

  // Path params as positional args
  for (const param of op.pathParams) {
    args.push(`"test_${param.name}"`);
  }

  const pathParamNames = new Set(op.pathParams.map((p) => fieldName(p.name)));

  // Required body fields as keyword args (matching the expanded-field signature)
  const plan = planOperation(op);
  if (plan.hasBody && op.requestBody?.kind === 'model') {
    const requestBodyName = op.requestBody.name;
    const bodyModel = spec.models.find((m) => m.name === requestBodyName);
    if (bodyModel) {
      const reqFields = bodyModel.fields.filter((f) => f.required && !hiddenParams?.has(f.name));
      for (const f of reqFields) {
        const paramName = bodyParamName(f, pathParamNames);
        args.push(`${paramName}=${generateTestValue(f.type, f.name)}`);
      }
    }
  } else if (plan.hasBody && op.requestBody?.kind === 'union') {
    // Union body — pick the first variant model and use its fixture
    const variants = (op.requestBody as any).variants ?? [];
    const firstModelVariant = variants.find((v: any) => v.kind === 'model');
    if (firstModelVariant) {
      args.push(`body=load_fixture("${fileName(firstModelVariant.name)}.json")`);
    } else {
      args.push('body={}');
    }
  }

  // Per-operation Bearer token auth (e.g., access_token for SSO)
  const hasBearerOverride = op.security?.some((s) => s.schemeName !== 'bearerAuth') ?? false;
  if (hasBearerOverride) {
    const tokenParamName = fieldName(op.security!.find((s) => s.schemeName !== 'bearerAuth')!.schemeName);
    args.push(`${tokenParamName}="test_${tokenParamName}"`);
  }

  // Parameter group args — emit first variant constructor
  const groupedParamNames = collectGroupedParamNames(op);
  for (const group of op.parameterGroups ?? []) {
    const variant = group.variants[0];
    const variantClass = className(`${group.name}_${variant.name}`);
    const variantArgs = variant.parameters.map((p) => `${fieldName(p.name)}="test_value"`).join(', ');
    args.push(`${fieldName(group.name)}=${variantClass}(${variantArgs})`);
  }

  // Required query params (for all methods, including paginated)
  if (plan.hasQueryParams) {
    for (const param of op.queryParams) {
      // Skip hidden/injected params
      if (hiddenParams?.has(param.name)) continue;
      // Skip params that belong to parameter groups
      if (groupedParamNames.has(param.name)) continue;
      // Skip pagination params (they're optional)
      if (plan.isPaginated && ['limit', 'before', 'after', 'order'].includes(param.name)) continue;
      // Skip params already covered by body fields
      if (plan.hasBody && op.requestBody?.kind === 'model') {
        const rbName = op.requestBody.name;
        const bodyModel = spec.models.find((m) => m.name === rbName);
        // Compare the body field's DOMAIN identifier (honors `domainName`)
        // against the param kwarg name; the param has no domainName override.
        if (bodyModel?.fields.some((f) => domainFieldName(f) === fieldName(param.name))) continue;
      }
      if (param.required && !pathParamNames.has(fieldName(param.name))) {
        args.push(`${fieldName(param.name)}=${generateTestValue(param.type, param.name)}`);
      }
    }
  }

  return args.join(', ');
}

function buildQueryEncodingTestArgs(op: Operation, spec: ApiSpec): string {
  const args: string[] = [];
  const groupedParamNames = collectGroupedParamNames(op);

  for (const param of op.pathParams) {
    args.push(`"test_${param.name}"`);
  }

  const pathParamNames = new Set(op.pathParams.map((p) => fieldName(p.name)));
  const plan = planOperation(op);

  if (plan.hasBody && op.requestBody?.kind === 'model') {
    const bodyModel = spec.models.find((m) => m.name === (op.requestBody as { kind: string; name: string }).name);
    const bodyArgGrouped = collectGroupedParamNames(op);
    for (const field of bodyModel?.fields.filter((f) => f.required && !bodyArgGrouped.has(f.name)) ?? []) {
      args.push(`${bodyParamName(field, pathParamNames)}=${generateTestValue(field.type, field.name)}`);
    }
  } else if (plan.hasBody && op.requestBody?.kind === 'union') {
    const variants = (op.requestBody as any).variants ?? [];
    const firstModelVariant = variants.find((v: any) => v.kind === 'model');
    args.push(firstModelVariant ? `body=load_fixture("${fileName(firstModelVariant.name)}.json")` : 'body={}');
  }

  // Parameter group args — emit first variant constructor
  for (const group of op.parameterGroups ?? []) {
    const variant = group.variants[0];
    const variantClass = className(`${group.name}_${variant.name}`);
    const variantArgs = variant.parameters
      .map((p) => `${fieldName(p.name)}=${generateQueryEncodingValue(p.type, p.name)}`)
      .join(', ');
    args.push(`${fieldName(group.name)}=${variantClass}(${variantArgs})`);
  }

  if (plan.isPaginated) {
    args.push('limit=10');
    args.push('before="cursor before"');
    args.push('after="cursor/after"');
    const orderParam = op.queryParams.find((param) => param.name === 'order');
    if (orderParam) {
      args.push(`order=${generateQueryEncodingValue(orderParam.type, 'order')}`);
    }
  }

  for (const param of op.queryParams) {
    if (plan.isPaginated && ['limit', 'before', 'after', 'order'].includes(param.name)) continue;
    if (groupedParamNames.has(param.name)) continue;
    // Include explode=false array params; skip other array params (complex serialization)
    if (param.type.kind === 'array' && (param as any).explode !== false) continue;
    const paramName = fieldName(param.name);
    if (pathParamNames.has(paramName)) continue;
    if (plan.hasBody && op.requestBody?.kind === 'model') {
      const bodyModel = spec.models.find((m) => m.name === (op.requestBody as { kind: string; name: string }).name);
      if (bodyModel?.fields.some((field) => bodyParamName(field, pathParamNames) === paramName)) continue;
    }
    if ((param as any).explode === false && param.type.kind === 'array') {
      args.push(`${paramName}=["val1", "val2"]`);
    } else {
      args.push(`${paramName}=${generateQueryEncodingValue(param.type, param.name)}`);
    }
  }

  return args.join(', ');
}

function buildQueryEncodingResponseSetup(op: Operation, plan: ReturnType<typeof planOperation>): string[] {
  if (plan.isPaginated) {
    return ['httpx_mock.add_response(json={"data": [], "list_metadata": {}})'];
  }
  if (plan.isDelete) {
    return [buildDeleteSuccessResponseSetup(op)];
  }
  if (op.response.kind === 'array') {
    if (op.response.items.kind === 'model') {
      return [`httpx_mock.add_response(json=[load_fixture("${fileName(op.response.items.name)}.json")])`];
    }
    return ['httpx_mock.add_response(json=[])'];
  }
  if (plan.responseModelName) {
    return [`httpx_mock.add_response(json=load_fixture("${fileName(plan.responseModelName)}.json"))`];
  }
  return ['httpx_mock.add_response(json={})'];
}

function buildQueryEncodingAssertions(op: Operation, spec: ApiSpec): string[] {
  const assertions: string[] = [];
  const plan = planOperation(op);
  const pathParamNames = new Set(op.pathParams.map((param) => fieldName(param.name)));
  const groupedParamNames = collectGroupedParamNames(op);

  // Assert first variant's params from parameter groups
  for (const group of op.parameterGroups ?? []) {
    const variant = group.variants[0];
    for (const param of variant.parameters) {
      assertions.push(
        `assert request.url.params["${param.name}"] == ${toPythonLiteral(expectedQueryEncodingValue(param.type, param.name))}`,
      );
    }
  }

  if (plan.isPaginated) {
    assertions.push('assert request.url.params["limit"] == "10"');
    assertions.push('assert request.url.params["before"] == "cursor before"');
    assertions.push('assert request.url.params["after"] == "cursor/after"');
    const orderParam = op.queryParams.find((param) => param.name === 'order');
    if (orderParam) {
      assertions.push(
        `assert request.url.params["order"] == ${toPythonLiteral(expectedQueryEncodingValue(orderParam.type, 'order'))}`,
      );
    }
  }

  for (const param of op.queryParams) {
    if (plan.isPaginated && ['limit', 'before', 'after', 'order'].includes(param.name)) continue;
    if (groupedParamNames.has(param.name)) continue;
    // Include explode=false array params; skip other array params (complex serialization)
    if (param.type.kind === 'array' && (param as any).explode !== false) continue;
    const paramName = fieldName(param.name);
    if (pathParamNames.has(paramName)) continue;
    if (plan.hasBody && op.requestBody?.kind === 'model') {
      const bodyModel = spec.models.find(
        (model) => model.name === (op.requestBody as { kind: string; name: string }).name,
      );
      if (bodyModel?.fields.some((field) => bodyParamName(field, pathParamNames) === paramName)) continue;
    }
    if ((param as any).explode === false && param.type.kind === 'array') {
      assertions.push(`assert request.url.params["${param.name}"] == "val1,val2"`);
    } else {
      assertions.push(
        `assert request.url.params["${param.name}"] == ${toPythonLiteral(expectedQueryEncodingValue(param.type, param.name))}`,
      );
    }
  }

  return assertions;
}

/**
 * Generate a representative Python value literal for a given type, for use in tests.
 */
function generateTestValue(ref: TypeRef, name: string): string {
  switch (ref.kind) {
    case 'primitive':
      switch (ref.type) {
        case 'string':
          return `"test_${name}"`;
        case 'integer':
          return '1';
        case 'number':
          return '1.0';
        case 'boolean':
          return 'True';
        default:
          return '{}';
      }
    case 'array':
      return '[]';
    case 'enum': {
      const enumValues = (ref as any).values as (string | number)[] | undefined;
      const enumClass = className(ref.name);
      if (enumValues && enumValues.length > 0) {
        const first = enumValues[0];
        const literal = typeof first === 'string' ? `"${first}"` : String(first);
        return `${enumClass}(${literal})`;
      }
      return `${enumClass}("test")`;
    }
    case 'model':
      return `${className(ref.name)}.from_dict(load_fixture("${fileName(ref.name)}.json"))`;
    case 'nullable':
      return generateTestValue(ref.inner, name);
    case 'map':
      return '{}';
    case 'literal':
      return typeof ref.value === 'string' ? `"${ref.value}"` : String(ref.value);
    case 'union':
      if (ref.variants.length > 0) return generateTestValue(ref.variants[0], name);
      return 'None';
    default:
      return '{}';
  }
}

function generateQueryEncodingValue(ref: TypeRef, name: string): string {
  switch (ref.kind) {
    case 'primitive':
      switch (ref.type) {
        case 'string':
          return `"${expectedQueryEncodingValue(ref, name)}"`;
        case 'integer':
          return '7';
        case 'number':
          return '7.5';
        case 'boolean':
          return 'True';
        default:
          return '{}';
      }
    case 'enum': {
      const value = expectedQueryEncodingValue(ref, name);
      return `${className(ref.name)}("${value}")`;
    }
    case 'nullable':
      return generateQueryEncodingValue(ref.inner, name);
    case 'literal':
      return toPythonLiteral(ref.value);
    default:
      return generateTestValue(ref, name);
  }
}

function expectedQueryEncodingValue(ref: TypeRef, name: string): string | number {
  switch (ref.kind) {
    case 'primitive':
      switch (ref.type) {
        case 'string':
          return `value ${name}/test`;
        case 'integer':
          return 7;
        case 'number':
          return 7.5;
        case 'boolean':
          return 'true';
        default:
          return `value ${name}`;
      }
    case 'enum': {
      const enumValues = (ref as any).values as (string | number)[] | undefined;
      if (enumValues && enumValues.length > 0) return enumValues[0];
      return `value_${name}`;
    }
    case 'nullable':
      return expectedQueryEncodingValue(ref.inner, name);
    case 'literal': {
      const v = ref.value;
      if (typeof v === 'boolean') return v ? 'true' : 'false';
      return v ?? `value_${name}`;
    }
    default:
      return `value_${name}`;
  }
}

function buildMinimalModelPayload(model: Model, fixture: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const field of model.fields) {
    if (!field.required) continue;
    if (field.type.kind === 'nullable') {
      payload[field.name] = null;
      continue;
    }
    payload[field.name] = fixture[field.name];
  }
  return payload;
}

function buildPayloadWithoutOptionalNonNullableFields(
  model: Model,
  fixture: Record<string, unknown>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...fixture };
  for (const field of model.fields) {
    if (!field.required && field.type.kind !== 'nullable') {
      delete payload[field.name];
    }
  }
  return payload;
}

function buildPayloadWithNullableFieldsSetToNull(
  model: Model,
  fixture: Record<string, unknown>,
): Record<string, unknown> | null {
  const nullableFields = model.fields.filter((field) => field.type.kind === 'nullable');
  if (nullableFields.length === 0) return null;
  const payload: Record<string, unknown> = { ...fixture };
  for (const field of nullableFields) {
    payload[field.name] = null;
  }
  return payload;
}

function buildPayloadWithUnknownEnumValue(
  model: Model,
  fixture: Record<string, unknown>,
): Record<string, unknown> | null {
  const payload: Record<string, unknown> = { ...fixture };
  const enumField = model.fields.find((field) => field.type.kind === 'enum');
  if (!enumField) return null;
  payload[enumField.name] = `unexpected_${fileName(model.name)}_${fieldName(enumField.name)}`;
  return payload;
}

function toPythonLiteral(value: unknown): string {
  if (value === null) return 'None';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean')
    return JSON.stringify(value).replace('true', 'True').replace('false', 'False');
  if (Array.isArray(value)) return `[${value.map((item) => toPythonLiteral(item)).join(', ')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, inner]) => `${JSON.stringify(key)}: ${toPythonLiteral(inner)}`,
    );
    return `{${entries.join(', ')}}`;
  }
  return 'None';
}

const LEGACY_ROUNDTRIP_PATH = 'tests/test_models_round_trip.py';

/**
 * Per-service model round-trip tests (from_dict(to_dict()) == instance): one
 * file per service dir (`tests/test_<dir>_models_round_trip.py`), each covering
 * only the models emitted for that dir this run.
 *
 * `isModelInScope` is true for every model on a full run and selected-only under
 * `--services`, so a scoped run regenerates a dir's round-trip file in lockstep
 * with that dir's regenerated models — replacing the former single wholesale
 * file, which a scoped run skipped entirely and thus left asserting the OLD
 * shape of a model the same run had just regenerated (the failure this fixes).
 * Dirs with no in-scope models are skipped, so untouched services' files are
 * left byte-for-byte alone (scoped runs never prune).
 */
function generateModelRoundTripTests(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  // Collect models used as request bodies only (not returned in responses)
  const responseModelNames = new Set<string>();
  const requestOnlyModelNames = new Set<string>();
  for (const svc of spec.services) {
    for (const op of svc.operations) {
      const plan = planOperation(op);
      if (plan.responseModelName) responseModelNames.add(plan.responseModelName);
      if (op.requestBody?.kind === 'model') requestOnlyModelNames.add(op.requestBody.name);
      // Also collect union body variant models as request-only
      if (op.requestBody?.kind === 'union') {
        for (const v of (op.requestBody as any).variants ?? []) {
          if (v.kind === 'model') requestOnlyModelNames.add(v.name);
        }
      }
    }
  }
  // A model is request-only if it's used as a request body but never as a response
  for (const name of responseModelNames) requestOnlyModelNames.delete(name);

  const nonPaginatedRefs = collectNonPaginatedResponseModelNames(spec.services);
  const listMetadataNeeded = collectReferencedListMetadataModels(spec.models, nonPaginatedRefs);

  const placement = computeSchemaPlacement(spec, ctx);
  const modelToService = placement.originalModelToService;
  const roundTripDirMap = buildMountDirMap(ctx);
  const resolveDir = (irService: string | undefined) =>
    irService ? (roundTripDirMap.get(irService) ?? 'common') : 'common';

  const eligible = spec.models.filter(
    (m) =>
      !(isListWrapperModel(m) && !nonPaginatedRefs.has(m.name)) &&
      !(isListMetadataModel(m) && !listMetadataNeeded.has(m.name)) &&
      !requestOnlyModelNames.has(m.name),
  );

  // A dir's round-trip file is regenerated only when at least one of its models
  // is in scope (freshly emitted this run); on a full run that is every dir.
  // Dirs with no in-scope model are left untouched on disk, byte-for-byte.
  const activeDirs = new Set<string>();
  for (const m of eligible) {
    if (isModelInScope(m.name, ctx)) activeDirs.add(resolveDir(modelToService.get(m.name)));
  }

  // Within a regenerated dir, cover EVERY model whose fixture will exist on
  // disk after this run — in-scope (emitted now) OR out-of-scope but already
  // generated by a prior run. A scoped run leaves out-of-scope fixtures and
  // per-model files byte-for-byte on disk (never prunes); emitting only the
  // in-scope subset here would silently DELETE those out-of-scope models'
  // round-trip coverage even though everything they need is still present — the
  // regression this guards against. Gate on the fixture path: it is what
  // `load_fixture` loads (a flat, dir-independent `tests/fixtures/<name>.json`,
  // matching exactly what generateFixtures wrote/recorded), and the class
  // import resolves via the barrel, which includes the same on-disk models
  // (fileExistsAfterRun). A field-less discriminator dispatcher has no fixture,
  // so out-of-scope dispatchers stay excluded (unchanged behavior); in-scope
  // ones short-circuit true.
  const modelsByDir = new Map<string, Model[]>();
  for (const model of eligible) {
    const dir = resolveDir(modelToService.get(model.name));
    if (!activeDirs.has(dir)) continue;
    const fixturePath = `tests/fixtures/${fileName(model.name)}.json`;
    if (!fileExistsAfterRun(fixturePath, isModelInScope(model.name, ctx), ctx)) continue;
    if (!modelsByDir.has(dir)) modelsByDir.set(dir, []);
    modelsByDir.get(dir)!.push(model);
  }

  const files: GeneratedFile[] = [];
  for (const [dirName, dirModels] of [...modelsByDir].sort(([a], [b]) => a.localeCompare(b))) {
    const file = buildDirRoundTripFile(dirName, dirModels, spec, ctx, modelToService, resolveDir);
    if (file) files.push(file);
  }
  return files;
}

/** Build one service dir's round-trip test file, or null when it has no testable models. */
function buildDirRoundTripFile(
  dirName: string,
  dirModels: Model[],
  spec: ApiSpec,
  ctx: EmitterContext,
  modelToService: Map<string, string>,
  resolveDir: (irService: string | undefined) => string,
): GeneratedFile | null {
  const roundTripModels = dirModels.filter((m) => m.fields.length > 0 && !(m as any).discriminator);
  const discriminatorModels = dirModels.filter((m) => (m as any).discriminator);
  if (roundTripModels.length === 0 && discriminatorModels.length === 0) return null;

  // Imported classes grouped by their OWN dir: a discriminator's first variant
  // may live in another service's dir, so a single file can import across dirs.
  const importsByDir = new Map<string, Set<string>>();
  const addImport = (modelName: string, cls: string) => {
    const dir = resolveDir(modelToService.get(modelName));
    if (!importsByDir.has(dir)) importsByDir.set(dir, new Set());
    importsByDir.get(dir)!.add(cls);
  };

  const modelMap = new Map(spec.models.map((m) => [m.name, m]));
  const enumMap = new Map(spec.enums.map((e) => [e.name, e]));

  // Per-model method groups, kept as discrete blocks so a scoped run can freeze
  // out-of-scope models to their prior on-disk text (see reconciliation below).
  const roundTripBlocks: AggregateBlock[] = [];
  const discriminatorBlocks: AggregateBlock[] = [];
  // Scope of every key this dir CONSIDERED, whether or not it goes on to produce
  // a block below. A scoped run drops the prior block of an in-scope model that
  // produced none — its per-model `.py` WAS regenerated, so the frozen block
  // asserts a shape the fresh model can't produce (see reconcileScopedBlocks) —
  // instead of carrying the stale text over. `fileName` is normalized, so two IR
  // names can share a key; exclusivelyInScopeKeys lets an out-of-scope owner veto
  // the drop. Shared by both aggregates so a model that gains or loses a
  // discriminator (moving between the two) doesn't strand its block in the class
  // it left.
  const inScopeKeys = exclusivelyInScopeKeys(
    dirModels.map((m) => ({ key: fileName(m.name), inScope: isModelInScope(m.name, ctx) })),
  );

  {
    for (const model of roundTripModels) {
      const body: string[] = [];
      // Deduplicate fields by DOMAIN identifier (mirrors models.ts, which honors
      // `domainName`); the wire key stays `field.name`.
      const seenFieldNames = new Set<string>();
      const dedupFields = model.fields.filter((f) => {
        const pyName = domainFieldName(f);
        if (seenFieldNames.has(pyName)) return false;
        seenFieldNames.add(pyName);
        return true;
      });
      const dedupModel = { ...model, fields: dedupFields };

      const modelClass = className(model.name);
      addImport(model.name, modelClass);
      const fixtureName = `${fileName(model.name)}.json`;
      const fullFixture = generateModelFixture(dedupModel, modelMap, enumMap);
      const minimalPayload = buildMinimalModelPayload(dedupModel, fullFixture);
      const absentOptionalPayload = buildPayloadWithoutOptionalNonNullableFields(dedupModel, fullFixture);
      const nullablePayload = buildPayloadWithNullableFieldsSetToNull(dedupModel, fullFixture);
      const unknownEnumPayload = buildPayloadWithUnknownEnumValue(dedupModel, fullFixture);

      body.push(`    def test_${fileName(model.name)}_round_trip(self):`);
      body.push(`        data = load_fixture("${fixtureName}")`);
      body.push(`        instance = ${modelClass}.from_dict(data)`);
      body.push('        serialized = instance.to_dict()');
      body.push('        assert serialized == data');
      body.push(`        restored = ${modelClass}.from_dict(serialized)`);
      body.push('        assert restored.to_dict() == serialized');

      const requiredFields = dedupFields.filter((field) => field.required);
      body.push('');
      body.push(`    def test_${fileName(model.name)}_minimal_payload(self):`);
      body.push(`        data = ${toPythonLiteral(minimalPayload)}`);
      body.push(`        instance = ${modelClass}.from_dict(data)`);
      if (requiredFields.length > 0) {
        body.push('        serialized = instance.to_dict()');
        for (const field of requiredFields) {
          body.push(
            `        assert serialized[${toPythonLiteral(field.name)}] == data[${toPythonLiteral(field.name)}]`,
          );
        }
      } else {
        body.push('        assert instance.to_dict() is not None');
      }

      if (Object.keys(absentOptionalPayload).length !== Object.keys(fullFixture).length) {
        body.push('');
        body.push(`    def test_${fileName(model.name)}_omits_absent_optional_non_nullable_fields(self):`);
        body.push(`        data = ${toPythonLiteral(absentOptionalPayload)}`);
        body.push(`        instance = ${modelClass}.from_dict(data)`);
        body.push('        serialized = instance.to_dict()');
        for (const field of dedupFields.filter((field) => !field.required && field.type.kind !== 'nullable')) {
          body.push(`        assert ${toPythonLiteral(field.name)} not in serialized`);
        }
      }

      if (nullablePayload) {
        body.push('');
        body.push(`    def test_${fileName(model.name)}_preserves_nullable_fields(self):`);
        body.push(`        data = ${toPythonLiteral(nullablePayload)}`);
        body.push(`        instance = ${modelClass}.from_dict(data)`);
        body.push('        serialized = instance.to_dict()');
        for (const field of dedupFields.filter((field) => field.type.kind === 'nullable')) {
          body.push(`        assert serialized[${toPythonLiteral(field.name)}] is None`);
        }
      }

      if (unknownEnumPayload) {
        body.push('');
        body.push(`    def test_${fileName(model.name)}_round_trips_unknown_enum_values(self):`);
        body.push(`        data = ${toPythonLiteral(unknownEnumPayload)}`);
        body.push(`        instance = ${modelClass}.from_dict(data)`);
        body.push('        assert instance.to_dict() == data');
      }

      roundTripBlocks.push({
        key: fileName(model.name),
        text: body.join('\n'),
        inScope: isModelInScope(model.name, ctx),
      });
    }
  }

  {
    for (const model of discriminatorModels) {
      const body: string[] = [];
      const disc = (model as any).discriminator as {
        property: string;
        mapping: Record<string, string>;
      };
      const modelClass = className(model.name);
      const unknownClass = `${modelClass}Unknown`;

      // Pick the first variant (alphabetically by discriminator value) for tests
      const sortedEntries = Object.entries(disc.mapping).sort(([a], [b]) => a.localeCompare(b));
      if (sortedEntries.length === 0) continue;
      const [, firstVariantName] = sortedEntries[0];
      const firstVariantClass = className(firstVariantName);
      const firstVariantFixture = `${fileName(firstVariantName)}.json`;
      addImport(model.name, modelClass);
      addImport(model.name, unknownClass);
      addImport(firstVariantName, firstVariantClass);

      body.push(`    def test_${fileName(model.name)}_dispatches_known_variant(self):`);
      body.push(`        data = load_fixture("${firstVariantFixture}")`);
      body.push(`        result = ${modelClass}.from_dict(data)`);
      body.push(`        assert isinstance(result, ${firstVariantClass})`);

      body.push('');
      body.push(`    def test_${fileName(model.name)}_returns_unknown_for_unrecognized_type(self):`);
      body.push(`        data = load_fixture("${firstVariantFixture}")`);
      body.push(`        data = {**data, "${disc.property}": "future.unrecognized.type"}`);
      body.push(`        result = ${modelClass}.from_dict(data)`);
      body.push(`        assert isinstance(result, ${unknownClass})`);
      body.push('        assert result.raw_data == data');

      body.push('');
      body.push(`    def test_${fileName(model.name)}_raises_on_missing_discriminator(self):`);
      body.push(`        data = load_fixture("${firstVariantFixture}")`);
      body.push(`        data = {k: v for k, v in data.items() if k != "${disc.property}"}`);
      body.push('        with pytest.raises(Exception):');
      body.push(`            ${modelClass}.from_dict(data)`);

      body.push('');
      body.push(`    def test_${fileName(model.name)}_raises_on_none_discriminator(self):`);
      body.push(`        data = load_fixture("${firstVariantFixture}")`);
      body.push(`        data = {**data, "${disc.property}": None}`);
      body.push('        with pytest.raises(Exception):');
      body.push(`            ${modelClass}.from_dict(data)`);

      discriminatorBlocks.push({
        key: fileName(model.name),
        text: body.join('\n'),
        inScope: isModelInScope(model.name, ctx),
      });
    }
  }

  // Freeze out-of-scope models' method groups to their prior on-disk text. Their
  // per-model `.py` was NOT regenerated this run, but the payloads above are
  // synthesized from the CURRENT spec — re-rendering them would assert a shape
  // the stale model can't produce (e.g. a field the spec gained since the model
  // was last written, which `to_dict` then never emits). Only the
  // `load_fixture`-driven test would survive, and only because the fixture is
  // stale in lockstep. Freezing also keeps an unrelated same-delta change to an
  // out-of-scope model out of a scoped batch.
  const path = `tests/test_${dirName.replace(/\//g, '_')}_models_round_trip.py`;
  const scoped = isScopedRun(ctx);
  let prior: PriorRoundTripFile = {
    roundTrip: [],
    discriminator: [],
    imports: new Map(),
  };
  if (scoped) {
    try {
      prior = parsePriorRoundTripFile(readPriorFile(path, ctx));
    } catch (err) {
      // The prior file exists but is unreadable. Emitting now would reconcile
      // against an empty prior and silently drop every out-of-scope method
      // group; leave the on-disk copy untouched instead.
      console.warn(
        `[oagen] python: leaving ${path} untouched — could not read prior file: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }
  const roundTripMethods = reconcileScopedBlocks(roundTripBlocks, prior.roundTrip, scoped, inScopeKeys);
  const discriminatorMethods = reconcileScopedBlocks(discriminatorBlocks, prior.discriminator, scoped, inScopeKeys);
  if (roundTripMethods.length === 0 && discriminatorMethods.length === 0) return null;

  const body: string[] = [];
  if (roundTripMethods.length > 0) {
    body.push('', '', 'class TestModelRoundTrip:');
    for (const method of roundTripMethods) body.push('', ...method.split('\n'));
  }
  if (discriminatorMethods.length > 0) {
    body.push('', '', 'class TestDiscriminatorDispatch:');
    for (const method of discriminatorMethods) body.push('', ...method.split('\n'));
  }
  const bodyText = body.join('\n');

  // Imports: the fresh ones this run computed, plus any the prior file carried
  // (a frozen block may reference a class the current spec no longer produces).
  // Keep only symbols the reconciled body actually references, so a frozen-out
  // block never leaves behind an import of a class whose file may not exist.
  const importsByModule = new Map<string, Set<string>>();
  const addModuleImport = (module: string, symbol: string) => {
    if (!importsByModule.has(module)) importsByModule.set(module, new Set());
    importsByModule.get(module)!.add(symbol);
  };
  for (const [dir, names] of importsByDir) {
    for (const name of names) addModuleImport(`${ctx.namespace}.${dirToModule(dir)}.models`, name);
  }
  for (const [module, names] of prior.imports) {
    for (const name of names) addModuleImport(module, name);
  }

  const lines: string[] = [];
  lines.push('"""Model round-trip tests: from_dict(to_dict()) preserves data."""');
  lines.push('');
  lines.push('import pytest');
  lines.push('');
  lines.push('from tests.generated_helpers import load_fixture');
  lines.push('');
  for (const [module, names] of [...importsByModule].sort(([a], [b]) => a.localeCompare(b))) {
    const used = [...names].filter((name) => new RegExp(`\\b${name}\\b`).test(bodyText)).sort();
    if (used.length > 0) lines.push(`from ${module} import ${used.join(', ')}`);
  }

  return {
    path,
    content: [...lines, ...body].join('\n'),
    integrateTarget: true,
    overwriteExisting: true,
  };
}

interface PriorRoundTripFile {
  /** `TestModelRoundTrip` method groups, keyed by the model's snake_case file name. */
  roundTrip: AggregateBlock[];
  /** `TestDiscriminatorDispatch` method groups, keyed the same way. */
  discriminator: AggregateBlock[];
  /** `from <module> import <names>` lines, excluding the fixed test-helper imports. */
  imports: Map<string, Set<string>>;
}

/**
 * Parse a prior round-trip file into per-model method groups so a scoped run can
 * freeze out-of-scope groups verbatim.
 *
 * A group starts at its model's FIRST method — always `_round_trip` in
 * `TestModelRoundTrip` and `_dispatches_known_variant` in
 * `TestDiscriminatorDispatch`, by construction above — and runs to just before
 * the next such anchor (or the end of the class). Anchoring on the first method
 * rather than enumerating every suffix keeps the parser correct when a new
 * per-model assertion is added: it lands inside the preceding group.
 */
function parsePriorRoundTripFile(content: string | null): PriorRoundTripFile {
  const result: PriorRoundTripFile = {
    roundTrip: [],
    discriminator: [],
    imports: new Map(),
  };
  if (!content) return result;
  const lines = content.split('\n');

  for (const line of lines) {
    const imp = line.match(/^from (\S+) import (.+)$/);
    if (!imp || imp[1] === 'tests.generated_helpers') continue;
    const names = imp[2]
      .split(',')
      .map((n) => n.trim())
      .filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n));
    if (names.length === 0) continue;
    if (!result.imports.has(imp[1])) result.imports.set(imp[1], new Set());
    for (const name of names) result.imports.get(imp[1])!.add(name);
  }

  const anchors: { cls: string; re: RegExp; into: AggregateBlock[] }[] = [
    {
      cls: 'TestModelRoundTrip',
      re: /^ {4}def test_(.+)_round_trip\(self\):$/,
      into: result.roundTrip,
    },
    {
      cls: 'TestDiscriminatorDispatch',
      re: /^ {4}def test_(.+)_dispatches_known_variant\(self\):$/,
      into: result.discriminator,
    },
  ];

  for (const { cls, re, into } of anchors) {
    const start = lines.findIndex((l) => l === `class ${cls}:`);
    if (start === -1) continue;
    let end = start + 1;
    while (end < lines.length && !/^\S/.test(lines[end])) end++;

    const starts: number[] = [];
    for (let i = start + 1; i < end; i++) if (re.test(lines[i])) starts.push(i);
    for (let s = 0; s < starts.length; s++) {
      const from = starts[s];
      let to = (s + 1 < starts.length ? starts[s + 1] : end) - 1;
      while (to > from && lines[to].trim() === '') to--;
      into.push({
        key: lines[from].match(re)![1],
        text: lines.slice(from, to + 1).join('\n'),
      });
    }
  }

  return result;
}

/**
 * Retire the pre-split monolith (`tests/test_models_round_trip.py`). A full run
 * simply stops emitting it, so the engine prunes it; a scoped run never prunes,
 * so overwrite the stale (now-failing) monolith with an inert placeholder while
 * it's still on disk (recorded in the prior manifest). Gating on the prior
 * manifest means it is NOT recreated once a full run has pruned it.
 */
function retireLegacyRoundTripMonolith(ctx: EmitterContext): GeneratedFile | null {
  if (!isScopedRun(ctx)) return null;
  if (!ctx.priorTargetManifestPaths?.has(LEGACY_ROUNDTRIP_PATH)) return null;
  return {
    path: LEGACY_ROUNDTRIP_PATH,
    content:
      '"""Model round-trip tests moved to per-service ' +
      'tests/test_<service>_models_round_trip.py files.\n\n' +
      'This placeholder remains only until the next full generation prunes it."""\n',
    integrateTarget: true,
    overwriteExisting: true,
  };
}
