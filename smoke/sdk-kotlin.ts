#!/usr/bin/env npx tsx
/**
 * Kotlin SDK smoke test — captures wire-level HTTP exchanges from the generated
 * Kotlin SDK and outputs SmokeResults JSON for diff comparison.
 *
 * Uses wave-based planning: executes parameterless ops first, extracts IDs,
 * then plans the next wave of ops whose path params are now resolvable.
 * Each wave generates ONE batched Main.kt with all SDK calls, built and run
 * once via Gradle to eliminate per-operation cold start overhead.
 *
 * Usage:
 *   npx tsx smoke/sdk-kotlin.ts --spec ../openapi-spec/spec/open-api-spec.yaml --sdk-path ./sdk
 *
 * Requires API_KEY or WORKOS_API_KEY env var.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  parseSpec,
  planOperations,
  planWaves,
  generateCamelPayload,
  generateCamelQueryParams,
  IdRegistry,
  delay,
  parseCliArgs,
  loadSmokeConfig,
  getExpectedStatusCodes,
  isUnexpectedStatus,
  toCamelCase,
  SERVICE_PROPERTY_MAP,
} from '@workos/oagen/smoke';
import type { CapturedExchange, SmokeResults, ExchangeProvenance, OperationWave } from '@workos/oagen/smoke';
import type { Operation } from '@workos/oagen';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ManifestEntry {
  sdkMethod: string;
  service: string;
}

interface CapturedRequest {
  method: string;
  path: string;
  queryParams: Record<string, string>;
  body: unknown | null;
}

interface CapturedResponse {
  status: number;
  body: unknown | null;
}

interface MethodResolution {
  service: string;
  method: string;
  tier: ExchangeProvenance['resolutionTier'];
  confidence: number;
}

// ---------------------------------------------------------------------------
// Proxy server
// ---------------------------------------------------------------------------

interface ProxyCapture {
  request: CapturedRequest;
  response: CapturedResponse;
}

function createProxyServer(
  apiKey: string,
  captures: ProxyCapture[],
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolvePromise) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        let body: unknown = null;
        if (chunks.length > 0) {
          try {
            body = JSON.parse(Buffer.concat(chunks).toString());
          } catch {
            body = Buffer.concat(chunks).toString();
          }
        }
        const url = new URL(req.url!, `http://localhost`);
        const queryParams: Record<string, string> = {};
        url.searchParams.forEach((v, k) => {
          queryParams[k] = v;
        });

        const options = {
          hostname: 'api.workos.com',
          port: 443,
          path: req.url,
          method: req.method,
          headers: {
            ...req.headers,
            host: 'api.workos.com',
            authorization: `Bearer ${apiKey}`,
          },
        };

        const proxyReq = httpsRequest(options, (proxyRes) => {
          const resChunks: Buffer[] = [];
          proxyRes.on('data', (c: Buffer) => resChunks.push(c));
          proxyRes.on('end', () => {
            let resBody: unknown = null;
            if (resChunks.length > 0) {
              try {
                resBody = JSON.parse(Buffer.concat(resChunks).toString());
              } catch {
                resBody = Buffer.concat(resChunks).toString();
              }
            }

            captures.push({
              request: { method: req.method!, path: url.pathname, queryParams, body },
              response: { status: proxyRes.statusCode!, body: resBody },
            });

            res.writeHead(proxyRes.statusCode!, proxyRes.headers);
            res.end(Buffer.concat(resChunks));
          });
        });

        proxyReq.on('error', (err) => {
          console.error('Proxy request error:', err.message);
          captures.push({
            request: { method: req.method!, path: url.pathname, queryParams, body },
            response: { status: 502, body: { error: err.message } },
          });
          res.writeHead(502);
          res.end('Proxy error');
        });

        if (chunks.length > 0) proxyReq.write(Buffer.concat(chunks));
        proxyReq.end();
      });
    });

    server.listen(0, () => {
      const addr = server.address() as any;
      resolvePromise({
        port: addr.port,
        close: () => new Promise<void>((r) => { server.close(() => r()); }),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Manifest loading
// ---------------------------------------------------------------------------

function loadManifest(sdkPath: string): Map<string, ManifestEntry> | null {
  const manifestPath = resolve(sdkPath, 'smoke-manifest.json');
  if (!existsSync(manifestPath)) {
    console.warn(`Warning: No smoke-manifest.json found at ${manifestPath}`);
    console.warn('  Method resolution will rely on heuristic tiers — most operations may be skipped.');
    return null;
  }
  const raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const manifest = new Map<string, ManifestEntry>();
  for (const [httpKey, entry] of Object.entries(raw)) {
    manifest.set(httpKey, entry as ManifestEntry);
  }
  return manifest;
}

/**
 * Detect the main client class name from the generated SDK source.
 * Looks for a .kt file in the root package directory that contains `class XxxClient` or `class Xxx(`.
 */
