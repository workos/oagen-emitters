#!/usr/bin/env npx tsx
/**
 * Elixir SDK smoke test -- captures wire-level HTTP exchanges from the generated
 * Elixir SDK via a local proxy and outputs SmokeResults JSON for diff comparison.
 *
 * Uses a batched approach: generates ONE Elixir script (.exs) that calls ALL
 * operations sequentially per wave, eliminating per-operation cold start overhead.
 *
 * Usage:
 *   npx tsx smoke/sdk-elixir.ts --spec ../openapi-spec/spec/open-api-spec.yaml --sdk-path ./sdk
 *
 * Requires API_KEY or WORKOS_API_KEY env var.
 * Requires `elixir` to be available on $PATH.
 */

import { readFileSync, writeFileSync, existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  parseSpec,
  planOperations,
  planWaves,
  generatePayload,
  generateQueryParams,
  IdRegistry,
  delay,
  parseCliArgs,
  loadSmokeConfig,
  getExpectedStatusCodes,
  isUnexpectedStatus,
  toSnakeCase,
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

function startProxy(
  apiHost: string,
  apiKey: string,
  captures: ProxyCapture[],
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolvePromise) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];

      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf-8');
        const url = new URL(req.url || '/', `http://localhost`);
        const method = (req.method || 'GET').toUpperCase();
        const path = url.pathname;
        const queryParams: Record<string, string> = {};
        url.searchParams.forEach((v, k) => {
          queryParams[k] = v;
        });

        let reqBody: unknown = null;
        if (rawBody) {
          try {
            reqBody = JSON.parse(rawBody);
          } catch {
            reqBody = rawBody;
          }
        }

        const capturedReq: CapturedRequest = {
          method,
          path,
          queryParams,
          body: reqBody,
        };

        // Forward to real API
        const forwardHeaders: Record<string, string> = {
          authorization: `Bearer ${apiKey}`,
          'content-type': req.headers['content-type'] || 'application/json',
          'user-agent': req.headers['user-agent'] || 'workos-elixir-smoke',
        };

        if (rawBody) {
          forwardHeaders['content-length'] = Buffer.byteLength(rawBody).toString();
        }

        const forwardReq = httpsRequest(
          {
            hostname: apiHost,
            port: 443,
            path: req.url,
            method,
            headers: forwardHeaders,
          },
          (forwardRes) => {
            const respChunks: Buffer[] = [];
            forwardRes.on('data', (chunk: Buffer) => respChunks.push(chunk));
            forwardRes.on('end', () => {
              const respRaw = Buffer.concat(respChunks).toString('utf-8');
              const status = forwardRes.statusCode || 500;

              let respBody: unknown = null;
              if (respRaw) {
                try {
                  respBody = JSON.parse(respRaw);
                } catch {
                  respBody = respRaw;
                }
              }

              captures.push({
                request: capturedReq,
                response: { status, body: respBody },
              });

              // Send response back to Elixir SDK
              res.writeHead(status, {
                'content-type': forwardRes.headers['content-type'] || 'application/json',
              });
              res.end(respRaw);
            });
          },
        );

        forwardReq.on('error', (err) => {
          console.error(`Proxy forward error: ${err.message}`);
          captures.push({
            request: capturedReq,
            response: { status: 502, body: { error: err.message } },
          });
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });

        if (rawBody) {
          forwardReq.write(rawBody);
        }
        forwardReq.end();
      });
    });

    // Listen on a random port
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolvePromise({
        port,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// SDK module resolution
//
// The generated SDK has no accessor objects: resource functions live on
// modules like `WorkOS.Organizations` and take the client as their first
// argument. The manifest's `service` field is the resource file's basename
// under lib/{app}/, so the real module name (acronym casing included) comes
// from parsing that file's `defmodule` line.
// ---------------------------------------------------------------------------

interface SdkModules {
  /** OTP app name (mix.exs app / lib entry basename), e.g. "workos". */
  appName: string;
  /** Root module parsed from the entry file, e.g. "WorkOS". */
  rootModule: string;
  /** Resolve a manifest service basename to its module name, or null. */
  moduleFor: (service: string) => string | null;
}

function parseDefmodule(path: string): string | null {
  const content = readFileSync(path, 'utf-8');
  const m = content.match(/^defmodule\s+([A-Za-z0-9_.]+)\s+do/m);
  return m ? m[1] : null;
}

function resolveSdkModules(sdkPath: string): SdkModules {
  const libDir = resolve(sdkPath, 'lib');
  // Sort before picking: readdirSync order is filesystem-dependent (ext4 returns
  // inode-creation order), so a stray second lib/*.ex would otherwise make the
  // entry module -- and with it appName/rootModule -- vary by platform.
  const entryFile = readdirSync(libDir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .find((e) => e.isFile() && e.name.endsWith('.ex'));
  if (!entryFile) {
    throw new Error(`No entry module (lib/*.ex) found under ${libDir}`);
  }
  const appName = entryFile.name.replace(/\.ex$/, '');
  const rootModule = parseDefmodule(join(libDir, entryFile.name)) ?? appName;
  const cache = new Map<string, string | null>();
  return {
    appName,
    rootModule,
    moduleFor: (service: string) => {
      if (cache.has(service)) return cache.get(service)!;
      const file = join(libDir, appName, `${service}.ex`);
      const mod = existsSync(file) ? parseDefmodule(file) : null;
      cache.set(service, mod);
      return mod;
    },
  };
}

// ---------------------------------------------------------------------------
// Manifest loading
// ---------------------------------------------------------------------------

function loadManifest(sdkPath: string): Map<string, ManifestEntry> | null {
  const manifestPath = resolve(sdkPath, '.oagen-manifest.json');
  if (!existsSync(manifestPath)) {
    console.warn(`Warning: No .oagen-manifest.json found at ${manifestPath}`);
    console.warn('  Method resolution will rely on heuristic tiers -- most operations may be skipped.');
    return null;
  }
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const operations = parsed?.operations;
  if (!operations || typeof operations !== 'object') {
    console.warn('Warning: .oagen-manifest.json has no operations field');
    console.warn('  Method resolution will rely on heuristic tiers -- most operations may be skipped.');
    return null;
  }
  const manifest = new Map<string, ManifestEntry>();
  for (const [httpKey, entry] of Object.entries(operations)) {
    // Union-split operations record an array of wrapper functions (the base
    // method is never emitted). Any wrapper exercises the same endpoint, so
    // take the first one.
    const resolved = Array.isArray(entry) ? entry[0] : entry;
    if (!resolved) continue;
    manifest.set(httpKey, resolved as ManifestEntry);
  }
  return manifest;
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

  // Tier 1: Exact match — IR operation name in snake_case
  const sdkProp = SERVICE_PROPERTY_MAP[irService] || toSnakeCase(irService);
  const exactName = toSnakeCase(op.name);
  return {
    service: sdkProp,
    method: exactName,
    tier: 'exact',
    confidence: 0.8,
  };
}

// ---------------------------------------------------------------------------
// Argument construction (for Elixir driver code generation)
// ---------------------------------------------------------------------------

function buildElixirArgs(
  op: Operation,
  pathParams: Record<string, string>,
  spec: any,
): {
  positionalArgs: string[];
  bodyPayload: Record<string, unknown> | null;
  queryOpts: Record<string, unknown> | null;
} {
  const positionalArgs: string[] = [];
  let bodyPayload: Record<string, unknown> | null = null;
  let queryOpts: Record<string, unknown> | null = null;

  // Path params as positional args
  for (const p of op.pathParams) {
    positionalArgs.push(pathParams[p.name]);
  }

  // Request body
  if (op.requestBody) {
    bodyPayload = generatePayload(op, spec);
  }

  // Query params
  if (!op.requestBody && op.queryParams.some((p) => p.required)) {
    const params = generateQueryParams(op, spec);
    if (Object.keys(params).length > 0) {
      queryOpts = params as Record<string, unknown>;
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
// Elixir value serialization for code generation
// ---------------------------------------------------------------------------

/**
 * Quote a value as an Elixir string literal. `JSON.stringify` escapes
 * backslashes and quotes, but Elixir also reads `#{` as an interpolation
 * marker -- a spec-derived value containing it would compile as a variable
 * reference (or fail with a CompileError) instead of staying literal text.
 */
function elixirString(value: string): string {
  return JSON.stringify(value).replace(/#\{/g, '\\#{');
}

function toElixirValue(value: unknown, indent: number = 4): string {
  if (value === null || value === undefined) return 'nil';
  if (typeof value === 'string') return elixirString(value);
  if (typeof value === 'number') return `${value}`;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    const items = value.map((v) => toElixirValue(v, indent + 2));
    return `[${items.join(', ')}]`;
  }
  if (typeof value === 'object') {
    // String keys, verbatim — payload keys are wire names and must not be
    // renamed (the SDK's Client.request sends map keys as-is).
    const pad = ' '.repeat(indent);
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${pad}  ${elixirString(k)} => ${toElixirValue(v, indent + 2)}`)
      .join(',\n');
    return `%{\n${entries}\n${pad}}`;
  }
  return `${value}`;
}

// ---------------------------------------------------------------------------
// Batched Elixir script generation
// ---------------------------------------------------------------------------

interface PlannedCall {
  index: number;
  op: Operation;
  irService: string;
  resolution: MethodResolution;
  pathParams: Record<string, string>;
}

/**
 * Build a single Elixir script that calls ALL planned operations sequentially.
 * Each call is wrapped with stderr markers for correlation.
 */
function buildBatchedElixirScript(
  sdkPath: string,
  proxyPort: number,
  calls: PlannedCall[],
  spec: any,
  sdk: SdkModules,
): string {
  const lines: string[] = [];

  // Preamble -- loaded once
  lines.push(`# Smoke test driver -- auto-generated, do not edit`);
  lines.push(`Mix.install([`);
  lines.push(`  {:${sdk.appName}, path: ${JSON.stringify(resolve(sdkPath))}}`);
  lines.push(`])`);
  lines.push('');
  // max_retries: 0 keeps one HTTP capture per call (no retry duplicates).
  lines.push(
    `client = ${sdk.rootModule}.Client.new(api_key: "api_key", base_url: "http://127.0.0.1:${proxyPort}", max_retries: 0)`,
  );
  lines.push('');

  for (const call of calls) {
    const { index, op, resolution, pathParams } = call;

    // Build method call arguments
    const { positionalArgs, bodyPayload, queryOpts } = buildElixirArgs(op, pathParams, spec);

    const argsStr = positionalArgs.map((a) => elixirString(a)).join(', ');

    let callArgs = 'client';
    if (argsStr) {
      callArgs += `, ${argsStr}`;
    }

    // Generated functions take one `params` map: body for POST/PUT/PATCH,
    // query params for GET/DELETE/HEAD.
    if (bodyPayload) {
      callArgs += `, ${toElixirValue(bodyPayload)}`;
    } else if (queryOpts) {
      callArgs += `, ${toElixirValue(queryOpts)}`;
    }

    // main() drops calls whose service has no module before planning; assert the
    // invariant rather than interpolating a bare null, which TypeScript allows
    // and which would emit `null.method(...)` into the script.
    const elixirModule = sdk.moduleFor(resolution.service);
    if (!elixirModule) {
      throw new Error(`No SDK module for service "${resolution.service}" (operation ${op.name})`);
    }

    // Marker: start
    lines.push(`IO.write(:stderr, "OAGEN_CALL_START:${index}\\n")`);

    lines.push('try do');
    lines.push(`  case ${elixirModule}.${resolution.method}(${callArgs}) do`);
    lines.push(`    {:ok, _result} ->`);
    lines.push(`      IO.write(:stderr, "OAGEN_CALL_OK:${index}\\n")`);
    lines.push(`    {:error, reason} ->`);
    lines.push(`      IO.write(:stderr, "OAGEN_CALL_ERROR:${index}:#{inspect(reason)}\\n")`);
    lines.push('  end');
    lines.push('rescue');
    lines.push('  e ->');
    lines.push(`    IO.write(:stderr, "OAGEN_CALL_ERROR:${index}:#{inspect(e)}\\n")`);
    lines.push('end');

    // Marker: end
    lines.push(`IO.write(:stderr, "OAGEN_CALL_END:${index}\\n")`);

    // Small sleep to let proxy settle
    lines.push(':timer.sleep(50)');
    lines.push('');
  }

  return lines.join('\n');
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

  // Verify elixir is available
  try {
    execFileSync('elixir', ['--version'], { stdio: 'pipe' });
  } catch {
    console.error('Elixir is required but not found on $PATH.');
    process.exit(1);
  }

  // Load config
  loadSmokeConfig(smokeConfig);

  // Parse spec
  console.log('Parsing spec...');
  const spec = await parseSpec(specPath);
  console.log(`Spec: ${spec.name} v${spec.version}`);

  // Load manifest and resolve the SDK's actual module names
  const manifest = loadManifest(sdkPath);
  const sdk = resolveSdkModules(sdkPath);
  console.log(`SDK root module: ${sdk.rootModule} (app :${sdk.appName})`);

  const baseUrl = process.env.WORKOS_BASE_URL || spec.baseUrl;
  const apiHost = new URL(baseUrl).hostname;

  // Start proxy
  const captures: ProxyCapture[] = [];
  const proxy = await startProxy(apiHost, apiKey, captures);
  console.log(`Proxy listening on 127.0.0.1:${proxy.port}`);

  // Plan operations
  const groups = planOperations(spec);
  const ids = new IdRegistry();
  const exchanges: CapturedExchange[] = [];
  const tmpDir = mkdtempSync(join(tmpdir(), 'oagen-elixir-smoke-'));

  let successCount = 0;
  let errorCount = 0;
  let skipCount = 0;
  let unexpectedCount = 0;

  // Use wave-based planning: execute parameterless ops first, extract IDs,
  // then plan the next wave of ops whose path params are now resolvable.
  let globalCallIndex = 0;

  const waveIterator = planWaves(groups, ids, (op, irService) => {
    const resolution = resolveMethod(op, irService, manifest);
    return resolution !== null;
  });

  let waveNumber = 0;
  let waveResult = waveIterator.next();

  while (!waveResult.done) {
    const wave: OperationWave = waveResult.value;
    waveNumber++;

    // Build planned calls for this wave, resolving methods
    const plannedCalls: PlannedCall[] = [];
    const waveSkipped: Array<{
      op: Operation;
      irService: string;
      reason: string;
    }> = [];

    for (const { op, irService, pathParams } of wave.calls) {
      const resolution = resolveMethod(op, irService, manifest);
      if (!resolution) {
        waveSkipped.push({ op, irService, reason: 'No matching SDK method' });
        continue;
      }
      if (!sdk.moduleFor(resolution.service)) {
        waveSkipped.push({
          op,
          irService,
          reason: `No SDK module for service "${resolution.service}"`,
        });
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

    // Generate batched Elixir script for this wave
    const elixirScript = buildBatchedElixirScript(resolve(sdkPath), proxy.port, plannedCalls, spec, sdk);

    const scriptPath = join(tmpDir, `smoke_wave_${waveNumber}.exs`);
    writeFileSync(scriptPath, elixirScript);

    // Execute the batched script
    const callResults = new Map<
      number,
      {
        captureIndexBefore: number;
        captureIndexAfter: number;
        error?: string;
        startTime: number;
        endTime: number;
      }
    >();

    let currentCallIndex = -1;
    let currentCallStart = Date.now();
    let currentCapturesBefore = 0;

    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const child = spawn('elixir', [scriptPath], {
          env: {
            ...process.env,
            WORKOS_API_KEY: apiKey,
            WORKOS_BASE_URL: `http://127.0.0.1:${proxy.port}`,
            MIX_ENV: 'test',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
          rejectPromise(new Error('Batch Elixir script timed out after 300s'));
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

    // Process results for this wave -- extract IDs so the next wave can use them
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
        console.log(`  x ${op.name} -- did not execute`);
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
          console.log(`  x ${op.name} -- ${result.error.split('\n')[0]}`);
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
        console.log(`  x ${op.name} -> ${capture.response.status}`);
      } else {
        successCount++;
        console.log(`  ok ${op.name} -> ${capture.response.status} (${elapsed}ms)`);
      }

      exchanges.push(exchange);
    }

    // Advance to the next wave (IDs from this wave are now in the registry)
    waveResult = waveIterator.next();
  }

  // Record any operations that could never be resolved
  if (waveResult.done && waveResult.value) {
    for (const unresolved of waveResult.value) {
      exchanges.push(makeSkippedExchange(unresolved.operation, unresolved.service, 'Missing path param IDs'));
      skipCount++;
    }
  }

  await proxy.close();
  console.log('Proxy stopped.');

  // Clean up temp directory
  try {
    const { rmSync } = await import('node:fs');
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }

  // Write results
  const results: SmokeResults = {
    source: 'sdk-elixir',
    timestamp: new Date().toISOString(),
    specVersion: spec.version,
    exchanges,
  };

  const outputPath = 'smoke-results-sdk-elixir.json';
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
    request: {
      method: op.httpMethod.toUpperCase(),
      path: op.path,
      queryParams: {},
      body: null,
    },
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
