/**
 * Python SDK smoke test -- captures wire-level HTTP exchanges from the generated
 * WorkOS Python SDK by routing traffic through a local HTTP proxy, then outputs
 * SmokeResults JSON for diff comparison.
 *
 * Uses a batched approach: generates ONE Python script that calls ALL operations
 * sequentially, eliminating per-operation cold start overhead.
 *
 * Usage:
 *   npx tsx smoke/sdk-python.ts --spec ../openapi-spec/spec/open-api-spec.yaml --sdk-path ./sdk-python
 *
 * Requires API_KEY or WORKOS_API_KEY env var.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { execSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
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

interface ProxyCapture {
  request: CapturedRequest;
  response: CapturedResponse;
}

// ---------------------------------------------------------------------------
// HTTP Proxy Server
// ---------------------------------------------------------------------------

function createProxyServer(
  targetHost: string,
  apiKey: string,
  captures: ProxyCapture[],
): {
  start: () => Promise<number>;
  stop: () => Promise<void>;
} {
  let server: ReturnType<typeof createServer> | null = null;

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
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

      let requestBody: unknown = null;
      if (rawBody) {
        try {
          requestBody = JSON.parse(rawBody);
        } catch {
          requestBody = rawBody;
        }
      }

      const capturedReq: CapturedRequest = { method, path, queryParams, body: requestBody };

      const forwardPath = url.pathname + url.search;
      const forwardHeaders: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'workos-python-smoke-test',
      };
      if (rawBody) {
        forwardHeaders['Content-Length'] = Buffer.byteLength(rawBody).toString();
      }

      const forwardReq = httpsRequest(
        {
          hostname: targetHost,
          port: 443,
          path: forwardPath,
          method,
          headers: forwardHeaders,
        },
        (forwardRes) => {
          const responseChunks: Buffer[] = [];
          forwardRes.on('data', (chunk: Buffer) => responseChunks.push(chunk));
          forwardRes.on('end', () => {
            const responseRaw = Buffer.concat(responseChunks).toString('utf-8');
            const status = forwardRes.statusCode || 0;

            let responseBody: unknown = null;
            try {
              responseBody = JSON.parse(responseRaw);
            } catch {
              // Not JSON
            }

            captures.push({
              request: capturedReq,
              response: { status, body: responseBody },
            });

            res.writeHead(status, forwardRes.headers);
            res.end(responseRaw);
          });
        },
      );

      forwardReq.on('error', (err) => {
        captures.push({
          request: capturedReq,
          response: { status: 0, body: null },
        });
        res.writeHead(502);
        res.end(JSON.stringify({ error: err.message }));
      });

      if (rawBody) {
        forwardReq.write(rawBody);
      }
      forwardReq.end();
    });
  };

  return {
    start: () =>
      new Promise<number>((resolve, reject) => {
        server = createServer(handler);
        server.listen(0, '127.0.0.1', () => {
          const addr = server!.address();
          if (addr && typeof addr === 'object') {
            resolve(addr.port);
          } else {
            reject(new Error('Failed to get proxy server port'));
          }
        });
        server.on('error', reject);
      }),
    stop: () =>
      new Promise<void>((resolve) => {
        if (server) {
          server.close(() => resolve());
        } else {
          resolve();
        }
      }),
  };
}

// ---------------------------------------------------------------------------
// Manifest loading
// ---------------------------------------------------------------------------

function loadManifest(sdkPath: string): Map<string, ManifestEntry> | null {
  const manifestPath = resolve(sdkPath, 'smoke-manifest.json');
  if (!existsSync(manifestPath)) {
    console.warn(`Warning: No smoke-manifest.json found at ${manifestPath}`);
    console.warn('  Method resolution will rely on heuristic tiers -- most operations may be skipped.');
    return null;
  }
  const raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const manifest = new Map<string, ManifestEntry>();
  for (const [httpKey, entry] of Object.entries(raw)) {
    manifest.set(httpKey, entry as ManifestEntry);
  }
  return manifest;
}

// ---------------------------------------------------------------------------
// Method resolution
// ---------------------------------------------------------------------------

interface MethodResolution {
  service: string;
  method: string;
  tier: ExchangeProvenance['resolutionTier'];
  confidence: number;
}

function resolveMethod(
  op: Operation,
  irService: string,
  manifest: Map<string, ManifestEntry> | null,
): MethodResolution | null {
  const httpKey = `${op.httpMethod.toUpperCase()} ${op.path}`;

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
// Python literal helper
// ---------------------------------------------------------------------------

function toPythonLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(toPythonLiteral).join(', ') + ']';
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const pairs = entries.map(([k, v]) => `${JSON.stringify(k)}: ${toPythonLiteral(v)}`);
    return '{' + pairs.join(', ') + '}';
  }
  return JSON.stringify(String(value));
}

// ---------------------------------------------------------------------------
// Batched Python script generation
// ---------------------------------------------------------------------------

interface PlannedCall {
  index: number;
  op: Operation;
  irService: string;
  resolution: MethodResolution;
  pathParams: Record<string, string>;
}

function buildBatchedPythonScript(
  sdkPath: string,
  apiKey: string,
  proxyPort: number,
  calls: PlannedCall[],
  spec: any,
): string {
  // Use src/ subdirectory if it exists, otherwise use the SDK root directly.
  // Generated SDKs use a flat layout (workos/ at root), while some hand-written
  // SDKs nest under src/.
  const srcPath = existsSync(resolve(sdkPath, 'src')) ? resolve(sdkPath, 'src') : resolve(sdkPath);
  const lines: string[] = [];

  // Preamble -- loaded once
  lines.push('import sys');
  lines.push('import json');
  lines.push('import time');
  lines.push(`sys.path.insert(0, ${JSON.stringify(srcPath)})`);
  lines.push('from workos import WorkOS');
  lines.push('');
  lines.push(`client = WorkOS(api_key=${JSON.stringify(apiKey)}, base_url="http://127.0.0.1:${proxyPort}")`);
  lines.push('');

  for (const call of calls) {
    const { index, op, resolution, pathParams } = call;

    // Marker: start
    lines.push(`sys.stderr.write("OAGEN_CALL_START:${index}\\n")`);
    lines.push(`sys.stderr.flush()`);

    // Build args -- generated Python SDK takes positional path params,
    // then `payload: dict` for POST/PUT body, or **options for query params
    const args: string[] = [];

    for (const p of op.pathParams) {
      const paramValue = pathParams[p.name];
      if (paramValue) {
        args.push(JSON.stringify(paramValue));
      }
    }

    if (op.requestBody) {
      const payload = generatePayload(op, spec);
      if (payload) {
        // Pass as a single dict (the generated SDK expects `payload: dict`)
        args.push(toPythonLiteral(payload));
      }
    }

    if (!op.requestBody && op.queryParams.some((p) => p.required)) {
      const queryOpts = generateQueryParams(op, spec);
      for (const [key, value] of Object.entries(queryOpts)) {
        args.push(`${key}=${toPythonLiteral(value)}`);
      }
    }

    if (op.pagination) {
      if (!args.some((k) => k.startsWith('limit='))) {
        args.push('limit=1');
      }
    }

    const argsStr = args.join(', ');
    lines.push('try:');
    lines.push(`    result = client.${resolution.service}.${resolution.method}(${argsStr})`);
    lines.push(`    sys.stderr.write("OAGEN_CALL_OK:${index}\\n")`);
    lines.push('except Exception as e:');
    lines.push(`    sys.stderr.write("OAGEN_CALL_ERROR:${index}:" + str(e) + "\\n")`);

    // Marker: end
    lines.push(`sys.stderr.write("OAGEN_CALL_END:${index}\\n")`);
    lines.push(`sys.stderr.flush()`);
    lines.push('time.sleep(0.05)');
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

  // Resolve python3 path
  let python3Path = 'python3';
  const candidates = ['/usr/bin/python3', '/usr/local/bin/python3', 'python3'];
  let found = false;
  for (const candidate of candidates) {
    try {
      execSync(`${candidate} -c "import httpx"`, { stdio: 'pipe' });
      python3Path = candidate;
      found = true;
      break;
    } catch {
      try {
        execSync(`${candidate} --version`, { stdio: 'pipe' });
        if (!found) {
          python3Path = candidate;
          found = true;
        }
      } catch {
        // not found
      }
    }
  }
  if (!found) {
    console.error('python3 is required but not found at common locations.');
    process.exit(1);
  }
  console.log(`Using Python: ${python3Path}`);

  // Load config
  loadSmokeConfig(smokeConfig);

  // Parse spec
  console.log('Parsing spec...');
  const spec = await parseSpec(specPath);
  console.log(`Spec: ${spec.name} v${spec.version}`);

  // Load manifest
  const manifest = loadManifest(sdkPath);

  // Start the proxy server
  const baseUrl = process.env.WORKOS_BASE_URL || spec.baseUrl;
  const targetHost = new URL(baseUrl).hostname;
  const captures: ProxyCapture[] = [];
  const proxy = createProxyServer(targetHost, apiKey, captures);
  const proxyPort = await proxy.start();
  console.log(`Proxy server listening on 127.0.0.1:${proxyPort} -> ${targetHost}`);

  // Create temp directory
  const tmpDir = join(tmpdir(), `smoke-python-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  // Plan operations
  const groups = planOperations(spec);
  const ids = new IdRegistry();
  const exchanges: CapturedExchange[] = [];

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

    // Build planned calls for this wave
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

    for (const skip of waveSkipped) {
      exchanges.push(makeSkippedExchange(skip.op, skip.irService, skip.reason));
      skipCount++;
    }

    if (plannedCalls.length === 0) {
      waveResult = waveIterator.next();
      continue;
    }

    console.log(`\n=== Wave ${waveNumber} (${plannedCalls.length} operations) ===`);

    // Generate batched Python script for this wave
    const pythonScript = buildBatchedPythonScript(sdkPath, apiKey, proxyPort, plannedCalls, spec);

    const scriptPath = join(tmpDir, `smoke_wave_${waveNumber}.py`);
    writeFileSync(scriptPath, pythonScript);

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

    let currentCapturesBefore = 0;
    let currentCallStart = Date.now();

    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const child = spawn(python3Path, [scriptPath], {
          env: {
            ...process.env,
            PYTHONPATH: existsSync(resolve(sdkPath, 'src')) ? resolve(sdkPath, 'src') : resolve(sdkPath),
            PYTHONDONTWRITEBYTECODE: '1',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
          rejectPromise(new Error('Batch Python script timed out after 300s'));
        }, 300_000);

        let stderrBuf = '';

        child.stderr.on('data', (data: Buffer) => {
          stderrBuf += data.toString();
          const lines = stderrBuf.split('\n');
          stderrBuf = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('OAGEN_CALL_START:')) {
              currentCallStart = Date.now();
              currentCapturesBefore = captures.length;
            } else if (trimmed.startsWith('OAGEN_CALL_OK:')) {
              const idx = parseInt(trimmed.slice('OAGEN_CALL_OK:'.length), 10);
              if (!callResults.has(idx)) {
                callResults.set(idx, {
                  captureIndexBefore: currentCapturesBefore,
                  captureIndexAfter: captures.length,
                  startTime: currentCallStart,
                  endTime: Date.now(),
                });
              }
            } else if (trimmed.startsWith('OAGEN_CALL_ERROR:')) {
              const rest = trimmed.slice('OAGEN_CALL_ERROR:'.length);
              const colonIdx = rest.indexOf(':');
              const idx = parseInt(rest.slice(0, colonIdx), 10);
              const errMsg = rest.slice(colonIdx + 1);
              if (!callResults.has(idx)) {
                callResults.set(idx, {
                  captureIndexBefore: currentCapturesBefore,
                  captureIndexAfter: captures.length,
                  error: errMsg,
                  startTime: currentCallStart,
                  endTime: Date.now(),
                });
              }
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
          ...makeSkippedExchange(op, irService, 'Call did not execute'),
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

  await proxy.stop();

  // Clean up
  try {
    execSync(`rm -rf ${JSON.stringify(tmpDir)}`, { stdio: 'pipe' });
  } catch {
    // Ignore
  }

  // Write results
  const results: SmokeResults = {
    source: 'sdk-python',
    timestamp: new Date().toISOString(),
    specVersion: spec.version,
    exchanges,
  };

  const outputPath = `smoke-results-sdk-python.json`;
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
