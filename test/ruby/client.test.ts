import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Service, Model } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateClient } from '../../src/ruby/client.js';

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

describe('generateClient (ruby)', () => {
  it('generates inflections, main entry, and client files', () => {
    const result = generateClient(emptySpec, ctx);

    expect(result).toHaveLength(3);
    expect(result[0].path).toBe('lib/workos/inflections.rb');
    expect(result[1].path).toBe('lib/workos.rb');
    expect(result[2].path).toBe('lib/workos/client.rb');
  });

  it('ignores inflections.rb in Zeitwerk loader', () => {
    const result = generateClient(emptySpec, ctx);
    const mainEntry = result[1].content;

    expect(mainEntry).toContain('loader.ignore("#{__dir__}/workos/inflections.rb")');
  });

  it('ignores errors.rb in Zeitwerk loader', () => {
    const result = generateClient(emptySpec, ctx);
    const mainEntry = result[1].content;

    expect(mainEntry).toContain('loader.ignore("#{__dir__}/workos/errors.rb")');
  });

  it('requires inflections before loader.setup', () => {
    const result = generateClient(emptySpec, ctx);
    const mainEntry = result[1].content;

    const requireIdx = mainEntry.indexOf("require_relative 'workos/inflections'");
    const setupIdx = mainEntry.indexOf('loader.setup');
    expect(requireIdx).toBeGreaterThan(-1);
    expect(setupIdx).toBeGreaterThan(requireIdx);
  });
});
