#!/usr/bin/env npx tsx
/**
 * iOS / Swift SDK smoke test — captures wire-level HTTP exchanges from the
 * generated Swift SDK and outputs SmokeResults JSON for diff comparison.
 *
 * Swift is compiled, so (like Go/Kotlin) the SDK is driven out-of-process:
 *   1. A local capture proxy (this process) forwards requests to the real API,
 *      recording each request/response pair. The driver points its baseURL at
 *      the proxy; the proxy injects the real Authorization header.
 *   2. Per wave, a `main.swift` driver is generated that makes literal SDK calls
 *      wrapped in stderr markers, built and run via SwiftPM (a path dependency on
 *      the generated SDK).
 *
 * Swift resource methods take flattened, ORDER-SENSITIVE named arguments, so the
 * driver reconstructs each call signature via the emitter's own
 * `collectMethodParams`/`orderMethodParams` (imported from src/ios) — guaranteeing
 * the generated calls match the generated methods exactly.
 *
 * Usage:
 *   npx tsx smoke/sdk-ios.ts --spec ../openapi-spec/spec/open-api-spec.yaml --sdk-path ./sdk
 *
 * Requires API_KEY or WORKOS_API_KEY env var.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { tmpdir } from 'node:os';
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
} from '@workos/oagen/smoke';
import type { CapturedExchange, SmokeResults, ExchangeProvenance, OperationWave } from '@workos/oagen/smoke';
import type { ApiSpec, Operation } from '@workos/oagen';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// The `.oagen-ios-smoke.json` sidecar shape (authoritative, transform-aware).
type Serialize =
  | { kind: 'string' | 'int' | 'double' | 'bool' | 'date' | 'data' | 'anycodable' | 'unsupported' }
  | { kind: 'enum'; enumType: string }
  | { kind: 'array'; element: Serialize }
  | { kind: 'map'; value: Serialize };

interface SmokePlanParam {
  label: string;
  wire: string;
  source: 'path' | 'query' | 'body' | 'bodyRaw';
  optional: boolean;
  serialize: Serialize;
}

interface SmokePlanEntry {
  service: string;
  method: string;
  params: SmokePlanParam[];
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

interface ProxyCapture {
  request: CapturedRequest;
  response: CapturedResponse;
}

// Module-scoped smoke plan (from .oagen-ios-smoke.json), initialized in main().
let smokePlan: Map<string, SmokePlanEntry> = new Map();

// ---------------------------------------------------------------------------
// Proxy server (man-in-the-middle to the real API; records exchanges)
// ---------------------------------------------------------------------------

function createProxyServer(
  apiKey: string,
  targetHost: string,
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
        const url = new URL(req.url!, 'http://localhost');
        const queryParams: Record<string, string> = {};
        url.searchParams.forEach((v, k) => {
          queryParams[k] = v;
        });

        const options = {
          hostname: targetHost,
          port: 443,
          path: req.url,
          method: req.method,
          headers: {
            ...req.headers,
            host: targetHost,
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
      const addr = server.address() as { port: number };
      resolvePromise({
        port: addr.port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Manifest loading + module detection
// ---------------------------------------------------------------------------

function loadSmokePlan(sdkPath: string): Map<string, SmokePlanEntry> {
  const planPath = resolve(sdkPath, '.oagen-ios-smoke.json');
  if (!existsSync(planPath)) {
    console.warn(`Warning: No .oagen-ios-smoke.json found at ${planPath}`);
    console.warn('  Regenerate the SDK with a current ios emitter; most operations will be skipped.');
    return new Map();
  }
  const parsed = JSON.parse(readFileSync(planPath, 'utf-8'));
  const operations = parsed?.operations;
  const plan = new Map<string, SmokePlanEntry>();
  if (operations && typeof operations === 'object') {
    for (const [httpKey, entry] of Object.entries(operations)) {
      plan.set(httpKey, entry as SmokePlanEntry);
    }
  }
  return plan;
}

/** Detect the Swift module name (SwiftPM package name) from the generated SDK. */
function detectModule(sdkPath: string): string {
  const pkgPath = resolve(sdkPath, 'Package.swift');
  if (existsSync(pkgPath)) {
    const match = readFileSync(pkgPath, 'utf-8').match(/name:\s*"([^"]+)"/);
    if (match) return match[1];
  }
  const srcDir = resolve(sdkPath, 'Sources');
  if (existsSync(srcDir)) {
    const dirs = readdirSync(srcDir).filter((d) => !d.startsWith('.'));
    if (dirs[0]) return dirs[0];
  }
  return 'WorkOS';
}

