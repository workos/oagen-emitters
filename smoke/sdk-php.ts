/**
 * PHP SDK smoke test -- captures wire-level HTTP exchanges from the generated
 * WorkOS PHP SDK via a local HTTP proxy and outputs SmokeResults JSON for diff
 * comparison.
 *
 * Uses a batched approach: generates ONE PHP script that calls ALL operations
 * sequentially, eliminating per-operation cold start overhead. Uses `spawn`
 * (async) so the proxy event loop can process requests concurrently.
 *
 * Usage:
 *   npx tsx smoke/sdk-php.ts --spec ../openapi-spec/spec/open-api-spec.yaml --sdk-path ./sdk
 *
 * Requires API_KEY or WORKOS_API_KEY env var and `php` on $PATH.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
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

interface ProxyCapture {
  request: CapturedRequest;
  response: CapturedResponse;
}

// ---------------------------------------------------------------------------
// HTTP Proxy
// ---------------------------------------------------------------------------

class CaptureProxy {
  private server: ReturnType<typeof createServer> | null = null;
  port = 0;
  captures: ProxyCapture[] = [];

  constructor(
    private targetBaseUrl: string,
    private apiKey: string,
  ) {}

  async start(): Promise<number> {
    return new Promise((resolvePort) => {
      this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        await this.handleRequest(req, res);
      });

      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address();
        this.port = typeof addr === 'object' && addr ? addr.port : 0;
        resolvePort(this.port);
      });
    });
  }

  stop(): void {
    this.server?.close();
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const rawBody = Buffer.concat(chunks).toString('utf-8');

    const inUrl = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
    const method = (req.method ?? 'GET').toUpperCase();
    const path = inUrl.pathname;
    const queryParams: Record<string, string> = {};
    inUrl.searchParams.forEach((v, k) => {
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

    const targetUrl = new URL(path, this.targetBaseUrl);
    inUrl.searchParams.forEach((v, k) => targetUrl.searchParams.set(k, v));

    const forwardHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      'User-Agent': 'workos-php-smoke/1.0',
    };

    const fetchInit: RequestInit = { method, headers: forwardHeaders };
    if (rawBody && method !== 'GET' && method !== 'HEAD') {
      fetchInit.body = rawBody;
    }

    let responseStatus = 502;
    let responseBody: unknown = null;
    let responseRaw = '';

    try {
      const upstream = await fetch(targetUrl.toString(), fetchInit);
      responseStatus = upstream.status;
      responseRaw = await upstream.text();
      try {
        responseBody = JSON.parse(responseRaw);
      } catch {
        responseBody = responseRaw || null;
      }
    } catch (err) {
      responseStatus = 502;
      const message = err instanceof Error ? err.message : String(err);
      responseBody = { error: message };
      responseRaw = JSON.stringify(responseBody);
    }

    this.captures.push({
      request: { method, path, queryParams, body: requestBody },
      response: { status: responseStatus, body: responseBody },
    });

    res.writeHead(responseStatus, { 'Content-Type': 'application/json' });
    res.end(responseRaw);
  }
}

// ---------------------------------------------------------------------------
// Manifest loading
// ---------------------------------------------------------------------------

function loadManifest(sdkPath: string): Map<string, ManifestEntry> | null {
  const manifestPath = resolve(sdkPath, 'smoke-manifest.json');
  if (!existsSync(manifestPath)) {
    console.warn(`Warning: No smoke-manifest.json found at ${manifestPath}`);
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
  service: string; // camelCase accessor on client (e.g., "organizations")
  method: string; // camelCase method name (e.g., "get")
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
      return { service: entry.service, method: entry.sdkMethod, tier: 'manifest', confidence: 1.0 };
    }
  }

  const sdkProp = SERVICE_PROPERTY_MAP[irService] || toCamelCase(irService);
  return { service: sdkProp, method: toCamelCase(op.name), tier: 'exact', confidence: 0.8 };
}

// ---------------------------------------------------------------------------
// PHP literal helpers
// ---------------------------------------------------------------------------

function phpArrayLiteral(obj: unknown): string {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj === 'boolean') return obj ? 'true' : 'false';
  if (typeof obj === 'number') return String(obj);
  if (typeof obj === 'string') return `'${escapePhpString(obj)}'`;
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    return `[${obj.map((item) => phpArrayLiteral(item)).join(', ')}]`;
  }
  if (typeof obj === 'object') {
    const entries = Object.entries(obj);
    if (entries.length === 0) return '[]';
    return `[${entries.map(([k, v]) => `'${escapePhpString(k)}' => ${phpArrayLiteral(v)}`).join(', ')}]`;
  }
  return String(obj);
}

function escapePhpString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// ---------------------------------------------------------------------------
// Batched PHP script generation
// ---------------------------------------------------------------------------

interface PlannedCall {
  index: number;
  op: Operation;
  irService: string;
  resolution: MethodResolution;
  pathParams: Record<string, string>;
}

function buildBatchedPhpScript(
  sdkPath: string,
  namespace: string,
  apiKey: string,
  proxyPort: number,
  calls: PlannedCall[],
  spec: any,
): string {
  const lines: string[] = [];
  lines.push('<?php');
  lines.push('');

  // Autoloader
  const autoloadPath = resolve(sdkPath, 'vendor/autoload.php').replace(/\\/g, '/');
  const libPath = resolve(sdkPath, 'lib').replace(/\\/g, '/');

  if (existsSync(autoloadPath)) {
    lines.push(`require_once '${autoloadPath}';`);
  } else {
    lines.push(`spl_autoload_register(function ($class) {`);
    lines.push(`    $prefix = '${namespace}\\\\';`);
    lines.push(`    $baseDir = '${libPath}/${namespace}/';`);
    lines.push(`    $len = strlen($prefix);`);
    lines.push(`    if (strncmp($prefix, $class, $len) !== 0) { return; }`);
    lines.push(`    $relativeClass = substr($class, $len);`);
    lines.push(`    $file = $baseDir . str_replace('\\\\', '/', $relativeClass) . '.php';`);
    lines.push(`    if (file_exists($file)) { require $file; }`);
    lines.push(`});`);
  }
  lines.push('');

  // Configure SDK — generated SDK uses instance-based client with Guzzle handler
  lines.push(`use GuzzleHttp\\HandlerStack;`);
  lines.push(`use GuzzleHttp\\Handler\\CurlHandler;`);
  lines.push('');
  lines.push(`$client = new ${namespace}\\${namespace}(`);
  lines.push(`    apiKey: '${escapePhpString(apiKey)}',`);
  lines.push(`    baseUrl: 'http://127.0.0.1:${proxyPort}',`);
  lines.push(');');
  lines.push('');

  for (const call of calls) {
    const { index, op, resolution, pathParams } = call;

    // Marker: start
    lines.push(`fwrite(STDERR, "OAGEN_CALL_START:${index}\\n");`);

    // Build arguments — generated PHP SDK takes positional path params,
    // then named keyword args for body fields and query params
    const phpArgs: string[] = [];

    for (const p of op.pathParams) {
      const value = pathParams[p.name] ?? '';
      phpArgs.push(`'${escapePhpString(value)}'`);
    }

    if (op.requestBody) {
      const payload = generatePayload(op, spec);
      if (payload && typeof payload === 'object') {
        // Pass as named arguments (the generated SDK uses promoted properties)
        for (const [key, value] of Object.entries(payload)) {
          phpArgs.push(`${toCamelCase(key)}: ${phpArrayLiteral(value)}`);
        }
      }
    }

    if (!op.requestBody && op.queryParams.some((p) => p.required)) {
      const queryOpts = generateQueryParams(op, spec);
      for (const [key, value] of Object.entries(queryOpts)) {
        phpArgs.push(`${toCamelCase(key)}: ${phpArrayLiteral(value)}`);
      }
    }

    if (op.pagination) {
      if (!phpArgs.some((a) => a.startsWith('limit:'))) {
        phpArgs.push('limit: 1');
      }
    }

    // The generated SDK uses $client->resource()->method(...) pattern
    const serviceAccessor = resolution.service;
    lines.push('try {');
    lines.push(`    $result = $client->${serviceAccessor}()->${resolution.method}(${phpArgs.join(', ')});`);
    lines.push(`    fwrite(STDERR, "OAGEN_CALL_OK:${index}\\n");`);
    lines.push('} catch (\\Throwable $e) {');
    lines.push(`    fwrite(STDERR, "OAGEN_CALL_ERROR:${index}:" . $e->getMessage() . "\\n");`);
    lines.push('}');
    lines.push(`fwrite(STDERR, "OAGEN_CALL_END:${index}\\n");`);
    lines.push('usleep(50000);'); // 50ms
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

  try {
    execSync('php --version', { stdio: 'pipe' });
  } catch {
    console.error('PHP is not available on $PATH.');
    process.exit(1);
  }

  loadSmokeConfig(smokeConfig);

  console.log('Parsing spec...');
  const spec = await parseSpec(specPath);
  console.log(`Spec: ${spec.name} v${spec.version}`);

  const manifest = loadManifest(sdkPath);

  // Detect PHP namespace
  const namespace = detectNamespace(sdkPath);
  console.log(`PHP namespace: ${namespace}`);

  const baseUrl = process.env.WORKOS_BASE_URL || spec.baseUrl;
  const proxy = new CaptureProxy(baseUrl, apiKey);
  const proxyPort = await proxy.start();
  console.log(`Proxy on 127.0.0.1:${proxyPort}`);

  const tmpDir = join(resolve(sdkPath), '.smoke-tmp');
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

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

    // Generate batched PHP script for this wave
    const phpScript = buildBatchedPhpScript(resolve(sdkPath), namespace, apiKey, proxyPort, plannedCalls, spec);

    const scriptPath = join(tmpDir, `smoke_wave_${waveNumber}.php`);
    writeFileSync(scriptPath, phpScript, 'utf-8');

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
        const child = spawn('php', [scriptPath], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
          rejectPromise(new Error('Batch PHP script timed out after 300s'));
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
              currentCapturesBefore = proxy.captures.length;
            } else if (trimmed.startsWith('OAGEN_CALL_OK:')) {
              const idx = parseInt(trimmed.slice('OAGEN_CALL_OK:'.length), 10);
              if (!callResults.has(idx)) {
                callResults.set(idx, {
                  captureIndexBefore: currentCapturesBefore,
                  captureIndexAfter: proxy.captures.length,
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
                  captureIndexAfter: proxy.captures.length,
                  error: errMsg,
                  startTime: currentCallStart,
                  endTime: Date.now(),
                });
              }
            } else if (trimmed.startsWith('OAGEN_CALL_END:')) {
              const idx = parseInt(trimmed.slice('OAGEN_CALL_END:'.length), 10);
              const existing = callResults.get(idx);
              if (existing) {
                existing.captureIndexAfter = proxy.captures.length;
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
      console.error(`Batch error: ${err instanceof Error ? err.message : String(err)}`);
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

      const capture = proxy.captures[result.captureIndexAfter - 1];
      const exchange = buildExchange(op, irService, capture, elapsed, resolution);
      if (result.error) exchange.error = result.error;

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

  proxy.stop();

  // Cleanup
  try {
    const { rmSync } = await import('node:fs');
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Ignore
  }

  // Write results
  const results: SmokeResults = {
    source: 'sdk-php',
    timestamp: new Date().toISOString(),
    specVersion: spec.version,
    exchanges,
  };

  writeFileSync('smoke-results-sdk-php.json', JSON.stringify(results, null, 2));
  console.log(`\nResults written to smoke-results-sdk-php.json`);

  console.log(`\n=== Summary ===`);
  console.log(`  Total:      ${exchanges.length}`);
  console.log(`  Success:    ${successCount}`);
  console.log(`  API errors: ${errorCount}`);
  console.log(`  Skipped:    ${skipCount}`);
  if (unexpectedCount > 0) console.log(`  Unexpected: ${unexpectedCount}`);
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
  return {
    operationId: op.name,
    service,
    operationName: op.name,
    request: capture.request,
    response: capture.response,
    outcome: status >= 200 && status < 300 ? 'success' : 'api-error',
    unexpectedStatus: isUnexpectedStatus(status, op) || undefined,
    expectedStatusCodes: getExpectedStatusCodes(op),
    durationMs,
    provenance: {
      resolutionTier: resolution.tier,
      resolutionConfidence: resolution.confidence,
      sdkMethodName: `${resolution.service}->${resolution.method}`,
      captureIndex: 0,
      totalCaptures: 1,
    },
  };
}

function detectNamespace(sdkPath: string): string {
  const composerPath = resolve(sdkPath, 'composer.json');
  if (existsSync(composerPath)) {
    try {
      const composer = JSON.parse(readFileSync(composerPath, 'utf-8'));
      const psr4 = composer?.autoload?.['psr-4'];
      if (psr4) {
        const firstKey = Object.keys(psr4)[0];
        if (firstKey) return firstKey.replace(/\\+$/, '');
      }
    } catch {
      // Fall through
    }
  }
  return 'workos';
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
