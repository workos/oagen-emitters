import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Service, Model } from '@workos/oagen';
import { generateClient } from '../../src/php/client.js';
import { initializeNaming } from '../../src/php/naming.js';

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
};

const ctx: EmitterContext = {
  namespace: 'workos',
  namespacePascal: 'WorkOS',
  spec: emptySpec,
};

describe('generateClient', () => {
  it('generates main client class', () => {
    initializeNaming(models.map((m) => m.name));
    const result = generateClient(emptySpec, ctx);

    const clientFile = result.find((f) => f.path === 'lib/WorkOS.php');
    expect(clientFile).toBeDefined();
    expect(clientFile!.content).toContain('class WorkOS');
    expect(clientFile!.content).toContain('namespace WorkOS;');
  });

  it('generates resource accessor methods', () => {
    initializeNaming(models.map((m) => m.name));
    const result = generateClient(emptySpec, ctx);

    const clientFile = result.find((f) => f.path === 'lib/WorkOS.php');
    expect(clientFile!.content).toContain('public function organizations(): Organizations');
  });

  it('generates HttpClient class', () => {
    initializeNaming(models.map((m) => m.name));
    const result = generateClient(emptySpec, ctx);

    const httpFile = result.find((f) => f.path === 'lib/HttpClient.php');
    expect(httpFile).toBeDefined();
    expect(httpFile!.content).toContain('class HttpClient');
    expect(httpFile!.content).toContain('use GuzzleHttp\\Client');
    expect(httpFile!.content).toContain('requestWithRetry');
  });

  it('generates PaginatedResponse class', () => {
    initializeNaming(models.map((m) => m.name));
    const result = generateClient(emptySpec, ctx);

    const paginatedFile = result.find((f) => f.path === 'lib/PaginatedResponse.php');
    expect(paginatedFile).toBeDefined();
    expect(paginatedFile!.content).toContain('class PaginatedResponse');
    expect(paginatedFile!.content).toContain('autoPagingIterator');
    expect(paginatedFile!.content).toContain('IteratorAggregate');
  });

  it('generates RequestOptions class', () => {
    initializeNaming(models.map((m) => m.name));
    const result = generateClient(emptySpec, ctx);

    const optionsFile = result.find((f) => f.path === 'lib/RequestOptions.php');
    expect(optionsFile).toBeDefined();
    expect(optionsFile!.content).toContain('class RequestOptions');
    expect(optionsFile!.content).toContain('$extraHeaders');
    expect(optionsFile!.content).toContain('$idempotencyKey');
  });

  it('includes constructor with config options', () => {
    initializeNaming(models.map((m) => m.name));
    const result = generateClient(emptySpec, ctx);

    const clientFile = result.find((f) => f.path === 'lib/WorkOS.php');
    expect(clientFile!.content).toContain('?string $apiKey = null');
    expect(clientFile!.content).toContain("string $baseUrl = 'https://api.example.com'");
    expect(clientFile!.content).toContain('int $timeout = 60');
    expect(clientFile!.content).toContain('int $maxRetries = 3');
  });
});
