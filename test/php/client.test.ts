import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Service, Model } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateClient } from '../../src/php/client.js';
import { phpEmitter } from '../../src/php/index.js';
import { dateTimeWireExpr, generateRuntime } from '../../src/php/runtime.js';

const models: Model[] = [
  {
    name: 'Organization',
    fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
  },
];

const services: Service[] = [
  {
    name: 'Organizations',
    operations: [
      {
        name: 'listOrganizations',
        httpMethod: 'get',
        path: '/organizations',
        pathParams: [],
        queryParams: [],
        headerParams: [],
        response: { kind: 'model', name: 'Organization' },
        errors: [],
        injectIdempotencyKey: false,
      },
    ],
  },
];

const emptySpec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: 'https://api.example.com',
  services,
  models,
  enums: [],
  sdk: defaultSdkBehavior(),
};

const ctx: EmitterContext = {
  namespace: 'workos',
  namespacePascal: 'WorkOS',
  spec: emptySpec,
};

describe('generateClient', () => {
  it('only generates the main client file', () => {
    const result = generateClient(emptySpec, ctx);

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('lib/WorkOS.php');
  });

  it('generates main client class with namespace', () => {
    const result = generateClient(emptySpec, ctx);

    expect(result[0].content).toContain('class WorkOS');
    expect(result[0].content).toContain('namespace WorkOS;');
  });

  it('generates resource accessor methods', () => {
    const result = generateClient(emptySpec, ctx);

    expect(result[0].content).toContain('public function organizations(): Organizations');
  });

  it('includes constructor with config options', () => {
    const result = generateClient(emptySpec, ctx);

    expect(result[0].content).toContain('?string $apiKey = null');
    expect(result[0].content).toContain('?string $clientId = null');
    expect(result[0].content).toContain("string $baseUrl = 'https://api.example.com'");
    expect(result[0].content).toContain('int $timeout = 60');
    expect(result[0].content).toContain('int $maxRetries = 3');
    expect(result[0].content).toContain('?string $userAgent = null');
    expect(result[0].content).toContain(
      'new HttpClient($apiKey, $clientId, $baseUrl, $timeout, $maxRetries, $handler, $userAgent)',
    );
    expect(result[0].content).not.toContain('self::$apiKey = $apiKey;');
    expect(result[0].content).not.toContain('self::$clientId = $clientId;');
  });

  it('includes non-spec service accessors', () => {
    const result = generateClient(emptySpec, ctx);

    expect(result[0].content).toContain('public function passwordless(): Passwordless');
    expect(result[0].content).toContain('public function webhookVerification(): WebhookVerification');
    expect(result[0].content).toContain('public function actions(): Actions');
    expect(result[0].content).toContain('public function sessionManager(): SessionManager');
    expect(result[0].content).toContain('public function pkce(): PKCEHelper');
  });
});

describe('php runtime helpers', () => {
  // oagen-emitters#293: every outgoing `\DateTimeImmutable` is serialized by
  // one generated helper (UTC, milliseconds, a literal `Z`) instead of
  // `RFC3339_EXTENDED`, whose `+00:00` offset the API rejects.
  it('emits Internal\\DateTimeFormat with the client', () => {
    const files = phpEmitter.generateClient(emptySpec, ctx);
    const runtime = files.find((f) => f.path === 'lib/Internal/DateTimeFormat.php');
    expect(runtime).toBeDefined();
    expect(runtime!.content).toContain('namespace WorkOS\\Internal;');
    expect(runtime!.content).toContain('final class DateTimeFormat');
    expect(runtime!.content).toContain("public const ISO_8601_UTC = 'Y-m-d\\TH:i:s.v\\Z';");
    expect(runtime!.content).toContain('public static function iso8601(?\\DateTimeInterface $value): ?string');
    expect(runtime!.content).toContain("->setTimezone(new \\DateTimeZone('UTC'))");
    expect(runtime!.content).toContain('\\DateTimeImmutable::createFromInterface($value)');
    expect(runtime!.content.endsWith('\n')).toBe(true);
  });

  it('places the helper under the configured namespace', () => {
    const [runtime] = generateRuntime({ ...ctx, namespacePascal: 'Acme' });
    expect(runtime.content).toContain('namespace Acme\\Internal;');
    expect(dateTimeWireExpr('Acme', '$value')).toBe('\\Acme\\Internal\\DateTimeFormat::iso8601($value)');
  });
});