function detectClientClassName(sdkPath: string): string {
  // Look for Kotlin files in src/main/kotlin/com/workos/ (root package dir)
  const rootPkgDir = join(sdkPath, 'src', 'main', 'kotlin', 'com', 'workos');
  if (!existsSync(rootPkgDir)) return 'WorkOS';
  const files = readdirSync(rootPkgDir).filter((f) => f.endsWith('.kt'));
  for (const file of files) {
    const content = readFileSync(join(rootPkgDir, file), 'utf-8');
    const match = content.match(/^class\s+(\w+)\s*\(/m);
    if (match) return match[1];
  }
  return 'WorkOS';
}

// ---------------------------------------------------------------------------
// Method resolution — 2 tiers: manifest, exact match
// ---------------------------------------------------------------------------

function resolveMethod(
  op: Operation,
  irService: string,
  manifest: Map<string, ManifestEntry> | null,
): MethodResolution | null {
  const httpKey = `${op.httpMethod.toUpperCase()} ${op.path}`;

  // Tier 0: Manifest match (primary for generated SDKs)
  if (manifest) {
    const entry = manifest.get(httpKey);
    if (entry) {
      return {
        service: entry.service,
        method: entry.sdkMethod,
        tier: 'manifest',
        confidence: 1.0,
      };
    }
  }

  // Tier 1: Exact match — IR operation name in camelCase
  const sdkProp = SERVICE_PROPERTY_MAP[irService] || toCamelCase(irService);
  const exactName = toCamelCase(op.name);
  return {
    service: sdkProp,
    method: exactName,
    tier: 'exact',
    confidence: 0.8,
  };
}

// ---------------------------------------------------------------------------
// Argument construction (for Kotlin driver code generation)
// ---------------------------------------------------------------------------

function buildKotlinArgs(
  op: Operation,
  pathParams: Record<string, string>,
  spec: any,
): { positionalArgs: string[]; bodyPayload: Record<string, unknown> | null; queryOpts: Record<string, unknown> | null } {
  const positionalArgs: string[] = [];
  let bodyPayload: Record<string, unknown> | null = null;
  let queryOpts: Record<string, unknown> | null = null;

  // Path params as positional args
  for (const p of op.pathParams) {
    positionalArgs.push(pathParams[p.name]);
  }

  // Request body (camelCase for Kotlin)
  if (op.requestBody) {
    bodyPayload = generateCamelPayload(op, spec);
  }

  // Query params (camelCase for Kotlin)
  if (!op.requestBody && op.queryParams.some((p) => p.required)) {
    const params = generateCamelQueryParams(op, spec);
    if (Object.keys(params).length > 0) {
      queryOpts = params;
    }
  }

  // Pagination
  if (op.pagination) {
    if (!queryOpts) queryOpts = {};
    queryOpts['limit'] = 1;
  }

  return { positionalArgs, bodyPayload, queryOpts };
}

// ---------------------------------------------------------------------------
// Kotlin value serialization for code generation
// ---------------------------------------------------------------------------

/**
 * Serialize a value to Kotlin code that produces a plain Kotlin object (String, Int, Map, List, etc.)
 * suitable for use in a HashMap<String, Any>.
 */
function toKotlinAnyValue(value: unknown): string {
  if (value === null || value === undefined) return '"" as Any';
  if (typeof value === 'string') return `"${value}" as Any`;
  if (typeof value === 'number') return `${value} as Any`;
  if (typeof value === 'boolean') return `${value} as Any`;
  if (Array.isArray(value)) {
    const items = value.map((v) => toKotlinAnyValue(v));
    return `listOf(${items.join(', ')}) as Any`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `"${k}" to ${toKotlinAnyValue(v)}`)
      .join(', ');
    return `hashMapOf(${entries}) as Any`;
  }
  return `"${value}" as Any`;
}

