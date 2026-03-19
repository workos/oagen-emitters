/**
 * Go SDK smoke test -- captures wire-level HTTP exchanges from the generated
 * Go SDK by running a local HTTP proxy, generating a Go test program that
 * calls the SDK through it, and collecting the captured request/response pairs.
 *
 * Usage:
 *   npx tsx smoke/sdk-go.ts --spec ../openapi-spec/spec/open-api-spec.yaml --sdk-path ./sdk
 *
 * Requires API_KEY or WORKOS_API_KEY env var.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  parseSpec,
  planOperations,
  planWaves,
  generatePayload,
  IdRegistry,
  delay,
  parseCliArgs,
  loadSmokeConfig,
  getExpectedStatusCodes,
  isUnexpectedStatus,
  toSnakeCase,
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

interface ProxyExchange {
  request: CapturedRequest;
  response: CapturedResponse;
}

// ---------------------------------------------------------------------------
// Go naming conventions (mirror the emitter's naming.ts)
// ---------------------------------------------------------------------------

const GO_ACRONYMS = new Set([
  'ID',
  'URL',
  'API',
  'HTTP',
  'HTTPS',
  'JSON',
  'XML',
  'SQL',
  'HTML',
  'CSS',
  'URI',
  'SSO',
  'IP',
  'TLS',
  'SSL',
  'DNS',
  'TCP',
  'UDP',
  'SSH',
  'JWT',
  'OAuth',
  'SDK',
  'CLI',
  'MFA',
  'SAML',
  'SCIM',
  'DSYNC',
]);

function goAcronyms(name: string): string {
  return name.replace(/[A-Z][a-z]*/g, (segment) => {
    const upper = segment.toUpperCase();
    if (GO_ACRONYMS.has(upper)) return upper;
    return segment;
  });
}

