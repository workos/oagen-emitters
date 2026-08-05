#!/usr/bin/env npx tsx
/**
 * Android / Kotlin SDK smoke test — captures wire-level HTTP exchanges from the
 * generated Android SDK and outputs SmokeResults JSON for diff comparison.
 *
 * Kotlin is compiled, so (like Go/Swift) the SDK is driven out-of-process:
 *   1. A local capture proxy (this process) forwards requests to the real API,
 *      recording each request/response pair. The driver points its baseUrl at
 *      the proxy; the proxy injects the real Authorization header.
 *   2. Per wave, a `Main.kt` driver is generated that makes literal SDK calls
 *      wrapped in stderr markers, built and run via Gradle.
 *
 * The SDK ships as an Android library (`com.android.library`), but nothing in the
 * GENERATED code touches Android APIs — it is OkHttp + kotlinx.serialization +
 * kotlinx.datetime, all pure JVM. So the driver compiles the SDK's
 * `src/main/kotlin` as a plain `kotlin("jvm")` source set (the same trick
 * `sdk-kotlin.ts` uses), which avoids needing the Android SDK, an emulator, or an
 * instrumented test run just to observe HTTP traffic.
 *
 * Resource methods take flattened named arguments, so the driver reconstructs each
 * call from the emitter's own `.oagen-android-smoke.json` sidecar — guaranteeing
 * the generated calls match the generated methods exactly.
 *
 * Usage:
 *   npx tsx smoke/sdk-android.ts --spec ../openapi-spec/spec/open-api-spec.yaml --sdk-path ./sdk
 *
 * Requires API_KEY or WORKOS_API_KEY env var.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
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

// The `.oagen-android-smoke.json` sidecar shape (authoritative, transform-aware).
type Serialize =
  | { kind: 'string' | 'int' | 'long' | 'double' | 'bool' | 'instant' | 'bytes' | 'json' | 'unsupported' }
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

/** Where the generated SDK lives, and what the driver must supply itself. */
interface SdkLayout {
  /** Root package of the generated SDK (e.g. `com.workos.android`). */
  basePackage: string;
  /** Client class name (e.g. `WorkOSClient`). */
  clientClass: string;
  /** Absolute path to the SDK's Kotlin source root. */
  sourceRoot: string;
  /** True when the SDK repo provides the hand-maintained HTTP runtime. */
  hasRuntime: boolean;
}