// ---------------------------------------------------------------------------
// Batched Kotlin script generation
// ---------------------------------------------------------------------------

interface PlannedCall {
  index: number;
  op: Operation;
  irService: string;
  resolution: MethodResolution;
  pathParams: Record<string, string>;
}

/**
 * Build a single Main.kt that calls ALL planned operations sequentially.
 * Each call is wrapped with stderr markers for correlation with proxy captures.
 */
function buildBatchedKotlinScript(
  port: number,
  calls: PlannedCall[],
  spec: any,
  clientClassName: string = 'WorkOS',
): string {
  const lines: string[] = [];

  // Preamble
  lines.push(`import com.workos.${clientClassName}`);
  lines.push('');
  lines.push('fun main() {');
  lines.push(`    val client = ${clientClassName}(apiKey = "api_key", baseUrl = "http://localhost:${port}")`);
  lines.push('');

  for (const call of calls) {
    const { index, op, resolution, pathParams } = call;
    const { positionalArgs, bodyPayload } = buildKotlinArgs(op, pathParams, spec);

    const argsStr = positionalArgs.map((a) => `"${a}"`).join(', ');

    let callParts: string[] = [];
    if (argsStr) {
      callParts.push(argsStr);
    }

    if (bodyPayload) {
      const bodyEntries = Object.entries(bodyPayload)
        .map(([k, v]) => `            "${k}" to ${toKotlinAnyValue(v)}`)
        .join(',\n');
      const bodyBlock = `hashMapOf(\n${bodyEntries}\n        ) as Any`;
      callParts.push(bodyBlock);
    }
    // Skip query opts for Kotlin — paginated methods have typed ListOptions
    // classes that cannot be constructed from a raw Map. SDK defaults apply.

    const callArgsStr = callParts.join(', ');

    // Marker: start
    lines.push(`    System.err.println("OAGEN_CALL_START:${index}")`);
    lines.push(`    System.err.flush()`);

    lines.push('    try {');
    lines.push(`        val result${index} = client.${resolution.service}.${resolution.method}(${callArgsStr})`);
    lines.push(`        println(result${index})`);
    lines.push(`        System.err.println("OAGEN_CALL_OK:${index}")`);
    lines.push('    } catch (e: Exception) {');
    lines.push(`        System.err.println("OAGEN_CALL_ERROR:${index}:\${e.javaClass.name}: \${e.message}")`);
    lines.push('    }');

    // Marker: end
    lines.push(`    System.err.println("OAGEN_CALL_END:${index}")`);
    lines.push(`    System.err.flush()`);

    // Small sleep to let proxy settle
    lines.push('    Thread.sleep(50)');
    lines.push('');
  }

  lines.push('}');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Gradle project generation
// ---------------------------------------------------------------------------

function writeGradleProject(tmpDir: string, sdkPath: string, mainKt: string): void {
  const srcDir = join(tmpDir, 'src', 'main', 'kotlin');
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, 'Main.kt'), mainKt);

  const sdkSrcDir = resolve(sdkPath, 'src', 'main', 'kotlin').replace(/\\/g, '/');
  const buildGradle = `plugins {
    kotlin("jvm") version "2.1.10"
    application
}

repositories {
    mavenCentral()
    mavenLocal()
}

sourceSets {
    main {
        kotlin {
            srcDir("${sdkSrcDir}")
        }
    }
}

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.fasterxml.jackson.core:jackson-databind:2.16.0")
    implementation("com.fasterxml.jackson.module:jackson-module-kotlin:2.16.0")
}

kotlin {
    jvmToolchain(19)
}

application {
    mainClass.set("MainKt")
}
`;
  writeFileSync(join(tmpDir, 'build.gradle.kts'), buildGradle);

  const settingsGradle = `rootProject.name = "smoke-driver"
`;
  writeFileSync(join(tmpDir, 'settings.gradle.kts'), settingsGradle);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { spec: specPath, sdkPath, smokeConfig } = parseCliArgs();

  if (!sdkPath) {
    console.error('--sdk-path is required');
    process.exit(1);
  }

  const apiKey = process.env.WORKOS_API_KEY || process.env.API_KEY;
  if (!apiKey) {
    console.error('API key required. Set WORKOS_API_KEY or API_KEY env var.');
    process.exit(1);
  }

  // Load config
  loadSmokeConfig(smokeConfig);

  // Parse spec
  console.log('Parsing spec...');
  const spec = await parseSpec(specPath);
  console.log(`Spec: ${spec.name} v${spec.version}`);

  // Load manifest
  const manifest = loadManifest(sdkPath);

  // Detect client class name from generated SDK
  const clientClass = detectClientClassName(sdkPath);
  console.log(`Client class: ${clientClass}`);

  // Start proxy (captures array-based)
  const captures: ProxyCapture[] = [];
  const proxy = await createProxyServer(apiKey, captures);
  console.log(`Proxy listening on port ${proxy.port}`);

  // Plan operations
  const groups = planOperations(spec);
  const ids = new IdRegistry();
  const exchanges: CapturedExchange[] = [];

  let successCount = 0;
  let errorCount = 0;
  let skipCount = 0;
  let unexpectedCount = 0;

  // Create temp directory for Kotlin driver
  const tmpDir = resolve(sdkPath, '.smoke-tmp-kotlin');

  // Use wave-based planning: execute parameterless ops first, extract IDs,
  // then plan the next wave of ops whose path params are now resolvable.
  let globalCallIndex = 0;

  const waveIterator = planWaves(groups, ids, (op, irService) => {
    const resolution = resolveMethod(op, irService, manifest);
    return resolution !== null;
  });

  let waveNumber = 0;
  let waveResult = waveIterator.next();

  try {
    while (!waveResult.done) {
      const wave: OperationWave = waveResult.value;
      waveNumber++;

      // Build planned calls for this wave, resolving methods
      const plannedCalls: PlannedCall[] = [];
      const waveSkipped: Array<{ op: Operation; irService: string; reason: string }> = [];

      for (const { op, irService, pathParams } of wave.calls) {
        const resolution = resolveMethod(op, irService, manifest);
        if (!resolution) {
          waveSkipped.push({ op, irService, reason: 'No matching SDK method' });
          continue;
        }
        plannedCalls.push({
          index: globalCallIndex++,
          op,
          irService,
          resolution,
          pathParams,
        });
      }

      // Record skipped exchanges for this wave
      for (const skip of waveSkipped) {
        exchanges.push(makeSkippedExchange(skip.op, skip.irService, skip.reason));
        skipCount++;
      }

      if (plannedCalls.length === 0) {
        waveResult = waveIterator.next();
        continue;
      }

      console.log(`\n=== Wave ${waveNumber} (${plannedCalls.length} operations) ===`);

      // Generate batched Kotlin script for this wave
      const mainKt = buildBatchedKotlinScript(
        proxy.port,
        plannedCalls,
        spec,
        clientClass,
      );

      // Write Gradle project with the batched Main.kt
      writeGradleProject(tmpDir, sdkPath, mainKt);

      // Execute the batched script using spawn for real-time stderr parsing
      const callResults = new Map<number, {
        captureIndexBefore: number;
        captureIndexAfter: number;
        error?: string;
        startTime: number;
        endTime: number;
      }>();

      let currentCallIndex = -1;
      let currentCallStart = Date.now();
      let currentCapturesBefore = 0;

      try {
        await new Promise<void>((resolvePromise, rejectPromise) => {
          const child = spawn('gradle', ['run', '--quiet'], {
            cwd: tmpDir,
            env: {
              ...process.env,
              WORKOS_API_KEY: apiKey,
              WORKOS_BASE_URL: `http://localhost:${proxy.port}`,
            },
            stdio: ['pipe', 'pipe', 'pipe'],
          });

          const timeout = setTimeout(() => {
            child.kill('SIGKILL');
            rejectPromise(new Error('Batch Kotlin script timed out after 300s'));
          }, 300_000);

          let stderrBuf = '';

          child.stderr.on('data', (data: Buffer) => {
            stderrBuf += data.toString();
            const lines = stderrBuf.split('\n');
            stderrBuf = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed.startsWith('OAGEN_CALL_START:')) {
                const idx = parseInt(trimmed.slice('OAGEN_CALL_START:'.length), 10);
                currentCallIndex = idx;
                currentCallStart = Date.now();
                currentCapturesBefore = captures.length;
              } else if (trimmed.startsWith('OAGEN_CALL_OK:')) {
                const idx = parseInt(trimmed.slice('OAGEN_CALL_OK:'.length), 10);
                if (callResults.has(idx)) continue;
                callResults.set(idx, {
                  captureIndexBefore: currentCapturesBefore,
                  captureIndexAfter: captures.length,
                  startTime: currentCallStart,
                  endTime: Date.now(),
                });
              } else if (trimmed.startsWith('OAGEN_CALL_ERROR:')) {
                const rest = trimmed.slice('OAGEN_CALL_ERROR:'.length);
                const colonIdx = rest.indexOf(':');
                const idx = parseInt(rest.slice(0, colonIdx), 10);
                const errMsg = rest.slice(colonIdx + 1);
                if (callResults.has(idx)) continue;
                callResults.set(idx, {
                  captureIndexBefore: currentCapturesBefore,
                  captureIndexAfter: captures.length,
                  error: errMsg,
                  startTime: currentCallStart,
                  endTime: Date.now(),
                });
              } else if (trimmed.startsWith('OAGEN_CALL_END:')) {
                const idx = parseInt(trimmed.slice('OAGEN_CALL_END:'.length), 10);
                const existing = callResults.get(idx);
                if (existing) {
                  existing.captureIndexAfter = captures.length;
                  existing.endTime = Date.now();
                }
              }
            }
          });

          child.on('close', () => {
            clearTimeout(timeout);
            if (stderrBuf.trim()) {
              const trimmed = stderrBuf.trim();
              if (trimmed.startsWith('OAGEN_CALL_END:') && currentCallIndex >= 0) {
                const existing = callResults.get(currentCallIndex);
                if (existing) {
                  existing.captureIndexAfter = captures.length;
                  existing.endTime = Date.now();
                }
              }
            }
            resolvePromise();
          });

          child.on('error', (err) => {
            clearTimeout(timeout);
            rejectPromise(err);
          });
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Batch execution error: ${message}`);
      }

      await delay(200);

      // Process results for this wave — extract IDs so the next wave can use them
      for (const call of plannedCalls) {
        const { index, op, irService, resolution } = call;
        const isTopLevel = op.pathParams.length === 0;
        const result = callResults.get(index);

        if (!result) {
          exchanges.push({
            ...makeSkippedExchange(op, irService, 'Call did not execute (batch script may have failed)'),
            outcome: 'api-error',
            durationMs: 0,
          });
          errorCount++;
          console.log(`  X ${op.name} -- did not execute`);
          continue;
        }

        const elapsed = result.endTime - result.startTime;

        if (result.captureIndexAfter <= result.captureIndexBefore) {
          if (result.error) {
            exchanges.push({
              ...makeSkippedExchange(op, irService, result.error),
              outcome: 'api-error',
              durationMs: elapsed,
            });
            errorCount++;
            console.log(`  X ${op.name} -- ${result.error.split('\n')[0]}`);
          } else {
            exchanges.push(makeSkippedExchange(op, irService, 'No HTTP capture'));
            skipCount++;
            console.log(`  SKIP ${op.name} -- no HTTP capture`);
          }
          continue;
        }

        const capture = captures[result.captureIndexAfter - 1];
        const exchange = buildExchange(op, irService, capture, elapsed, resolution);

        if (result.error) {
          exchange.error = result.error;
        }

        // Extract IDs from response (critical: feeds the next wave)
        ids.extractAndStore(irService, capture.response.body, isTopLevel);

        if (exchange.unexpectedStatus) {
          unexpectedCount++;
          console.log(`  ! ${op.name} -> ${capture.response.status} (unexpected)`);
        } else if (exchange.outcome === 'api-error') {
          errorCount++;
          console.log(`  X ${op.name} -> ${capture.response.status}`);
        } else {
          successCount++;
          console.log(`  OK ${op.name} -> ${capture.response.status} (${elapsed}ms)`);
        }

        exchanges.push(exchange);
      }

      // Advance to the next wave (IDs from this wave are now in the registry)
      waveResult = waveIterator.next();
    }
  } finally {
    // Cleanup temp directory
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
    await proxy.close();
  }

  // Record any operations that could never be resolved
  if (waveResult.done && waveResult.value) {
    for (const unresolved of waveResult.value) {
      exchanges.push(makeSkippedExchange(unresolved.operation, unresolved.service, 'Missing path param IDs'));
      skipCount++;
    }
  }

  // Write results
  const results: SmokeResults = {
    source: 'sdk-kotlin',
    timestamp: new Date().toISOString(),
    specVersion: spec.version,
    exchanges,
  };

  const outputPath = 'smoke-results-sdk-kotlin.json';
  writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\nResults written to ${outputPath}`);

  // Summary
  const total = exchanges.length;
  console.log(`\n=== Summary ===`);
  console.log(`  Total:      ${total}`);
  console.log(`  Success:    ${successCount}`);
  console.log(`  API errors: ${errorCount}`);
  console.log(`  Skipped:    ${skipCount}`);
  if (unexpectedCount > 0) {
    console.log(`  Unexpected: ${unexpectedCount}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSkippedExchange(op: Operation, service: string, reason: string): CapturedExchange {
  return {
    operationId: op.name,
    service,
    operationName: op.name,
    request: { method: op.httpMethod.toUpperCase(), path: op.path, queryParams: {}, body: null },
    response: { status: 0, body: null },
    outcome: 'skipped',
    error: reason,
    durationMs: 0,
  };
}

function buildExchange(
  op: Operation,
  service: string,
  capture: ProxyCapture,
  durationMs: number,
  resolution: MethodResolution,
): CapturedExchange {
  const status = capture.response.status;
  const expectedCodes = getExpectedStatusCodes(op);
  const unexpected = isUnexpectedStatus(status, op);

  return {
    operationId: op.name,
    service,
    operationName: op.name,
    request: capture.request,
    response: capture.response,
    outcome: status >= 200 && status < 300 ? 'success' : 'api-error',
    unexpectedStatus: unexpected || undefined,
    expectedStatusCodes: expectedCodes,
    durationMs,
    provenance: {
      resolutionTier: resolution.tier,
      resolutionConfidence: resolution.confidence,
      sdkMethodName: `${resolution.service}.${resolution.method}`,
      captureIndex: 0,
      totalCaptures: 1,
    },
  };
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
