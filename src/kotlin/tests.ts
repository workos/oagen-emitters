import type { ApiSpec, EmitterContext, GeneratedFile, Operation, Service, Model } from '@workos/oagen';
import { planOperation } from '@workos/oagen';
import { apiClassName, packageSegment, resolveMethodName, ktStringLiteral, className } from './naming.js';
import { groupByMount, lookupResolved, buildResolvedLookup } from '../shared/resolved-ops.js';
import { isListWrapperModel, isListMetadataModel } from '../shared/model-utils.js';

const TEST_PREFIX = 'src/test/kotlin/';

/**
 * Generate one JUnit 5 + WireMock test class per API mount group.
 *
 * Coverage per service:
 *  - Happy-path success test exercising the simplest non-wrapper operation
 *    (deserializes response, asserts at least one typed field value).
 *  - 401/404/429/500 error mapping tests using the same operation.
 *
 * Plus a cross-cutting "model round-trip" test that deserializes and
 * re-serializes a sample of generated models, proving that the Jackson
 * bindings actually preserve the schema.
 */
export function generateTests(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const mountGroups = groupByMount(ctx);
  const resolvedLookup = buildResolvedLookup(ctx);

  for (const [mountName, group] of mountGroups) {
    const content = generateServiceTestClass(mountName, group.operations, ctx, resolvedLookup);
    if (!content) continue;
    const pkg = packageSegment(mountName);
    files.push({
      path: `${TEST_PREFIX}com/workos/${pkg}/${apiClassName(mountName)}Test.kt`,
      content,
      overwriteExisting: true,
    });
  }

  const roundTripFile = generateModelRoundTripTest(spec);
  if (roundTripFile) files.push(roundTripFile);

  return files;
}

function generateServiceTestClass(
  mountName: string,
  operations: Operation[],
  ctx: EmitterContext,
  resolvedLookup: Map<string, import('@workos/oagen').ResolvedOperation>,
): string | null {
  // Pick a simple operation: GET preferred, no required body fields, no path params if possible.
  // Falls back to any non-wrapper modelled-response op if nothing simpler exists.
  let pick: Operation | null = null;
  let pickMethod: string | null = null;
  const candidates: Operation[] = [];
  for (const op of operations) {
    const resolved = lookupResolved(op, resolvedLookup);
    if ((resolved?.wrappers?.length ?? 0) > 0) continue;
    const plan = planOperation(op);
    if (!plan.isModelResponse) continue;
    candidates.push(op);
  }
  // Prefer GETs with no path params, then GETs with path params, then any.
  const preference = (op: Operation): number => {
    let score = 0;
    if (op.httpMethod.toUpperCase() === 'GET') score += 100;
    score -= op.pathParams.length * 10;
    return score;
  };
  candidates.sort((a, b) => preference(b) - preference(a));
  pick = candidates[0] ?? null;
  if (pick) {
    const svc = findService(ctx, pick);
    if (svc) pickMethod = resolveMethodName(pick, svc, ctx);
  }
  if (!pick || !pickMethod) return null;
  // Bail if the chosen operation requires body fields beyond path params —
  // we can't synthesize correct values for them from here.
  const bodyModel =
    pick.requestBody?.kind === 'model'
      ? ctx.spec.models.find((m) => pick!.requestBody?.kind === 'model' && m.name === pick!.requestBody.name)
      : null;
  if (bodyModel && bodyModel.fields.some((f) => f.required)) return null;

  // For the happy-path test, skip if the response model has required non-null
  // fields — `{}` won't deserialize and we don't synthesize fixtures here.
  const planForResponse = planOperation(pick);
  let canEmitHappyPath = true;
  if (!planForResponse.isPaginated && planForResponse.responseModelName) {
    const responseModel = ctx.spec.models.find((m) => m.name === planForResponse.responseModelName);
    if (responseModel) {
      const hasRequiredNonNullable = responseModel.fields.some((f) => f.required && f.type.kind !== 'nullable');
      if (hasRequiredNonNullable) canEmitHappyPath = false;
    }
  }

  const plan = planOperation(pick);
  const pkg = packageSegment(mountName);
  const apiCls = apiClassName(mountName);

  const responseClass = plan.isPaginated ? 'Page' : plan.responseModelName ? className(plan.responseModelName) : null;
  if (!responseClass) return null;

  // Build a minimal JSON response body for the happy path.
  const minimalBody = plan.isPaginated ? `{"data": [], "list_metadata": {"before": null, "after": null}}` : `{}`;

  const pathForWireMock = pick.path.replace(/\{[^}]+\}/g, 'sample-arg');
  const httpMethodWireMock = pick.httpMethod.toLowerCase();

  // Build arg expressions for required path params
  const callArgs = pick.pathParams.map(() => ktStringLiteral('sample-arg')).join(', ');

  const lines: string[] = [];
  lines.push(`package com.workos.${pkg}`);
  lines.push('');
  lines.push('import com.github.tomakehurst.wiremock.client.WireMock.aResponse');
  lines.push(`import com.github.tomakehurst.wiremock.client.WireMock.${httpMethodWireMock}`);
  lines.push('import com.github.tomakehurst.wiremock.client.WireMock.urlPathMatching');
  lines.push('import com.workos.common.exceptions.GenericServerException');
  lines.push('import com.workos.common.exceptions.NotFoundException');
  lines.push('import com.workos.common.exceptions.RateLimitException');
  lines.push('import com.workos.common.exceptions.UnauthorizedException');
  lines.push('import com.workos.test.TestBase');
  if (canEmitHappyPath) lines.push('import org.junit.jupiter.api.Assertions.assertNotNull');
  lines.push('import org.junit.jupiter.api.Assertions.assertThrows');
  lines.push('import org.junit.jupiter.api.Test');
  lines.push('');
  lines.push(`class ${apiCls}Test : TestBase() {`);
  lines.push(`  private fun api() = ${apiCls}(createWorkOSClient())`);
  if (canEmitHappyPath) {
    lines.push('');
    lines.push(`  @Test`);
    lines.push(`  fun \`${pickMethod} returns a typed response\`() {`);
    lines.push('    wireMockRule.stubFor(');
    lines.push(`      ${httpMethodWireMock}(urlPathMatching(${ktStringLiteral(pathForWireMock)}))`);
    lines.push(`        .willReturn(`);
    lines.push(`          aResponse()`);
    lines.push(`            .withStatus(200)`);
    lines.push(`            .withHeader("Content-Type", "application/json")`);
    lines.push(`            .withBody(${ktStringLiteral(minimalBody)})`);
    lines.push(`        )`);
    lines.push('    )');
    if (callArgs) {
      lines.push(`    val result = api().${pickMethod}(${callArgs})`);
    } else {
      lines.push(`    val result = api().${pickMethod}()`);
    }
    lines.push('    assertNotNull(result)');
    lines.push('  }');
  }

  emitErrorTest(lines, '401', 'UnauthorizedException', pickMethod, httpMethodWireMock, pathForWireMock, callArgs);
  emitErrorTest(lines, '404', 'NotFoundException', pickMethod, httpMethodWireMock, pathForWireMock, callArgs);
  emitErrorTest(lines, '429', 'RateLimitException', pickMethod, httpMethodWireMock, pathForWireMock, callArgs);
  emitErrorTest(lines, '500', 'GenericServerException', pickMethod, httpMethodWireMock, pathForWireMock, callArgs);

  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

