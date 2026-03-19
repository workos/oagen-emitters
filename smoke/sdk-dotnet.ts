#!/usr/bin/env npx tsx
/**
 * .NET SDK smoke test — captures wire-level HTTP exchanges from the generated
 * .NET SDK and outputs SmokeResults JSON for diff comparison.
 *
 * Usage:
 *   npx tsx smoke/sdk-dotnet.ts --spec ../openapi-spec/spec/open-api-spec.yaml --sdk-path ./sdk
 *
 * Requires API_KEY or WORKOS_API_KEY env var.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execSync, spawn } from 'node:child_process';
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

function createProxyServer(apiKey: string, captures: ProxyCapture[]): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
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
          res.writeHead(502);
          res.end('Proxy error');
        });

        if (chunks.length > 0) proxyReq.write(Buffer.concat(chunks));
        proxyReq.end();
      });
    });

    server.listen(0, () => {
      const addr = server.address() as any;
      resolve({ port: addr.port, close: () => server.close() });
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

// ---------------------------------------------------------------------------
// Method resolution — 2 tiers: manifest, exact match
// ---------------------------------------------------------------------------

/**
 * Convert a camelCase or snake_case name to PascalCase for .NET conventions.
 */
function toPascalCase(name: string): string {
  const camel = toCamelCase(name);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
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

  // Tier 1: Exact match — IR operation name in PascalCase + Async suffix
  const sdkProp = SERVICE_PROPERTY_MAP[irService] || toPascalCase(irService);
  const exactName = toPascalCase(op.name) + 'Async';
  return {
    service: sdkProp,
    method: exactName,
    tier: 'exact',
    confidence: 0.8,
  };
}

// ---------------------------------------------------------------------------
// Argument construction (for .NET driver code generation)
// ---------------------------------------------------------------------------

