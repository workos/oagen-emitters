/**
 * Node SDK smoke test — captures wire-level HTTP exchanges from the generated
 * WorkOS Node SDK and outputs SmokeResults JSON for diff comparison.
 *
 * Usage:
 *   npx tsx smoke/sdk-node.ts --spec ../openapi-spec/spec/open-api-spec.yaml --sdk-path ./sdk
 *
 * Requires API_KEY or WORKOS_API_KEY env var.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseSpec,
  planOperations,
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
} from "@workos/oagen/smoke";
import type { CapturedExchange, SmokeResults, ExchangeProvenance } from "@workos/oagen/smoke";
import type { Operation } from "@workos/oagen";

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

// ---------------------------------------------------------------------------
// HTTP Interception
// ---------------------------------------------------------------------------

let currentCapture: { request: CapturedRequest; response: CapturedResponse } | null = null;
const originalFetch = globalThis.fetch;

function interceptFetch(): void {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;
    const queryParams: Record<string, string> = {};
    url.searchParams.forEach((v, k) => {
      queryParams[k] = v;
    });

    let body: unknown = null;
    if (init?.body) {
      try {
        body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
      } catch {
        body = init.body;
      }
    }

    const capturedReq: CapturedRequest = { method, path, queryParams, body };

    const response = await originalFetch(input, init);
    const cloned = response.clone();

    let responseBody: unknown = null;
    try {
      responseBody = await cloned.json();
    } catch {
      // Not JSON — that's fine
    }

    currentCapture = {
      request: capturedReq,
      response: { status: response.status, body: responseBody },
    };

    return response;
  };
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

// ---------------------------------------------------------------------------
// Manifest loading
// ---------------------------------------------------------------------------

function loadManifest(sdkPath: string): Map<string, ManifestEntry> | null {
  const manifestPath = resolve(sdkPath, "smoke-manifest.json");
  if (!existsSync(manifestPath)) {
    console.warn(`⚠ No smoke-manifest.json found at ${manifestPath}`);
    console.warn(
      "  Method resolution will rely on heuristic tiers — most operations may be skipped.",
    );
    return null;
  }
  const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
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
  tier: ExchangeProvenance["resolutionTier"];
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
        tier: "manifest",
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
    tier: "exact",
    confidence: 0.8,
  };
}

// ---------------------------------------------------------------------------
// Argument construction
// ---------------------------------------------------------------------------

function buildArgs(op: Operation, pathParams: Record<string, string>, spec: any): unknown[] {
  const args: unknown[] = [];

  // Positional path params
  if (op.pathParams.length > 0) {
    if (
      op.pathParams.length === 1 &&
      !op.requestBody &&
      op.queryParams.filter((p) => p.required).length === 0
    ) {
      // Simple case: single path param, no body/query → positional arg
      args.push(pathParams[op.pathParams[0].name]);
    } else {
      // Multiple path params → individual positional args
      for (const p of op.pathParams) {
        args.push(pathParams[p.name]);
      }
    }
  }

  // Request body
  if (op.requestBody) {
    const payload = generateCamelPayload(op, spec);
    if (payload) args.push(payload);
  }

  // Query params (for non-paginated GETs with required query params)
  if (!op.requestBody && op.queryParams.some((p) => p.required)) {
    const queryOpts = generateCamelQueryParams(op, spec);
    if (Object.keys(queryOpts).length > 0) args.push(queryOpts);
  }

  // Paginated operations may pass options
  if (op.pagination && args.length === 0) {
    args.push({ limit: 1 });
  } else if (op.pagination && !op.requestBody) {
    // If we already have path param args but it's paginated, merge limit
    const lastArg = args[args.length - 1];
    if (typeof lastArg === "object" && lastArg !== null) {
      (lastArg as Record<string, unknown>)["limit"] = 1;
    } else {
      args.push({ limit: 1 });
    }
  }

  // Idempotent POST: append empty options for idempotency key slot
  if (op.injectIdempotencyKey && op.httpMethod === "post") {
    args.push({});
  }

  return args;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { spec: specPath, sdkPath, smokeConfig } = parseCliArgs();

  if (!sdkPath) {
    console.error("--sdk-path is required");
    process.exit(1);
  }

  const apiKey = process.env.WORKOS_API_KEY || process.env.API_KEY;
  if (!apiKey) {
    console.error("API key required. Set WORKOS_API_KEY or API_KEY env var.");
    process.exit(1);
  }

  // Load config
  loadSmokeConfig(smokeConfig);

  // Parse spec
  console.log("Parsing spec...");
  const spec = await parseSpec(specPath);
  console.log(`Spec: ${spec.name} v${spec.version}`);

  // Load manifest
  const manifest = loadManifest(sdkPath);

  // Import SDK dynamically from the sdk-path
  const sdkEntryPoint = resolve(sdkPath, "src/index.ts");
  const sdkModule = await import(sdkEntryPoint);
  const WorkOS = sdkModule.WorkOS || sdkModule.default?.WorkOS;

  if (!WorkOS) {
    console.error(`Could not find WorkOS class in ${sdkEntryPoint}`);
    process.exit(1);
  }

  const baseUrl = process.env.WORKOS_BASE_URL || spec.baseUrl;
  const client = new WorkOS({ apiKey, apiHostname: new URL(baseUrl).hostname });

  // Plan operations
  const groups = planOperations(spec);
  const ids = new IdRegistry();
  const exchanges: CapturedExchange[] = [];
  const createdEntities: Array<{ service: string; id: string; deleteFn?: () => Promise<void> }> =
    [];
  const delayMs = Number(process.env.SMOKE_DELAY_MS) || 200;

  let successCount = 0;
  let errorCount = 0;
  let skipCount = 0;
  let unexpectedCount = 0;

  interceptFetch();

  try {
    for (const group of groups) {
      console.log(`\n--- ${group.service} (${group.operations.length} operations) ---`);

      for (const planned of group.operations) {
        const { operation: op, service: irService } = planned;
        const isTopLevel = op.pathParams.length === 0;

        // Resolve SDK method
        const resolution = resolveMethod(op, irService, manifest);
        if (!resolution) {
          console.log(`  SKIP ${op.name} — no matching SDK method`);
          exchanges.push(makeSkippedExchange(op, irService, "No matching SDK method"));
          skipCount++;
          continue;
        }

        // Get the resource accessor and method
        const resource = (client as any)[resolution.service];
        if (!resource) {
          console.log(`  SKIP ${op.name} — service "${resolution.service}" not found on client`);
          exchanges.push(
            makeSkippedExchange(op, irService, `Service "${resolution.service}" not found`),
          );
          skipCount++;
          continue;
        }

        const methodFn = resource[resolution.method];
        if (typeof methodFn !== "function") {
          console.log(
            `  SKIP ${op.name} — method "${resolution.method}" not found on ${resolution.service}`,
          );
          exchanges.push(
            makeSkippedExchange(
              op,
              irService,
              `Method "${resolution.method}" not found on ${resolution.service}`,
            ),
          );
          skipCount++;
          continue;
        }

        // Resolve path params
        let pathParams: Record<string, string> = {};
        if (op.pathParams.length > 0) {
          const resolved = ids.resolvePathParams(op, irService);
          if (!resolved) {
            console.log(`  SKIP ${op.name} — missing path param IDs`);
            exchanges.push(makeSkippedExchange(op, irService, "Missing path param IDs"));
            skipCount++;
            continue;
          }
          pathParams = resolved;
        }

        // Build arguments
        const args = buildArgs(op, pathParams, spec);

        // Execute
        currentCapture = null;
        const start = Date.now();

        try {
          await methodFn.call(resource, ...args);
          const elapsed = Date.now() - start;

          if (!currentCapture) {
            console.log(`  SKIP ${op.name} — no HTTP capture (method may not make HTTP calls)`);
            exchanges.push(makeSkippedExchange(op, irService, "No HTTP capture"));
            skipCount++;
            continue;
          }

          const exchange = buildExchange(op, irService, currentCapture, elapsed, resolution);

          // Extract IDs from response
          const responseBody = currentCapture.response.body;
          ids.extractAndStore(irService, responseBody, isTopLevel);

          // Track created entities for cleanup
          if (op.httpMethod === "post" && currentCapture.response.status < 300) {
            const body = responseBody as Record<string, unknown> | null;
            if (body?.id && typeof body.id === "string") {
              // Find the delete method for this service
              const deleteResolution = findDeleteMethod(irService, manifest);
              if (deleteResolution) {
                const deleteResource = (client as any)[deleteResolution.service];
                const deleteFn = deleteResource?.[deleteResolution.method];
                if (typeof deleteFn === "function") {
                  createdEntities.push({
                    service: irService,
                    id: body.id as string,
                    deleteFn: () => deleteFn.call(deleteResource, body.id),
                  });
                }
              }
            }
          }

          if (exchange.unexpectedStatus) {
            unexpectedCount++;
            console.log(`  ⚠ ${op.name} → ${currentCapture.response.status} (unexpected)`);
          } else if (exchange.outcome === "api-error") {
            errorCount++;
            console.log(`  ✗ ${op.name} → ${currentCapture.response.status}`);
          } else {
            successCount++;
            console.log(`  ✓ ${op.name} → ${currentCapture.response.status} (${elapsed}ms)`);
          }

          exchanges.push(exchange);
        } catch (err) {
          const elapsed = Date.now() - start;
          const message = err instanceof Error ? err.message : String(err);

          if (currentCapture) {
            const exchange = buildExchange(op, irService, currentCapture, elapsed, resolution);
            exchange.error = message;
            exchanges.push(exchange);
            errorCount++;
            console.log(`  ✗ ${op.name} → ${currentCapture.response.status} (${message})`);
          } else {
            exchanges.push({
              ...makeSkippedExchange(op, irService, message),
              outcome: "api-error",
              durationMs: elapsed,
            });
            errorCount++;
            console.log(`  ✗ ${op.name} — ${message}`);
          }
        }

        await delay(delayMs);
      }
    }

    // Cleanup created entities (reverse order)
    if (createdEntities.length > 0) {
      console.log(`\n--- Cleanup (${createdEntities.length} entities) ---`);
      for (const entity of createdEntities.reverse()) {
        try {
          if (entity.deleteFn) {
            await entity.deleteFn();
            console.log(`  ✓ Deleted ${entity.service} ${entity.id}`);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.log(`  ✗ Failed to delete ${entity.service} ${entity.id}: ${message}`);
        }
        await delay(delayMs);
      }
    }
  } finally {
    restoreFetch();
  }

  // Write results
  const results: SmokeResults = {
    source: "sdk-node",
    timestamp: new Date().toISOString(),
    specVersion: spec.version,
    exchanges,
  };

  const outputPath = `smoke-results-sdk-node.json`;
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
    outcome: "skipped",
    error: reason,
    durationMs: 0,
  };
}

function buildExchange(
  op: Operation,
  service: string,
  capture: NonNullable<typeof currentCapture>,
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
    outcome: status >= 200 && status < 300 ? "success" : "api-error",
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

function findDeleteMethod(
  irService: string,
  manifest: Map<string, ManifestEntry> | null,
): MethodResolution | null {
  if (!manifest) return null;
  // Look for a DELETE method in the manifest that belongs to this service
  for (const [httpKey, entry] of manifest.entries()) {
    if (
      httpKey.startsWith("DELETE ") &&
      entry.service === (SERVICE_PROPERTY_MAP[irService] || toCamelCase(irService))
    ) {
      return {
        service: entry.service,
        method: entry.sdkMethod,
        tier: "manifest",
        confidence: 1.0,
      };
    }
  }
  return null;
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