// ---------------------------------------------------------------------------
// Method resolution — manifest first, then exact-match fallback
// ---------------------------------------------------------------------------

function resolveMethod(op: Operation): MethodResolution | null {
  const entry = smokePlan.get(`${op.httpMethod.toUpperCase()} ${op.path}`);
  if (!entry) return null; // absent = URL-builder / split / unsupported op
  return { service: entry.service, method: entry.method, tier: 'manifest', confidence: 1.0 };
}

// ---------------------------------------------------------------------------
// Swift argument construction
// ---------------------------------------------------------------------------

function swiftString(value: unknown): string {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

/** Serialize a JS value to a Swift literal per the sidecar descriptor, or null. */
function serializeValue(value: unknown, s: Serialize): string | null {
  switch (s.kind) {
    case 'string':
      return swiftString(value);
    case 'int':
      if (typeof value === 'number') return String(Math.trunc(value));
      if (typeof value === 'string' && /^-?\d+$/.test(value)) return value;
      return null;
    case 'double':
      if (typeof value === 'number') return String(value);
      if (typeof value === 'string' && value !== '' && !Number.isNaN(Number(value))) return value;
      return null;
    case 'bool':
      if (typeof value === 'boolean') return String(value);
      if (value === 'true' || value === 'false') return value;
      return null;
    case 'date':
      if (value instanceof Date) return `Date(timeIntervalSince1970: ${value.getTime() / 1000})`;
      if (typeof value === 'string') {
        const ms = Date.parse(value);
        if (!Number.isNaN(ms)) return `Date(timeIntervalSince1970: ${ms / 1000})`;
      }
      return null;
    case 'data':
      return typeof value === 'string' ? `Data(${swiftString(value)}.utf8)` : null;
    case 'enum':
      if (typeof value === 'string') return `${s.enumType}(rawValue: ${swiftString(value)})`;
      if (typeof value === 'number') return `${s.enumType}(rawValue: ${value})`;
      return null;
    case 'anycodable':
      if (typeof value === 'string') return `AnyCodable(${swiftString(value)})`;
      if (typeof value === 'number' || typeof value === 'boolean') return `AnyCodable(${value})`;
      return null;
    case 'array': {
      if (!Array.isArray(value)) return null;
      const items = value.map((v) => serializeValue(v, s.element));
      if (items.some((i) => i === null)) return null;
      return `[${items.join(', ')}]`;
    }
    case 'map': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
      const entries = Object.entries(value).map(([k, v]) => {
        const lit = serializeValue(v, s.value);
        return lit === null ? null : `${swiftString(k)}: ${lit}`;
      });
      if (entries.some((e) => e === null)) return null;
      return entries.length ? `[${entries.join(', ')}]` : '[:]';
    }
    case 'unsupported':
      return null;
  }
}