function buildDotnetArgs(
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

  // Request body (camelCase — will be converted to PascalCase in C# generation)
  if (op.requestBody) {
    bodyPayload = generateCamelPayload(op, spec);
  }

  // Query params (camelCase — will be converted to PascalCase in C# generation)
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
// C# value serialization for code generation
// ---------------------------------------------------------------------------

function toCSharpValue(value: unknown, indent: number = 12): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return `"${value}"`;
  if (typeof value === 'number') return Number.isInteger(value) ? `${value}` : `${value}m`;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    const pad = ' '.repeat(indent);
    const items = value.map((v) => `${pad}    ${toCSharpValue(v, indent + 4)}`);
    return `new List<object>\n${pad}{\n${items.join(',\n')}\n${pad}}`;
  }
  if (typeof value === 'object') {
    const pad = ' '.repeat(indent);
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${pad}    { "${k}", ${toCSharpValue(v, indent + 4)} }`)
      .join(',\n');
    return `new Dictionary<string, object>\n${pad}{\n${entries}\n${pad}}`;
  }
  return `${value}`;
}

function toCSharpObjectInitializer(obj: Record<string, unknown>, indent: number = 12): string {
  return toCSharpValue(obj, indent);
}

// ---------------------------------------------------------------------------
// Batched C# source generation
// ---------------------------------------------------------------------------

interface PlannedCall {
  index: number;
  op: Operation;
  irService: string;
  resolution: MethodResolution;
  pathParams: Record<string, string>;
}

/**
 * Build a single Program.cs that calls ALL planned operations sequentially.
 * Each call is wrapped with stderr markers for correlation with proxy captures.
 */
function buildBatchedCSharpScript(port: number, ns: string, calls: PlannedCall[], spec: any): string {
  const lines: string[] = [];

  // Preamble — loaded once
  lines.push('using System;');
  lines.push('using System.Net.Http;');
  lines.push('using System.Net.Http.Headers;');
  lines.push('using System.Text;');
  lines.push('using System.Threading.Tasks;');
  lines.push('using Newtonsoft.Json;');
  lines.push(`using ${ns};`);
  lines.push('');

  // Shared HttpClient for body operations
  lines.push('var httpClient = new HttpClient();');
  lines.push(`httpClient.BaseAddress = new Uri("http://localhost:${port}");`);
  lines.push('httpClient.Timeout = TimeSpan.FromSeconds(30);');
  lines.push('httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", "api_key");');
  lines.push('httpClient.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));');
  lines.push('httpClient.DefaultRequestHeaders.ExpectContinue = false;');
  lines.push('');

  // Shared SDK client for GET/DELETE operations
  lines.push(`var client = new ${ns}Client(apiKey: "api_key", baseUrl: "http://localhost:${port}");`);
  lines.push('');

  for (const call of calls) {
    const { index, op, resolution, pathParams } = call;
    const { positionalArgs, bodyPayload, queryOpts } = buildDotnetArgs(op, pathParams, spec);

    // Marker: start
    lines.push(`Console.Error.WriteLine("OAGEN_CALL_START:${index}");`);
    lines.push('Console.Error.Flush();');

    lines.push('try');
    lines.push('{');

    if (bodyPayload) {
      // For body operations (POST/PUT/PATCH), use HttpClient directly
      const payloadJson = JSON.stringify(bodyPayload).replace(/\\/g, '\\\\').replace(/"/g, '""');

      let urlPath = op.path;
      for (let i = 0; i < op.pathParams.length; i++) {
        urlPath = urlPath.replace(`{${op.pathParams[i].name}}`, positionalArgs[i] ?? 'test_id');
      }

      const httpMethod = op.httpMethod.toUpperCase();

      lines.push(`    var payloadJson_${index} = @"${payloadJson}";`);
      lines.push(
        `    var content_${index} = new StringContent(payloadJson_${index}, Encoding.UTF8, "application/json");`,
      );

      if (httpMethod === 'POST') {
        lines.push(`    var response_${index} = await httpClient.PostAsync("${urlPath}", content_${index});`);
      } else if (httpMethod === 'PUT') {
        lines.push(`    var response_${index} = await httpClient.PutAsync("${urlPath}", content_${index});`);
      } else if (httpMethod === 'PATCH') {
        lines.push(
          `    var request_${index} = new HttpRequestMessage(new HttpMethod("PATCH"), "${urlPath}") { Content = content_${index} };`,
        );
        lines.push(`    var response_${index} = await httpClient.SendAsync(request_${index});`);
      } else {
        lines.push(`    var response_${index} = await httpClient.PostAsync("${urlPath}", content_${index});`);
      }

      lines.push(`    var responseBody_${index} = await response_${index}.Content.ReadAsStringAsync();`);
      lines.push(`    Console.WriteLine(responseBody_${index});`);
    } else {
      // For GET/DELETE/list operations, call the SDK directly
      const argsStr = positionalArgs.map((a) => `"${a}"`).join(', ');
      let callParts: string[] = [];
      if (argsStr) {
        callParts.push(argsStr);
      }
      if (queryOpts) {
        callParts.push(toCSharpObjectInitializer(queryOpts));
      }
      const callArgsStr = callParts.join(', ');

      lines.push(`    var result_${index} = await client.${resolution.service}.${resolution.method}(${callArgsStr});`);
      lines.push(`    Console.WriteLine(JsonConvert.SerializeObject(result_${index}, Formatting.Indented));`);
    }

    lines.push(`    Console.Error.WriteLine("OAGEN_CALL_OK:${index}");`);
    lines.push('}');
    lines.push('catch (Exception ex)');
    lines.push('{');
    lines.push(`    Console.Error.WriteLine($"OAGEN_CALL_ERROR:${index}:{{ex.GetType().Name}}: {{ex.Message}}");`);
    lines.push('}');

    // Marker: end
    lines.push(`Console.Error.WriteLine("OAGEN_CALL_END:${index}");`);
    lines.push('Console.Error.Flush();');

    // Small delay to let proxy settle
    lines.push('await Task.Delay(50);');
    lines.push('');
  }

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// .NET project discovery
// ---------------------------------------------------------------------------

/**
 * Find the .csproj file in the SDK directory. Returns the full resolved path.
 */
function findCsproj(sdkPath: string): string {
  const files = readdirSync(sdkPath).filter((f) => f.endsWith('.csproj'));
  if (files.length === 0) {
    throw new Error(`No .csproj file found in ${sdkPath}`);
  }
  return resolve(sdkPath, files[0]);
}

/**
 * Detect the root namespace from the .csproj file's RootNamespace property.
 * Falls back to the csproj filename (without extension) if not found.
 */
function detectNamespace(sdkPath: string): string {
  const csprojPath = findCsproj(sdkPath);
  const content = readFileSync(csprojPath, 'utf-8');
  const match = content.match(/<RootNamespace>([^<]+)<\/RootNamespace>/);
  if (match) return match[1];
  // Fallback: use .csproj filename without extension
  const base = csprojPath.split('/').pop() ?? '';
  return base.replace('.csproj', '');
}

// ---------------------------------------------------------------------------
// .NET project generation
// ---------------------------------------------------------------------------

function writeDotnetProject(tmpDir: string, _sdkPath: string, programCs: string): void {
  writeFileSync(join(tmpDir, 'Program.cs'), programCs);
}

// ---------------------------------------------------------------------------
// Spawn-based wave execution
// ---------------------------------------------------------------------------

/**
 * Run `dotnet run` for a wave via `spawn` so stderr markers can be parsed
 * in real-time and the proxy event loop stays responsive.
 */
function runDotnetWave(
  tmpDir: string,
  apiKey: string,
  proxyPort: number,
  captures: ProxyCapture[],
): Promise<
  Map<
    number,
    {
      captureIndexBefore: number;
      captureIndexAfter: number;
      error?: string;
      startTime: number;
      endTime: number;
    }
  >
> {
  return new Promise((resolvePromise, rejectPromise) => {
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

    const child = spawn('dotnet', ['run', '--no-restore'], {
      cwd: tmpDir,
      env: {
        ...process.env,
        WORKOS_API_KEY: apiKey,
        WORKOS_BASE_URL: `http://localhost:${proxyPort}`,
        DOTNET_NOLOGO: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      rejectPromise(new Error('Batch dotnet script timed out after 300s'));
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
      // Process any remaining stderr buffer
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
      resolvePromise(callResults);
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      rejectPromise(err);
    });
  });
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

  // Detect SDK namespace
  const ns = detectNamespace(sdkPath);
  console.log(`SDK namespace: ${ns}`);

  // Load manifest
  const manifest = loadManifest(sdkPath);

  // Start proxy
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

  // Create temp directory for .NET driver (clean any stale state)
  const tmpDir = resolve(sdkPath, '.smoke-tmp-dotnet');
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  // Step 1: Build the SDK project to a DLL
  const sdkCsprojPath = findCsproj(sdkPath);
  console.log('Building SDK...');
  try {
    execSync(`dotnet build "${sdkCsprojPath}" -c Release -o "${resolve(sdkPath, 'bin/Release/net8.0')}"`, {
      cwd: sdkPath,
      timeout: 120000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, DOTNET_NOLOGO: '1' },
    });
    console.log('SDK built successfully');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to build SDK: ${msg}`);
    process.exit(1);
  }

  // Find the SDK DLL
  const sdkDllDir = resolve(sdkPath, 'bin/Release/net8.0');
  const sdkDll = resolve(sdkDllDir, `${ns}.dll`);

  // Step 2: Bootstrap the driver project referencing the built DLL
  mkdirSync(tmpDir, { recursive: true });
  const csprojPath = join(tmpDir, 'SmokeDriver.csproj');
  const csprojContent = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <Reference Include="${ns}">
      <HintPath>${sdkDll}</HintPath>
    </Reference>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
  </ItemGroup>
</Project>
`;
  writeFileSync(csprojPath, csprojContent);
  writeFileSync(join(tmpDir, 'Program.cs'), 'Console.WriteLine("bootstrap");');

  // Build the driver once to warm up
  try {
    execSync('dotnet build', {
      cwd: tmpDir,
      timeout: 120000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, DOTNET_NOLOGO: '1' },
    });
    console.log('Driver project bootstrapped');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to build driver: ${msg}`);
    process.exit(1);
  }

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

      // Generate batched C# script for this wave
      const programCs = buildBatchedCSharpScript(proxy.port, ns, plannedCalls, spec);

      writeDotnetProject(tmpDir, sdkPath, programCs);

      // Execute the batched script via spawn
      let callResults: Map<
        number,
        {
          captureIndexBefore: number;
          captureIndexAfter: number;
          error?: string;
          startTime: number;
          endTime: number;
        }
      >;

      try {
        callResults = await runDotnetWave(tmpDir, apiKey, proxy.port, captures);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Batch execution error: ${message}`);
        callResults = new Map();
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
    proxy.close();
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
    source: 'sdk-dotnet',
    timestamp: new Date().toISOString(),
    specVersion: spec.version,
    exchanges,
  };

  const outputPath = 'smoke-results-sdk-dotnet.json';
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