// Module-scoped smoke plan (from .oagen-android-smoke.json), initialized in main().
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
        const url = new URL(req.url ?? '/', 'http://localhost');
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
              request: { method: req.method ?? 'GET', path: url.pathname, queryParams, body },
              response: { status: proxyRes.statusCode ?? 0, body: resBody },
            });
            res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
            res.end(Buffer.concat(resChunks));
          });
        });

        proxyReq.on('error', (err) => {
          captures.push({
            request: { method: req.method ?? 'GET', path: url.pathname, queryParams, body },
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
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      resolvePromise({
        port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Sidecar loading + SDK layout detection
// ---------------------------------------------------------------------------

function loadSmokePlan(sdkPath: string): Map<string, SmokePlanEntry> {
  const planPath = resolve(sdkPath, '.oagen-android-smoke.json');
  if (!existsSync(planPath)) {
    console.warn(`Warning: No .oagen-android-smoke.json found at ${planPath}`);
    console.warn('  Regenerate the SDK with a current android emitter; most operations will be skipped.');
    return new Map();
  }
  const parsed: unknown = JSON.parse(readFileSync(planPath, 'utf-8'));
  const plan = new Map<string, SmokePlanEntry>();
  if (parsed && typeof parsed === 'object' && 'operations' in parsed) {
    const operations = (parsed as { operations?: unknown }).operations;
    if (operations && typeof operations === 'object') {
      for (const [httpKey, entry] of Object.entries(operations)) {
        plan.set(httpKey, entry as SmokePlanEntry);
      }
    }
  }
  return plan;
}

/**
 * Locate the generated SDK's root package by finding the directory under
 * `src/main/kotlin` that contains the generated `models/` folder.
 */
function detectLayout(sdkPath: string): SdkLayout {
  const sourceRoot = resolve(sdkPath, 'src', 'main', 'kotlin');
  const fallback: SdkLayout = {
    basePackage: 'com.workos.android',
    clientClass: 'WorkOSClient',
    sourceRoot,
    hasRuntime: false,
  };
  if (!existsSync(sourceRoot)) return fallback;

  const found = findPackageDir(sourceRoot, []);
  if (!found) return fallback;

  const { dir, segments } = found;
  const basePackage = segments.join('.');
  const clientResources = readdirSync(dir).find((f) => f.endsWith('ClientResources.kt'));
  const clientClass = clientResources ? clientResources.replace(/Resources\.kt$/, '') : `${fallback.clientClass}`;
  const hasRuntime = existsSync(join(dir, 'internal', 'Transport.kt'));

  return { basePackage, clientClass, sourceRoot, hasRuntime };
}

/** Depth-first search for the package directory containing a `models` subdir. */
function findPackageDir(dir: string, segments: string[]): { dir: string; segments: string[] } | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  if (entries.includes('models') && statSync(join(dir, 'models')).isDirectory()) {
    return { dir, segments };
  }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const child = join(dir, entry);
    if (!statSync(child).isDirectory()) continue;
    const found = findPackageDir(child, [...segments, entry]);
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Method resolution — sidecar only (it is authoritative and transform-aware)
// ---------------------------------------------------------------------------

function resolveMethod(op: Operation): MethodResolution | null {
  const entry = smokePlan.get(`${op.httpMethod.toUpperCase()} ${op.path}`);
  if (!entry) return null; // absent = URL-builder / split / unsupported op
  return { service: entry.service, method: entry.method, tier: 'manifest', confidence: 1.0 };
}

// ---------------------------------------------------------------------------
// Kotlin argument construction
// ---------------------------------------------------------------------------

/**
 * Escape a value as a Kotlin string literal. `$` MUST be escaped — Kotlin
 * interpolates `$name`/`${expr}` inside string literals, so an unescaped `$` in
 * spec-derived fixture data would become live code in the driver.
 */
function kotlinString(value: unknown): string {
  const escaped = String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\$/g, '\\$')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
  return `"${escaped}"`;
}

/** Serialize a JS value to a Kotlin literal per the sidecar descriptor, or null. */
function serializeValue(value: unknown, s: Serialize, basePackage: string): string | null {
  switch (s.kind) {
    case 'string':
      return kotlinString(value);
    case 'int':
      if (typeof value === 'number') return String(Math.trunc(value));
      if (typeof value === 'string' && /^-?\d+$/.test(value)) return value;
      return null;
    case 'long':
      if (typeof value === 'number') return `${Math.trunc(value)}L`;
      if (typeof value === 'string' && /^-?\d+$/.test(value)) return `${value}L`;
      return null;
    case 'double':
      if (typeof value === 'number') return String(value);
      if (typeof value === 'string' && value !== '' && !Number.isNaN(Number(value))) return value;
      return null;
    case 'bool':
      if (typeof value === 'boolean') return String(value);
      if (value === 'true' || value === 'false') return value;
      return null;
    case 'instant': {
      if (value instanceof Date) return `kotlinx.datetime.Instant.parse(${kotlinString(value.toISOString())})`;
      if (typeof value === 'string') {
        const ms = Date.parse(value);
        if (!Number.isNaN(ms)) {
          return `kotlinx.datetime.Instant.parse(${kotlinString(new Date(ms).toISOString())})`;
        }
      }
      return null;
    }
    case 'bytes':
      return typeof value === 'string' ? `${kotlinString(value)}.toByteArray()` : null;
    case 'enum':
      // The generated sealed classes expose a total `fromRawValue`, so an
      // unrecognized fixture value degrades to Unknown rather than throwing.
      if (typeof value === 'string') {
        return `${basePackage}.enums.${s.enumType}.fromRawValue(${kotlinString(value)})`;
      }
      if (typeof value === 'number') {
        return `${basePackage}.enums.${s.enumType}.fromRawValue(${Math.trunc(value)})`;
      }
      return null;
    case 'json':
      if (typeof value === 'string') return `kotlinx.serialization.json.JsonPrimitive(${kotlinString(value)})`;
      if (typeof value === 'number' || typeof value === 'boolean') {
        return `kotlinx.serialization.json.JsonPrimitive(${value})`;
      }
      return null;
    case 'array': {
      if (!Array.isArray(value)) return null;
      const items = value.map((v) => serializeValue(v, s.element, basePackage));
      if (items.some((i) => i === null)) return null;
      return `listOf(${items.join(', ')})`;
    }
    case 'map': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
      const entries = Object.entries(value).map(([k, v]) => {
        const lit = serializeValue(v, s.value, basePackage);
        return lit === null ? null : `${kotlinString(k)} to ${lit}`;
      });
      if (entries.some((e) => e === null)) return null;
      return entries.length ? `mapOf(${entries.join(', ')})` : 'emptyMap()';
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

/** Build the Kotlin named-argument list from the sidecar plan, or a skip reason. */
function buildCallArgs(
  op: Operation,
  pathParams: Record<string, string>,
  spec: ApiSpec,
  basePackage: string,
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
    else if (p.source === 'body') value = pickValue(payload, p);
    else value = pickValue(query, p);

    if (value === undefined || value === null) {
      if (p.optional) continue;
      return { skip: `no value for required parameter '${p.label}'` };
    }

    const literal = serializeValue(value, p.serialize, basePackage);
    if (literal === null) {
      if (p.optional) continue;
      return { skip: `cannot serialize required parameter '${p.label}'` };
    }
    // Kotlin named arguments are order-insensitive, so emitting in plan order is
    // safe even if the generated signature reorders required-before-optional.
    args.push(`${p.label} = ${literal}`);
  }
  return { args };
}

// ---------------------------------------------------------------------------
// Kotlin driver generation
// ---------------------------------------------------------------------------

interface PlannedCall {
  index: number;
  op: Operation;
  irService: string;
  resolution: MethodResolution;
  callArgs: string[];
}

function buildDriverKotlin(port: number, layout: SdkLayout, calls: PlannedCall[]): string {
  const lines: string[] = [];
  lines.push(`import ${layout.basePackage}.*`);
  lines.push('import kotlinx.coroutines.runBlocking');
  lines.push('');
  lines.push('fun main() = runBlocking {');
  lines.push(
    `    val client = ${layout.clientClass}(Configuration(apiKey = "api_key", baseUrl = "http://localhost:${port}", maxRetries = 0))`,
  );
  lines.push('    fun mark(s: String) { System.err.println(s); System.err.flush() }');
  lines.push('');

  for (const call of calls) {
    const argStr = call.callArgs.join(', ');
    lines.push(`    mark("OAGEN_CALL_START:${call.index}")`);
    lines.push('    try {');
    lines.push(`        client.${call.resolution.service}.${call.resolution.method}(${argStr})`);
    lines.push(`        mark("OAGEN_CALL_OK:${call.index}")`);
    lines.push('    } catch (e: Throwable) {');
    lines.push(`        mark("OAGEN_CALL_ERROR:${call.index}:\${e.javaClass.name}: \${e.message}")`);
    lines.push('    }');
    lines.push(`    mark("OAGEN_CALL_END:${call.index}")`);
    lines.push('    Thread.sleep(50)');
    lines.push('');
  }

  lines.push('}');
  return lines.join('\n');
}

function writeGradleProject(tmpDir: string, layout: SdkLayout, mainKt: string): void {
  const srcDir = join(tmpDir, 'src', 'main', 'kotlin');
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, 'Main.kt'), mainKt);

  if (!layout.hasRuntime) {
    writeStubRuntime(srcDir, layout.basePackage, layout.clientClass);
  }

  const sdkSrcDir = layout.sourceRoot.replace(/\\/g, '/');
  // The SDK is an Android library, but the generated code is pure JVM (OkHttp +
  // kotlinx), so compiling it as a `kotlin("jvm")` source set avoids needing the
  // Android SDK or an emulator just to observe HTTP traffic.
  const buildGradle = `plugins {
    kotlin("jvm") version "2.1.10"
    kotlin("plugin.serialization") version "2.1.10"
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
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("org.jetbrains.kotlinx:kotlinx-datetime:0.6.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0")
}

kotlin {
    jvmToolchain(17)
}

application {
    mainClass.set("MainKt")
}
`;
  writeFileSync(join(tmpDir, 'build.gradle.kts'), buildGradle);
  writeFileSync(join(tmpDir, 'settings.gradle.kts'), 'rootProject.name = "smoke-driver"\n');
}

/**
 * Emit a minimal HTTP runtime so the smoke test can run before the SDK repo's
 * hand-maintained runtime exists.
 *
 * The `android` emitter deliberately does NOT generate `Transport`,
 * `Configuration`, `JsonBody`, `Page`, `PathEncoding`, or the exception
 * hierarchy — those live in the SDK repo behind `@oagen-ignore-file` (see
 * `docs/sdk-architecture/android.md`). Without them the generated sources cannot
 * compile, so a Scenario B bootstrap would have no way to observe wire traffic at
 * all. This stub implements exactly the surface the generated code calls, and
 * nothing more: it does not model retries, telemetry, or typed errors, so it is
 * only ever used to verify the REQUEST the SDK builds. When the SDK repo provides
 * a real runtime (`internal/Transport.kt`), that one is used instead.
 */
function writeStubRuntime(srcDir: string, basePackage: string, clientClass: string): void {
  const rootDir = join(srcDir, ...basePackage.split('.'));
  const internalDir = join(rootDir, 'internal');
  mkdirSync(internalDir, { recursive: true });

  writeFileSync(
    join(rootDir, 'SmokeRuntime.kt'),
    `package ${basePackage}

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

data class Configuration(
    val apiKey: String,
    val baseUrl: String,
    val timeoutSeconds: Long = 60,
    val maxRetries: Int = 0,
    val clientId: String? = null,
)

data class RequestOptions(
    val idempotencyKey: String? = null,
    val apiKey: String? = null,
)

@Serializable
data class ListMetadata(
    @SerialName("before") val before: String? = null,
    @SerialName("after") val after: String? = null,
)

@Serializable
data class Page<T>(
    @SerialName("data") val data: List<T>,
    @SerialName("list_metadata") val listMetadata: ListMetadata = ListMetadata(),
)

class ${clientClass}(configuration: Configuration) {
    internal val transport: ${basePackage}.internal.Transport =
        ${basePackage}.internal.Transport(configuration)
}
`,
  );

  writeFileSync(
    join(internalDir, 'SmokeTransport.kt'),
    `package ${basePackage}.internal

import java.net.URLEncoder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import ${basePackage}.Configuration
import ${basePackage}.Page
import ${basePackage}.RequestOptions

// Public, not internal: \`Transport.request\` is a public inline function, and a
// public inline function cannot reference non-public-API declarations.
val smokeJson: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = false
    coerceInputValues = true
}

data class QueryParam(val name: String, val value: String)

object PathEncoding {
    fun segment(value: String): String = URLEncoder.encode(value, "UTF-8").replace("+", "%20")
    fun segment(value: Any): String = segment(value.toString())
}

class JsonBody {
    private val fields = LinkedHashMap<String, JsonElement>()
    private var rawElement: JsonElement? = null

    fun set(key: String, value: Any?) {
        if (value == null) return
        fields[key] = convert(value)
    }

    /** Serialize a whole-object request body (an operation with a raw, unexpanded body). */
    fun <T> setRaw(serializer: kotlinx.serialization.SerializationStrategy<T>, value: T) {
        rawElement = smokeJson.encodeToJsonElement(serializer, value)
    }

    /** Use a pre-built JSON element as the entire request body. */
    fun setRawJson(value: JsonElement) {
        rawElement = value
    }

    fun toJsonElement(): JsonElement = rawElement ?: JsonObject(fields)

    fun toJsonObject(): JsonObject = JsonObject(fields)

    private fun convert(value: Any): JsonElement = when (value) {
        is JsonElement -> value
        is String -> JsonPrimitive(value)
        is Number -> JsonPrimitive(value)
        is Boolean -> JsonPrimitive(value)
        is ByteArray -> JsonPrimitive(java.util.Base64.getEncoder().encodeToString(value))
        is List<*> -> JsonArray(value.filterNotNull().map { convert(it) })
        is Map<*, *> -> JsonObject(
            value.entries.filter { it.key != null && it.value != null }
                .associate { it.key.toString() to convert(it.value!!) },
        )
        // Generated sealed-class enums carry the wire value in \`rawValue\`;
        // toString() would yield the object name ("Active" instead of "active").
        else -> JsonPrimitive(rawValueOf(value) ?: value.toString())
    }

    private fun rawValueOf(value: Any): String? = try {
        value.javaClass.getMethod("getRawValue").invoke(value)?.toString()
    } catch (e: ReflectiveOperationException) {
        null
    }
}

class Transport(val configuration: Configuration) {
    private val client = OkHttpClient()

    fun buildUrl(path: String, query: List<QueryParam>): String {
        val base = configuration.baseUrl.trimEnd('/')
        val qs = query.joinToString("&") {
            URLEncoder.encode(it.name, "UTF-8") + "=" + URLEncoder.encode(it.value, "UTF-8")
        }
        return if (qs.isEmpty()) "$base/$path" else "$base/$path?$qs"
    }

    suspend fun execute(
        method: String,
        path: String,
        query: List<QueryParam>,
        body: JsonBody?,
    ): String = withContext(Dispatchers.IO) {
        val payload = body?.let { smokeJson.encodeToString(JsonElement.serializer(), it.toJsonElement()) }
        val requestBody = when {
            payload != null -> payload.toRequestBody("application/json".toMediaTypeOrNull())
            method == "POST" || method == "PUT" || method == "PATCH" -> "".toRequestBody(null)
            else -> null
        }
        val request = Request.Builder()
            .url(buildUrl(path, query))
            .method(method, requestBody)
            .header("Authorization", "Bearer " + configuration.apiKey)
            .header("Content-Type", "application/json")
            .build()
        client.newCall(request).execute().use { response ->
            response.body?.string() ?: ""
        }
    }

    suspend inline fun <reified T> request(
        method: String,
        path: String,
        query: List<QueryParam>,
        body: JsonBody?,
        options: RequestOptions?,
    ): T {
        val text = execute(method, path, query, body)
        return smokeJson.decodeFromString<T>(if (text.isBlank()) "{}" else text)
    }

    suspend fun requestVoid(
        method: String,
        path: String,
        query: List<QueryParam>,
        body: JsonBody?,
        options: RequestOptions?,
    ) {
        execute(method, path, query, body)
    }
}

internal fun <T> autoPagingFlow(fetch: suspend (String?) -> Page<T>): Flow<T> = flow {
    var cursor: String? = null
    while (true) {
        val page = fetch(cursor)
        for (item in page.data) emit(item)
        cursor = page.listMetadata.after ?: break
    }
}
`,
  );
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

  const layout = detectLayout(sdkPath);
  console.log(`Kotlin package: ${layout.basePackage} (client: ${layout.clientClass})`);
  if (!layout.hasRuntime) {
    console.warn('Warning: SDK provides no internal/Transport.kt — using the smoke stub runtime.');
    console.warn('  Wire capture is valid; retry/telemetry/typed-error behavior is NOT exercised.');
  }

  smokePlan = loadSmokePlan(sdkPath);
  console.log(`Smoke plan: ${smokePlan.size} operations`);

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

  const tmpDir = join(tmpdir(), 'oagen-android-smoke');
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
        const built = buildCallArgs(op, pathParams, spec, layout.basePackage);
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

      const mainKt = buildDriverKotlin(proxy.port, layout, plannedCalls);
      writeGradleProject(tmpDir, layout, mainKt);

      const callResults = new Map<
        number,
        { captureIndexBefore: number; captureIndexAfter: number; error?: string; startTime: number; endTime: number }
      >();
      let currentCallStart = Date.now();
      let currentCapturesBefore = 0;

      try {
        await new Promise<void>((resolvePromise, rejectPromise) => {
          const child = spawn('gradle', ['run', '--quiet'], {
            cwd: tmpDir,
            env: { ...process.env },
            stdio: ['pipe', 'pipe', 'pipe'],
          });

          const timeout = setTimeout(() => {
            child.kill('SIGKILL');
            rejectPromise(new Error('Gradle driver timed out after 600s'));
          }, 600_000);

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
    source: 'sdk-android',
    timestamp: new Date().toISOString(),
    specVersion: spec.version,
    exchanges,
  };
  const outputPath = 'smoke-results-sdk-android.json';
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
