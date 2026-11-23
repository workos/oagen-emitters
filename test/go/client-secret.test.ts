import { describe, expect, it } from 'vitest';
import type { EmitterContext, Service } from '@workos/oagen';
import { generateResources } from '../../src/go/resources.js';
import {
  clientSecretContext,
  clientSecretServices,
  clientSecretSpec,
  clientSecretUrlBuilderContext,
} from '../shared/client-secret-fixture.js';

function generate(): Record<string, string> {
  const files = generateResources(clientSecretServices, clientSecretContext());
  return Object.fromEntries(files.map((f) => [f.path, f.content]));
}

describe('go/client secret', () => {
  it('resolves client_secret through the client accessor in a wrapper and returns its error', () => {
    const content = generate()['user_management.go'];

    expect(content).toContain(
      [
        '\tbody.ClientID = s.client.clientID',
        '\tclientSecret, err := s.client.clientSecret("AuthenticateWithPassword")',
        '\tif err != nil {',
        '\t\treturn nil, err',
        '\t}',
        '\tbody.ClientSecret = clientSecret',
      ].join('\n'),
    );
    // `err` is already declared, so the request assigns instead of redeclaring.
    expect(content).toContain('\t_, err = s.client.request(ctx, "POST", "/user_management/authenticate"');
    expect(content).not.toContain('_, err := s.client.request(');
    expect(content).not.toContain('s.client.apiKey');
  });

  it('resolves client_secret through the client accessor on an operation-level hint', () => {
    const content = generate()['sso.go'];

    expect(content).toContain(
      [
        '\tclientSecret, err := s.client.clientSecret("GetProfileAndToken")',
        '\tif err != nil {',
        '\t\treturn nil, err',
        '\t}',
        '\tbody.ClientSecret = clientSecret',
      ].join('\n'),
    );
    expect(content).toContain('\t_, err = s.client.request(ctx, "POST", "/sso/token"');
    expect(content).not.toContain('_, err := s.client.request(');
    expect(content).not.toContain('s.client.apiKey');
    // The accessor runs before the request is made.
    expect(content.indexOf('s.client.clientSecret(')).toBeLessThan(content.indexOf('s.client.request('));
  });

  it('returns the bare error from methods that have no response value', () => {
    const services: Service[] = clientSecretServices.map((service) => ({
      ...service,
      operations: service.operations.map((op) => ({ ...op, response: { kind: 'primitive', type: 'unknown' } })),
    }));
    const base = clientSecretContext();
    const ctx: EmitterContext = {
      ...base,
      spec: { ...clientSecretSpec, services },
      resolvedOperations: base.resolvedOperations!.map((r, i) => ({
        ...r,
        service: services[i],
        operation: services[i].operations[0],
        wrappers: r.wrappers?.map((w) => ({ ...w, responseModelName: null })),
      })) as never,
    };
    const files = Object.fromEntries(generateResources(services, ctx).map((f) => [f.path, f.content]));

    for (const path of ['user_management.go', 'sso.go']) {
      expect(files[path]).toContain(['\tif err != nil {', '\t\treturn err', '\t}'].join('\n'));
      expect(files[path]).toContain('\t_, err = s.client.request(');
      expect(files[path]).not.toContain('return nil, err');
    }
  });

  it('leaves methods that infer no client_secret declaring err at the request', () => {
    const base = clientSecretContext();
    const ctx: EmitterContext = {
      ...base,
      resolvedOperations: base.resolvedOperations!.map((r) => ({
        ...r,
        inferFromClient: r.inferFromClient ? ['client_id'] : undefined,
        wrappers: r.wrappers?.map((w) => ({ ...w, inferFromClient: ['client_id'] })),
      })) as never,
    };
    const files = generateResources(clientSecretServices, ctx);

    for (const file of files) {
      expect(file.content).toContain('\t_, err := s.client.request(');
      expect(file.content).not.toContain('clientSecret');
    }
  });

  it('refuses to infer client_secret into a query string', () => {
    // A URL builder returns a bare string and a paginated method an iterator:
    // neither can return the accessor's error.
    const { services, ctx } = clientSecretUrlBuilderContext();
    expect(() => generateResources(services, ctx)).toThrow(
      'Go emitter: GetAuthorizationURL infers client_secret into a query string',
    );

    const getCtx: EmitterContext = {
      ...ctx,
      resolvedOperations: ctx.resolvedOperations!.map((r) => ({ ...r, urlBuilder: false })) as never,
    };
    expect(() => generateResources(services, getCtx)).toThrow('infers client_secret into a query string');
  });
});