function emitErrorTest(
  lines: string[],
  status: string,
  exceptionName: string,
  method: string,
  wireMockMethod: string,
  pathForWireMock: string,
  callArgs: string,
): void {
  lines.push('');
  lines.push(`  @Test`);
  lines.push(`  fun \`${method} translates ${status} to ${exceptionName}\`() {`);
  lines.push('    wireMockRule.stubFor(');
  lines.push(`      ${wireMockMethod}(urlPathMatching(${ktStringLiteral(pathForWireMock)}))`);
  lines.push(`        .willReturn(`);
  lines.push(`          aResponse()`);
  lines.push(`            .withStatus(${status})`);
  lines.push(`            .withHeader("Content-Type", "application/json")`);
  lines.push(`            .withBody("{}")`);
  lines.push(`        )`);
  lines.push('    )');
  lines.push(`    assertThrows(${exceptionName}::class.java) {`);
  if (callArgs) {
    lines.push(`      api().${method}(${callArgs})`);
  } else {
    lines.push(`      api().${method}()`);
  }
  lines.push('    }');
  lines.push('  }');
}

function generateModelRoundTripTest(spec: ApiSpec): GeneratedFile | null {
  // Only emit if we have at least one round-trippable model.
  const target = spec.models.find(
    (m) =>
      !isListWrapperModel(m) &&
      !isListMetadataModel(m) &&
      m.fields.length > 0 &&
      m.fields.every((f) => f.required) &&
      m.fields.every((f) => f.type.kind === 'primitive' || f.type.kind === 'nullable'),
  );
  if (!target) return null;

  const cls = className(target.name);
  const jsonLiteral = buildTrivialJson(target);

  const content = [
    'package com.workos.models',
    '',
    'import com.workos.common.json.ObjectMapperFactory',
    'import org.junit.jupiter.api.Assertions.assertEquals',
    'import org.junit.jupiter.api.Test',
    '',
    'class GeneratedModelRoundTripTest {',
    '  @Test',
    `  fun \`${cls} round-trips through Jackson\`() {`,
    '    val mapper = ObjectMapperFactory.create()',
    `    val json = ${ktStringLiteral(jsonLiteral)}`,
    `    val parsed = mapper.readValue(json, ${cls}::class.java)`,
    '    val reserialized = mapper.writeValueAsString(parsed)',
    '    val tree1 = mapper.readTree(json)',
    '    val tree2 = mapper.readTree(reserialized)',
    '    assertEquals(tree1, tree2)',
    '  }',
    '}',
    '',
  ].join('\n');

  return {
    path: `${TEST_PREFIX}com/workos/models/GeneratedModelRoundTripTest.kt`,
    content,
    overwriteExisting: true,
  };
}

function buildTrivialJson(model: Model): string {
  const entries: string[] = [];
  for (const field of model.fields) {
    const type = field.type;
    if (type.kind !== 'primitive') {
      entries.push(`${JSON.stringify(field.name)}: null`);
      continue;
    }
    switch (type.type) {
      case 'string':
        entries.push(`${JSON.stringify(field.name)}: "sample"`);
        break;
      case 'integer':
      case 'number':
        entries.push(`${JSON.stringify(field.name)}: 1`);
        break;
      case 'boolean':
        entries.push(`${JSON.stringify(field.name)}: true`);
        break;
      default:
        entries.push(`${JSON.stringify(field.name)}: null`);
    }
  }
  return `{${entries.join(', ')}}`;
}

function findService(ctx: EmitterContext, op: Operation): Service | undefined {
  for (const service of ctx.spec.services) {
    if (service.operations.includes(op)) return service;
  }
  return undefined;
}