function toPascalCase(s: string): string {
  return s
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

function goExportedName(name: string): string {
  return goAcronyms(toPascalCase(name));
}

function goServicePackageName(name: string): string {
  return toSnakeCase(name).replace(/_/g, '').toLowerCase();
}

function goFieldName(name: string): string {
  return goAcronyms(toPascalCase(name));
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

  // Tier 1: Exact match -- IR operation name in PascalCase (Go convention)
  const sdkProp = SERVICE_PROPERTY_MAP[irService] || toCamelCase(irService);
  const exactName = goExportedName(op.name);
  return {
    service: sdkProp,
    method: exactName,
    tier: 'exact',
    confidence: 0.8,
  };
}

// ---------------------------------------------------------------------------
// Proxy server -- captures HTTP exchanges between Go process and real API
// ---------------------------------------------------------------------------

class CaptureProxy {
  private exchanges: ProxyExchange[] = [];
  private server: ReturnType<typeof createServer> | null = null;
  private port = 0;
  private targetBaseUrl: string;

  constructor(targetBaseUrl: string) {
    this.targetBaseUrl = targetBaseUrl.replace(/\/$/, '');
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        await this.handleRequest(req, res);
      });

      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
          resolve(this.port);
        } else {
          reject(new Error('Failed to get proxy server address'));
        }
      });

      this.server.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  getExchanges(): ProxyExchange[] {
    return [...this.exchanges];
  }

  clearExchanges(): void {
    this.exchanges = [];
  }

  getLastExchange(): ProxyExchange | null {
    return this.exchanges.length > 0 ? this.exchanges[this.exchanges.length - 1] : null;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reqBody = await this.readBody(req);
    const url = new URL(req.url || '/', `http://127.0.0.1:${this.port}`);
    const method = (req.method || 'GET').toUpperCase();
    const path = url.pathname;
    const queryParams: Record<string, string> = {};
    url.searchParams.forEach((v, k) => {
      queryParams[k] = v;
    });

    let parsedReqBody: unknown = null;
    if (reqBody) {
      try {
        parsedReqBody = JSON.parse(reqBody);
      } catch {
        parsedReqBody = reqBody;
      }
    }

    const capturedReq: CapturedRequest = { method, path, queryParams, body: parsedReqBody };

    // Forward to the real API
    const targetUrl = new URL(path, this.targetBaseUrl);
    url.searchParams.forEach((v, k) => {
      targetUrl.searchParams.set(k, v);
    });

    const forwardHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (key === 'host' || key === 'connection') continue;
      if (value) {
        forwardHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
      }
    }

    try {
      const fetchInit: RequestInit = {
        method,
        headers: forwardHeaders,
      };
      if (reqBody && method !== 'GET' && method !== 'HEAD') {
        fetchInit.body = reqBody;
      }

      const response = await fetch(targetUrl.toString(), fetchInit);

      let responseBody: unknown = null;
      const responseText = await response.text();
      try {
        responseBody = JSON.parse(responseText);
      } catch {
        responseBody = responseText || null;
      }

      // Store the captured exchange
      this.exchanges.push({
        request: capturedReq,
        response: { status: response.status, body: responseBody },
      });

      // Forward response back to Go process
      const respHeaders: Record<string, string> = {};
      response.headers.forEach((v, k) => {
        // Skip transfer-encoding since we send the full body
        if (k === 'transfer-encoding') return;
        respHeaders[k] = v;
      });

      res.writeHead(response.status, respHeaders);
      res.end(responseText);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.exchanges.push({
        request: capturedReq,
        response: { status: 502, body: { error: message } },
      });
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Proxy error: ${message}` }));
    }
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      req.on('error', reject);
    });
  }
}

// ---------------------------------------------------------------------------
// Go code generation -- produces main.go that calls SDK methods via proxy
// ---------------------------------------------------------------------------

function detectModulePath(sdkPath: string): string {
  const goModPath = resolve(sdkPath, 'go.mod');
  if (existsSync(goModPath)) {
    const goMod = readFileSync(goModPath, 'utf-8');
    const match = goMod.match(/^module\s+(\S+)/m);
    if (match) return match[1];
  }
  return 'github.com/workos/workos-go/v4';
}

function generateGoImports(
  modulePath: string,
  servicePackages: Set<string>,
  needsJson: boolean,
  needsServicePkg: boolean,
): string {
  const lines: string[] = [];
  lines.push('import (');
  lines.push('\t"context"');
  if (needsJson) {
    lines.push('\t"encoding/json"');
  }
  lines.push('\t"fmt"');
  lines.push('\t"os"');
  lines.push('');
  lines.push(`\tworkos "${modulePath}/pkg"`);
  if (needsServicePkg) {
    for (const pkg of [...servicePackages].sort()) {
      lines.push(`\t"${modulePath}/pkg/${pkg}"`);
    }
  }
  lines.push(')');
  return lines.join('\n');
}

function generateGoPayloadStruct(payload: Record<string, unknown>, optsType: string, servicePackage: string): string {
  const lines: string[] = [];
  lines.push(`${servicePackage}.${optsType}{`);
  for (const [key, value] of Object.entries(payload)) {
    const goField = goFieldName(key);
    lines.push(`\t\t${goField}: ${goLiteral(value)},`);
  }
  lines.push('\t}');
  return lines.join('\n');
}

function goLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'nil';
  if (typeof value === 'string') return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return String(value);
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    if (value.length === 0) return 'nil';
    // Simple string arrays
    const items = value.map((v) => goLiteral(v)).join(', ');
    return `[]interface{}{${items}}`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const entries = Object.entries(obj);
    if (entries.length === 0) return 'map[string]interface{}{}';
    const parts = entries.map(([k, v]) => `"${k}": ${goLiteral(v)}`).join(', ');
    return `map[string]interface{}{${parts}}`;
  }
  return `"${String(value)}"`;
}

function generateGoCallBlock(
  op: Operation,
  resolution: MethodResolution,
  pathParams: Record<string, string>,
  spec: any,
  callIndex: number,
): string {
  const lines: string[] = [];
  const servicePackage = goServicePackageName(resolution.service);
  const method = resolution.method;

  // Build arguments
  const args: string[] = ['ctx'];

  // Path params (positional string args)
  for (const p of op.pathParams) {
    args.push(`"${pathParams[p.name] || ''}"`);
  }

  // Request body opts struct
  if (op.requestBody) {
    const payload = generatePayload(op, spec);
    if (payload && Object.keys(payload).length > 0) {
      const optsType = `${method}Opts`;
      args.push(generateGoPayloadStruct(payload, optsType, servicePackage));
    }
  }

  // Paginated operations: pass opts with Limit=1
  if (op.pagination && !op.requestBody) {
    const extraParams = op.queryParams.filter((p: any) => !['limit', 'before', 'after', 'order'].includes(p.name));
    if (extraParams.length > 0) {
      // Match the emitter convention: List → ListFilterOpts, others → ${method}Opts
      const optsType = method === 'List' ? 'ListFilterOpts' : `${method}Opts`;
      args.push(`${servicePackage}.${optsType}{Limit: 1}`);
    } else {
      args.push(`${servicePackage}.ListOpts{Limit: 1}`);
    }
  }

  // Determine the service accessor on the client
  const serviceProp = goExportedName(resolution.service);

  lines.push(`\t// Call ${callIndex}: ${op.httpMethod.toUpperCase()} ${op.path}`);
  lines.push(`\tfmt.Fprintf(os.Stderr, "CALL_START:${callIndex}\\n")`);

  // Determine return type: paginated and GET-with-response return (result, error),
  // DELETE returns just error
  const isDelete = op.httpMethod === 'delete';
  const hasResponse = !isDelete;

  if (hasResponse) {
    lines.push(`\tresult${callIndex}, err${callIndex} := client.${serviceProp}.${method}(${args.join(', ')})`);
    lines.push(`\tif err${callIndex} != nil {`);
    lines.push(`\t\tfmt.Fprintf(os.Stderr, "CALL_ERROR:${callIndex}:%s\\n", err${callIndex}.Error())`);
    lines.push('\t} else {');
    lines.push(`\t\tjsonResult${callIndex}, _ := json.Marshal(result${callIndex})`);
    lines.push(`\t\tfmt.Fprintf(os.Stderr, "CALL_OK:${callIndex}:%s\\n", string(jsonResult${callIndex}))`);
    lines.push('\t}');
  } else {
    lines.push(`\terr${callIndex} := client.${serviceProp}.${method}(${args.join(', ')})`);
    lines.push(`\tif err${callIndex} != nil {`);
    lines.push(`\t\tfmt.Fprintf(os.Stderr, "CALL_ERROR:${callIndex}:%s\\n", err${callIndex}.Error())`);
    lines.push('\t} else {');
    lines.push(`\t\tfmt.Fprintf(os.Stderr, "CALL_OK:${callIndex}:\\n")`);
    lines.push('\t}');
  }

  lines.push(`\tfmt.Fprintf(os.Stderr, "CALL_END:${callIndex}\\n")`);
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Planned call type for wave-based batching
// ---------------------------------------------------------------------------

interface PlannedCall {
  index: number;
  op: Operation;
  irService: string;
  resolution: MethodResolution;
  pathParams: Record<string, string>;
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

  const baseUrl = process.env.WORKOS_BASE_URL || spec.baseUrl;

  // Start capture proxy
  const proxy = new CaptureProxy(baseUrl);
  const proxyPort = await proxy.start();
  console.log(`Proxy started on port ${proxyPort}`);

  // Plan operations
  const groups = planOperations(spec);
  const ids = new IdRegistry();
  const exchanges: CapturedExchange[] = [];
  const delayMs = Number(process.env.SMOKE_DELAY_MS) || 200;

  let successCount = 0;
  let errorCount = 0;
  let skipCount = 0;
  let unexpectedCount = 0;

  // Temp directory for Go compilation — one main.go per wave
  const tmpDir = resolve(sdkPath, '.smoke-tmp');
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });

  // Detect Go module path from SDK
  const modulePath = detectModulePath(sdkPath);

  // Write go.mod for the temp module that references the local SDK.
  // The pseudo-version must match the major version suffix in the module path
  // (e.g. /v4 requires v4.x.x).
  const majorMatch = modulePath.match(/\/v(\d+)$/);
  const pseudoVersion = majorMatch ? `v${majorMatch[1]}.0.0` : 'v0.0.0';
  const tmpGoMod = [
    'module smoke-test-go',
    '',
    'go 1.21',
    '',
    `require ${modulePath} ${pseudoVersion}`,
    '',
    `replace ${modulePath} => ${resolve(sdkPath)}`,
  ].join('\n');
  writeFileSync(resolve(tmpDir, 'go.mod'), tmpGoMod);
  writeFileSync(resolve(tmpDir, 'go.sum'), '');

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

      // Collect all service packages and determine if json import is needed
      const servicePackages = new Set<string>();
      let needsJson = false;
      let needsServicePkg = false;

      for (const call of plannedCalls) {
        servicePackages.add(goServicePackageName(call.resolution.service));
        if (call.op.httpMethod !== 'delete') needsJson = true;
        if (call.op.requestBody || call.op.pagination) needsServicePkg = true;
      }

      // Generate all call blocks for this wave
      const callBlocks: string[] = [];
      for (const call of plannedCalls) {
        callBlocks.push(generateGoCallBlock(call.op, call.resolution, call.pathParams, spec, call.index));
      }

      const imports = generateGoImports(modulePath, servicePackages, needsJson, needsServicePkg);

      const goSource = [
        'package main',
        '',
        imports,
        '',
        'func main() {',
        `\tclient := workos.NewClient("${apiKey}", workos.WithEndpoint("http://127.0.0.1:${proxyPort}"))`,
        '\tctx := context.Background()',
        '',
        ...callBlocks,
        '}',
      ].join('\n');

      const mainGoPath = resolve(tmpDir, 'main.go');
      writeFileSync(mainGoPath, goSource);

      // Clear proxy exchanges before running this wave
      proxy.clearExchanges();
      const waveStart = Date.now();

      // Step 1: Build (sync — no proxy needed during compilation)
      let buildError: string | null = null;
      try {
        execSync('go build -o smoke-driver main.go', {
          cwd: tmpDir,
          timeout: 120_000,
          env: { ...process.env, GOPATH: process.env.GOPATH || resolve(process.env.HOME || '~', 'go') },
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err: any) {
        const stderr = typeof err.stderr === 'string' ? err.stderr : '';
        buildError = stderr.trim().split('\n').slice(0, 5).join(' ') || 'go build failed';
      }

      if (buildError) {
        // Build failure affects entire wave
        const elapsed = Date.now() - waveStart;
        for (const call of plannedCalls) {
          exchanges.push({
            ...makeSkippedExchange(call.op, call.irService, buildError),
            outcome: 'api-error',
            durationMs: elapsed,
          });
          errorCount++;
          console.log(`  X ${call.op.name} -- ${buildError}`);
        }
        waveResult = waveIterator.next();
        continue;
      }

      // Step 2: Run (async — proxy needs the event loop to handle HTTP)
      // Track per-call captures using stderr markers
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

      let currentCallStart = Date.now();
      let currentCapturesBefore = 0;

      try {
        await new Promise<void>((resolveRun, rejectRun) => {
          const child = spawn(resolve(tmpDir, 'smoke-driver'), [], {
            cwd: tmpDir,
            env: process.env,
          });

          let stderrBuf = '';

          child.stderr.on('data', (data: Buffer) => {
            stderrBuf += data.toString();
            const lines = stderrBuf.split('\n');
            stderrBuf = lines.pop() || '';

            const proxyExchanges = proxy.getExchanges();

            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed.startsWith('CALL_START:')) {
                currentCallStart = Date.now();
                currentCapturesBefore = proxyExchanges.length;
              } else if (trimmed.startsWith('CALL_OK:')) {
                const rest = trimmed.slice('CALL_OK:'.length);
                const colonIdx = rest.indexOf(':');
                const idx = parseInt(rest.slice(0, colonIdx), 10);
                if (callResults.has(idx)) continue;
                callResults.set(idx, {
                  captureIndexBefore: currentCapturesBefore,
                  captureIndexAfter: proxy.getExchanges().length,
                  startTime: currentCallStart,
                  endTime: Date.now(),
                });
              } else if (trimmed.startsWith('CALL_ERROR:')) {
                const rest = trimmed.slice('CALL_ERROR:'.length);
                const colonIdx = rest.indexOf(':');
                const idx = parseInt(rest.slice(0, colonIdx), 10);
                const errMsg = rest.slice(colonIdx + 1);
                if (callResults.has(idx)) continue;
                callResults.set(idx, {
                  captureIndexBefore: currentCapturesBefore,
                  captureIndexAfter: proxy.getExchanges().length,
                  error: errMsg,
                  startTime: currentCallStart,
                  endTime: Date.now(),
                });
              } else if (trimmed.startsWith('CALL_END:')) {
                const idx = parseInt(trimmed.slice('CALL_END:'.length), 10);
                const existing = callResults.get(idx);
                if (existing) {
                  existing.captureIndexAfter = proxy.getExchanges().length;
                  existing.endTime = Date.now();
                }
              }
            }
          });

          const timeout = setTimeout(() => {
            child.kill('SIGKILL');
            rejectRun(new Error('Go binary timed out after 60s'));
          }, 60_000);

          child.on('close', () => {
            clearTimeout(timeout);
            // Process any remaining stderr
            if (stderrBuf.trim()) {
              const trimmed = stderrBuf.trim();
              const proxyExchanges = proxy.getExchanges();
              if (trimmed.startsWith('CALL_END:')) {
                const idx = parseInt(trimmed.slice('CALL_END:'.length), 10);
                const existing = callResults.get(idx);
                if (existing) {
                  existing.captureIndexAfter = proxyExchanges.length;
                  existing.endTime = Date.now();
                }
              }
            }
            resolveRun();
          });

          child.on('error', (err) => {
            clearTimeout(timeout);
            rejectRun(err);
          });
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Wave ${waveNumber} execution error: ${message}`);
      }

      await delay(delayMs);

      // Process results for this wave — extract IDs so the next wave can use them
      const proxyExchanges = proxy.getExchanges();

      for (const call of plannedCalls) {
        const { index, op, irService, resolution } = call;
        const isTopLevel = op.pathParams.length === 0;
        const result = callResults.get(index);

        if (!result) {
          exchanges.push({
            ...makeSkippedExchange(op, irService, 'Call did not execute (binary may have failed)'),
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

        const captured = proxyExchanges[result.captureIndexAfter - 1];
        const exchange = buildExchange(op, irService, captured, elapsed, resolution);

        if (result.error) {
          exchange.error = result.error;
        }

        // Extract IDs from response (critical: feeds the next wave)
        ids.extractAndStore(irService, captured.response.body, isTopLevel);

        if (exchange.unexpectedStatus) {
          unexpectedCount++;
          console.log(`  ! ${op.name} -> ${captured.response.status} (unexpected)`);
        } else if (exchange.outcome === 'api-error') {
          errorCount++;
          console.log(`  X ${op.name} -> ${captured.response.status}`);
        } else {
          successCount++;
          console.log(`  OK ${op.name} -> ${captured.response.status} (${elapsed}ms)`);
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
  } finally {
    await proxy.stop();
    // Clean up temp directory
    try {
      rmSync(tmpDir, { recursive: true });
    } catch {
      // best effort
    }
  }

  // Write results
  const results: SmokeResults = {
    source: 'sdk-go',
    timestamp: new Date().toISOString(),
    specVersion: spec.version,
    exchanges,
  };

  const outputPath = 'smoke-results-sdk-go.json';
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
  capture: ProxyExchange,
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