function pickValue(source: Record<string, unknown>, param: SmokePlanParam): unknown {
  const label = param.label.replace(/`/g, '');
  if (label in source) return source[label];
  if (param.wire in source) return source[param.wire];
  const camel = toCamelCase(param.wire);
  if (camel in source) return source[camel];
  return undefined;
}

/** Build the ordered Swift call argument list from the sidecar plan, or a skip reason. */
function buildCallArgs(
  op: Operation,
  pathParams: Record<string, string>,
  spec: ApiSpec,
): { args: string[] } | { skip: string } {
  const entry = smokePlan.get(`${op.httpMethod.toUpperCase()} ${op.path}`);
  if (!entry) return { skip: 'not in smoke plan' };

  const payload = op.requestBody ? (generateCamelPayload(op, spec) ?? {}) : {};
  const query: Record<string, unknown> = { ...generateCamelQueryParams(op, spec) };
  if (op.pagination) query['limit'] = 1;

  const args: string[] = [];
  for (const p of entry.params) {
    if (p.source === 'bodyRaw') return { skip: 'raw request body not supported by smoke driver' };

    let value: unknown;
    if (p.source === 'path') value = pathParams[p.wire];
    else if (p.source === 'body') value = pickValue(payload as Record<string, unknown>, p);
    else value = pickValue(query, p);

    if (value === undefined || value === null) {
      if (p.optional) continue;
      return { skip: `no value for required parameter '${p.label}'` };
    }

    const literal = serializeValue(value, p.serialize);
    if (literal === null) {
      if (p.optional) continue;
      return { skip: `cannot serialize required parameter '${p.label}'` };
    }
    args.push(`${p.label}: ${literal}`);
  }
  return { args };
}

// ---------------------------------------------------------------------------
// Swift driver generation
// ---------------------------------------------------------------------------

interface PlannedCall {
  index: number;
  op: Operation;
  irService: string;
  resolution: MethodResolution;
  callArgs: string[];
}

function buildDriverSwift(port: number, module: string, calls: PlannedCall[]): string {
  const clientClass = `${module}Client`;
  const lines: string[] = [];
  lines.push('import Foundation');
  lines.push(`import ${module}`);
  lines.push('');
  lines.push('func run() async {');
  lines.push(
    `    let config = Configuration(apiKey: "api_key", baseURL: URL(string: "http://localhost:${port}")!, maxRetries: 0)`,
  );
  lines.push(`    let client = ${clientClass}(configuration: config)`);
  lines.push('    let errHandle = FileHandle.standardError');
  lines.push('    func mark(_ s: String) { errHandle.write(Data((s + "\\n").utf8)) }');
  lines.push('');

  for (const call of calls) {
    const argStr = call.callArgs.join(', ');
    lines.push(`    mark("OAGEN_CALL_START:${call.index}")`);
    lines.push('    do {');
    lines.push(`        let _ = try await client.${call.resolution.service}.${call.resolution.method}(${argStr})`);
    lines.push(`        mark("OAGEN_CALL_OK:${call.index}")`);
    lines.push('    } catch {');
    lines.push(`        mark("OAGEN_CALL_ERROR:${call.index}:\\(error)")`);
    lines.push('    }');
    lines.push(`    mark("OAGEN_CALL_END:${call.index}")`);
    lines.push('    try? await Task.sleep(nanoseconds: 50_000_000)');
    lines.push('');
  }

  lines.push('}');
  lines.push('');
  lines.push('await run()');
  return lines.join('\n');
}

function writeSwiftPackage(tmpDir: string, sdkPath: string, module: string, mainSwift: string): void {
  const srcDir = join(tmpDir, 'Sources', 'SmokeDriver');
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, 'main.swift'), mainSwift);

  const absSdk = resolve(sdkPath).replace(/\\/g, '/');
  // SwiftPM path-dependency identity is the directory basename, not the manifest name.
  const packageId = basename(absSdk);
  const pkg = `// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "SmokeDriver",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(path: "${absSdk}"),
    ],
    targets: [
        .executableTarget(
            name: "SmokeDriver",
            dependencies: [.product(name: "${module}", package: "${packageId}")]
        ),
    ],
    swiftLanguageModes: [.v5]
)
`;
  writeFileSync(join(tmpDir, 'Package.swift'), pkg);
}

// ---------------------------------------------------------------------------
// Exchange helpers
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
      sdkMethodName: `${resolution.service}.${resolution.method}`,
      captureIndex: 0,
      totalCaptures: 1,
    },
  };
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

  loadSmokeConfig(smokeConfig);

  console.log('Parsing spec...');
  const spec = await parseSpec(specPath);
  console.log(`Spec: ${spec.name} v${spec.version}`);

  const module = detectModule(sdkPath);
  console.log(`Swift module: ${module}`);

  // Authoritative, transform-aware call plan emitted alongside the SDK.
  smokePlan = loadSmokePlan(sdkPath);
  console.log(`Smoke plan: ${smokePlan.size} operations`);

  // Proxy forwards to the real API host derived from the spec base URL.
  let targetHost = 'api.workos.com';
  try {
    targetHost = new URL(spec.baseUrl).hostname || targetHost;
  } catch {
    /* keep default */
  }

  const captures: ProxyCapture[] = [];
  const proxy = await createProxyServer(apiKey, targetHost, captures);
  console.log(`Proxy listening on port ${proxy.port} -> ${targetHost}`);

  const groups = planOperations(spec);
  const ids = new IdRegistry();
  const exchanges: CapturedExchange[] = [];

  let successCount = 0;
  let errorCount = 0;
  let skipCount = 0;
  let unexpectedCount = 0;

  const tmpDir = join(tmpdir(), 'oagen-ios-smoke');
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });

  let globalCallIndex = 0;
  const waveIterator = planWaves(groups, ids, (op) => resolveMethod(op) !== null);
  let waveResult = waveIterator.next();
  let waveNumber = 0;

  try {
    while (!waveResult.done) {
      const wave: OperationWave = waveResult.value;
      waveNumber++;

      const plannedCalls: PlannedCall[] = [];
      for (const { op, irService, pathParams } of wave.calls) {
        const resolution = resolveMethod(op);
        if (!resolution) {
          exchanges.push(makeSkippedExchange(op, irService, 'Not in smoke plan (URL-builder / split op)'));
          skipCount++;
          continue;
        }
        const built = buildCallArgs(op, pathParams, spec);
        if ('skip' in built) {
          exchanges.push(makeSkippedExchange(op, irService, built.skip));
          skipCount++;
          console.log(`  SKIP ${op.name} -- ${built.skip}`);
          continue;
        }
        plannedCalls.push({ index: globalCallIndex++, op, irService, resolution, callArgs: built.args });
      }

      if (plannedCalls.length === 0) {
        waveResult = waveIterator.next();
        continue;
      }

      console.log(`\n=== Wave ${waveNumber} (${plannedCalls.length} operations) ===`);

      const mainSwift = buildDriverSwift(proxy.port, module, plannedCalls);
      writeSwiftPackage(tmpDir, sdkPath, module, mainSwift);

      const callResults = new Map<
        number,
        { captureIndexBefore: number; captureIndexAfter: number; error?: string; startTime: number; endTime: number }
      >();
      let currentCallStart = Date.now();
      let currentCapturesBefore = 0;

      try {
        await new Promise<void>((resolvePromise, rejectPromise) => {
          const child = spawn('swift', ['run', '--quiet'], {
            cwd: tmpDir,
            env: { ...process.env },
            stdio: ['pipe', 'pipe', 'pipe'],
          });

          const timeout = setTimeout(() => {
            child.kill('SIGKILL');
            rejectPromise(new Error('Swift driver timed out after 300s'));
          }, 300_000);

          let stderrBuf = '';
          child.stderr.on('data', (data: Buffer) => {
            stderrBuf += data.toString();
            const lines = stderrBuf.split('\n');
            stderrBuf = lines.pop() || '';
            for (const raw of lines) {
              const line = raw.trim();
              if (line.startsWith('OAGEN_CALL_START:')) {
                currentCallStart = Date.now();
                currentCapturesBefore = captures.length;
              } else if (line.startsWith('OAGEN_CALL_OK:')) {
                const idx = parseInt(line.slice('OAGEN_CALL_OK:'.length), 10);
                if (!callResults.has(idx)) {
                  callResults.set(idx, {
                    captureIndexBefore: currentCapturesBefore,
                    captureIndexAfter: captures.length,
                    startTime: currentCallStart,
                    endTime: Date.now(),
                  });
                }
              } else if (line.startsWith('OAGEN_CALL_ERROR:')) {
                const rest = line.slice('OAGEN_CALL_ERROR:'.length);
                const colon = rest.indexOf(':');
                const idx = parseInt(rest.slice(0, colon), 10);
                if (!callResults.has(idx)) {
                  callResults.set(idx, {
                    captureIndexBefore: currentCapturesBefore,
                    captureIndexAfter: captures.length,
                    error: rest.slice(colon + 1),
                    startTime: currentCallStart,
                    endTime: Date.now(),
                  });
                }
              } else if (line.startsWith('OAGEN_CALL_END:')) {
                const idx = parseInt(line.slice('OAGEN_CALL_END:'.length), 10);
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
        console.error(`Wave execution error: ${err instanceof Error ? err.message : String(err)}`);
      }

      await delay(200);

      for (const call of plannedCalls) {
        const { index, op, irService, resolution } = call;
        const isTopLevel = op.pathParams.length === 0;
        const result = callResults.get(index);

        if (!result) {
          exchanges.push({
            ...makeSkippedExchange(op, irService, 'Call did not execute (driver may have failed to build)'),
            outcome: 'api-error',
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
        if (result.error) exchange.error = result.error;
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

      waveResult = waveIterator.next();
    }
  } finally {
    if (existsSync(tmpDir) && !process.env.OAGEN_SMOKE_KEEP_TMP) rmSync(tmpDir, { recursive: true, force: true });
    await proxy.close();
  }

  if (waveResult.done && waveResult.value) {
    for (const unresolved of waveResult.value) {
      exchanges.push(makeSkippedExchange(unresolved.operation, unresolved.service, 'Missing path param IDs'));
      skipCount++;
    }
  }

  const results: SmokeResults = {
    source: 'sdk-ios',
    timestamp: new Date().toISOString(),
    specVersion: spec.version,
    exchanges,
  };
  const outputPath = 'smoke-results-sdk-ios.json';
  writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\nResults written to ${outputPath}`);

  console.log('\n=== Summary ===');
  console.log(`  Total:      ${exchanges.length}`);
  console.log(`  Success:    ${successCount}`);
  console.log(`  API errors: ${errorCount}`);
  console.log(`  Skipped:    ${skipCount}`);
  if (unexpectedCount > 0) console.log(`  Unexpected: ${unexpectedCount}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
