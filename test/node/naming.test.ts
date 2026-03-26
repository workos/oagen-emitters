import { describe, it, expect } from 'vitest';
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
} from '../../src/node/naming.js';
import type { EmitterContext, ApiSpec, Service } from '@workos/oagen';

describe('naming', () => {
  describe('className', () => {
    it('converts to PascalCase', () => {
      expect(className('organizations')).toBe('Organizations');
      expect(className('user_management')).toBe('UserManagement');
      expect(className('api_keys')).toBe('ApiKeys');
    });
  });

  describe('fileName', () => {
    it('converts to kebab-case', () => {
      expect(fileName('Organization')).toBe('organization');
      expect(fileName('OrganizationDomain')).toBe('organization-domain');
      expect(fileName('UserManagement')).toBe('user-management');
    });
  });

  describe('methodName', () => {
    it('converts to camelCase', () => {
      expect(methodName('list_organizations')).toBe('listOrganizations');
      expect(methodName('create_organization')).toBe('createOrganization');
      expect(methodName('get_organization')).toBe('getOrganization');
    });
  });

  describe('fieldName', () => {
    it('converts to camelCase', () => {
      expect(fieldName('allow_profiles_outside_organization')).toBe('allowProfilesOutsideOrganization');
      expect(fieldName('stripe_customer_id')).toBe('stripeCustomerId');
      expect(fieldName('id')).toBe('id');
    });
  });

  describe('wireFieldName', () => {
    it('converts to snake_case', () => {
      expect(wireFieldName('allowProfilesOutsideOrganization')).toBe('allow_profiles_outside_organization');
      expect(wireFieldName('id')).toBe('id');
      expect(wireFieldName('created_at')).toBe('created_at');
    });
  });

  describe('wireInterfaceName', () => {
    it('appends Response for normal names', () => {
      expect(wireInterfaceName('Organization')).toBe('OrganizationResponse');
    });

    it('appends Wire when name already ends in Response', () => {
      expect(wireInterfaceName('PortalSessionsCreateResponse')).toBe('PortalSessionsCreateResponseWire');
    });
  });

  describe('serviceDirName', () => {
    it('converts to kebab-case', () => {
      expect(serviceDirName('Organizations')).toBe('organizations');
      expect(serviceDirName('UserManagement')).toBe('user-management');
      expect(serviceDirName('ApiKeys')).toBe('api-keys');
    });
  });

  describe('servicePropertyName', () => {
    it('converts to camelCase', () => {
      expect(servicePropertyName('Organizations')).toBe('organizations');
      expect(servicePropertyName('UserManagement')).toBe('userManagement');
      expect(servicePropertyName('ApiKeys')).toBe('apiKeys');
    });
  });

  describe('resolveServiceName', () => {
    const emptySpec: ApiSpec = {
      name: 'Test',
      version: '1.0.0',
      baseUrl: '',
      services: [],
      models: [],
      enums: [],
    };

    it('returns overlay class name when available', () => {
      const service: Service = {
        name: 'MultiFactorAuth',
        operations: [
          {
            name: 'enrollFactor',
            httpMethod: 'post',
            path: '/auth/factors/enroll',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            response: { kind: 'primitive', type: 'string' },
            errors: [],
            injectIdempotencyKey: true,
          },
        ],
      };

      const ctx: EmitterContext = {
        namespace: 'workos',
        namespacePascal: 'WorkOS',
        spec: emptySpec,
        overlayLookup: {
          methodByOperation: new Map([
            [
              'POST /auth/factors/enroll',
              {
                className: 'Mfa',
                methodName: 'enrollFactor',
                params: [],
                returnType: 'void',
              },
            ],
          ]),
          httpKeyByMethod: new Map(),
          interfaceByName: new Map(),
          typeAliasByName: new Map(),
          requiredExports: new Map(),
          modelNameByIR: new Map(),
          fileBySymbol: new Map(),
        },
      };

      expect(resolveServiceName(service, ctx)).toBe('Mfa');
    });

    it('falls back to PascalCase of service.name', () => {
      const service: Service = {
        name: 'SomeNewService',
        operations: [],
      };

      const ctx: EmitterContext = {
        namespace: 'workos',
        namespacePascal: 'WorkOS',
        spec: emptySpec,
      };

      expect(resolveServiceName(service, ctx)).toBe('SomeNewService');
    });
  });

  describe('buildServiceNameMap', () => {
    const emptySpec: ApiSpec = {
      name: 'Test',
      version: '1.0.0',
      baseUrl: '',
      services: [],
      models: [],
      enums: [],
    };

    it('maps IR names to resolved names', () => {
      const services: Service[] = [
        {
          name: 'MultiFactorAuth',
          operations: [
            {
              name: 'enrollFactor',
              httpMethod: 'post',
              path: '/auth/factors/enroll',
              pathParams: [],
              queryParams: [],
              headerParams: [],
              response: { kind: 'primitive', type: 'string' },
              errors: [],
              injectIdempotencyKey: true,
            },
          ],
        },
        {
          name: 'Organizations',
          operations: [],
        },
      ];

      const ctx: EmitterContext = {
        namespace: 'workos',
        namespacePascal: 'WorkOS',
        spec: emptySpec,
        overlayLookup: {
          methodByOperation: new Map([
            [
              'POST /auth/factors/enroll',
              {
                className: 'Mfa',
                methodName: 'enrollFactor',
                params: [],
                returnType: 'void',
              },
            ],
          ]),
          httpKeyByMethod: new Map(),
          interfaceByName: new Map(),
          typeAliasByName: new Map(),
          requiredExports: new Map(),
          modelNameByIR: new Map(),
          fileBySymbol: new Map(),
        },
      };

      const map = buildServiceNameMap(services, ctx);
      expect(map.get('MultiFactorAuth')).toBe('Mfa');
      expect(map.get('Organizations')).toBe('Organizations');
    });
  });
});
