import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Service } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import {
  className,
  fileName,
  methodName,
  fieldName,
  wireFieldName,
  wireInterfaceName,
  serviceDirName,
  servicePropertyName,
  resolveServiceName,
  buildServiceNameMap,
  stripNoiseSuffixes,
} from '../../src/node/naming.js';

const emptySpec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: '',
  services: [],
  models: [],
  enums: [],
  sdk: defaultSdkBehavior(),
};

const ctx: EmitterContext = {
  namespace: 'workos',
  namespacePascal: 'WorkOS',
  spec: emptySpec,
};

describe('stripNoiseSuffixes', () => {
  it('strips Dto suffix', () => {
    expect(stripNoiseSuffixes('OrganizationDto')).toBe('Organization');
  });

  it('strips dto suffix case-insensitively', () => {
    expect(stripNoiseSuffixes('OrganizationDTO')).toBe('Organization');
  });

  it('leaves names without Dto unchanged', () => {
    expect(stripNoiseSuffixes('Organization')).toBe('Organization');
  });
});

describe('className', () => {
  it('converts to PascalCase', () => {
    expect(className('user_management')).toBe('UserManagement');
  });

  it('handles already PascalCase', () => {
    expect(className('Organization')).toBe('Organization');
  });
});

describe('fileName', () => {
  it('converts to kebab-case', () => {
    expect(fileName('OrganizationDomain')).toBe('organization-domain');
  });

  it('handles single word', () => {
    expect(fileName('Organization')).toBe('organization');
  });
});

describe('methodName', () => {
  it('converts to camelCase', () => {
    expect(methodName('create_organization')).toBe('createOrganization');
  });

  it('handles already camelCase', () => {
    expect(methodName('listOrganizations')).toBe('listOrganizations');
  });
});

describe('fieldName', () => {
  it('converts snake_case to camelCase', () => {
    expect(fieldName('allow_profiles_outside_organization')).toBe('allowProfilesOutsideOrganization');
  });

  it('converts simple snake_case', () => {
    expect(fieldName('stripe_customer_id')).toBe('stripeCustomerId');
  });
});

describe('wireFieldName', () => {
  it('converts camelCase to snake_case', () => {
    expect(wireFieldName('allowProfilesOutsideOrganization')).toBe('allow_profiles_outside_organization');
  });
});

describe('wireInterfaceName', () => {
  it('appends Response suffix', () => {
    expect(wireInterfaceName('Organization')).toBe('OrganizationResponse');
  });

  it('uses Wire suffix when name already ends in Response', () => {
    expect(wireInterfaceName('PortalSessionsCreateResponse')).toBe('PortalSessionsCreateResponseWire');
  });
});

describe('serviceDirName', () => {
  it('converts to kebab-case', () => {
    expect(serviceDirName('UserManagement')).toBe('user-management');
  });
});

describe('servicePropertyName', () => {
  it('converts to camelCase', () => {
    expect(servicePropertyName('UserManagement')).toBe('userManagement');
  });
});

describe('resolveServiceName', () => {
  it('returns overlay class name when available', () => {
    const service: Service = { name: 'MultiFactorAuth', operations: [] };
    const ctxWithOverlay: EmitterContext = {
      ...ctx,
      resolvedOperations: [
        {
          operation: {
            name: 'listFactors',
            httpMethod: 'get',
            path: '/auth/factors',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            response: { kind: 'primitive', type: 'unknown' },
            errors: [],
            injectIdempotencyKey: false,
            pagination: undefined,
          },
          service,
          methodName: 'list_factors',
          mountOn: 'Mfa',
          defaults: {},
          inferFromClient: [],
          urlBuilder: false,
        },
      ],
    };
    expect(resolveServiceName(service, ctxWithOverlay)).toBe('Mfa');
  });

  it('falls back to service name if no overlay', () => {
    const service: Service = { name: 'Organizations', operations: [] };
    expect(resolveServiceName(service, ctx)).toBe('Organizations');
  });
});

describe('buildServiceNameMap', () => {
  it('maps IR service names to resolved names', () => {
    const services: Service[] = [
      { name: 'Organizations', operations: [] },
      { name: 'UserManagement', operations: [] },
    ];
    const map = buildServiceNameMap(services, ctx);
    expect(map.get('Organizations')).toBe('Organizations');
    expect(map.get('UserManagement')).toBe('UserManagement');
  });
});
