import { describe, it, expect } from 'vitest';
import { generateEnums } from '../../src/dotnet/enums.js';
import type { EmitterContext, ApiSpec, Enum, Service } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';

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

describe('dotnet/enums', () => {
  it('returns empty for no enums', () => {
    expect(generateEnums([], ctx)).toEqual([]);
  });

  it('generates C# enum with EnumMember attributes', () => {
    const enums: Enum[] = [
      {
        name: 'Status',
        values: [
          { name: 'ACTIVE', value: 'active' },
          { name: 'INACTIVE', value: 'inactive' },
          { name: 'PENDING', value: 'pending' },
        ],
      },
    ];

    const service: Service = {
      name: 'Organizations',
      operations: [
        {
          name: 'getOrganization',
          httpMethod: 'get',
          path: '/organizations/{id}',
          pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
          queryParams: [{ name: 'status', type: { kind: 'enum', name: 'Status' }, required: false }],
          headerParams: [],
          response: { kind: 'model', name: 'Organization' },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    };

    const files = generateEnums(enums, {
      ...ctx,
      spec: { ...emptySpec, services: [service], enums },
    });
    expect(files.length).toBe(1);

    const content = files[0].content;
    expect(content).toContain('namespace WorkOS');
    expect(content).toContain('public enum Status');
    expect(content).toContain('[EnumMember(Value = "active")]');
    expect(content).toContain('Active');
    expect(content).toContain('[EnumMember(Value = "inactive")]');
    expect(content).toContain('Inactive');
    expect(content).toContain('[EnumMember(Value = "pending")]');
    expect(content).toContain('Pending');
    // Unknown sentinel for forward compatibility
    expect(content).toContain('Unknown');
  });

  it('skips single-value enums (discriminator consts)', () => {
    const enums: Enum[] = [
      {
        name: 'DiscriminatorType',
        values: [{ name: 'ONLY_VALUE', value: 'only_value' }],
      },
    ];

    const files = generateEnums(enums, {
      ...ctx,
      spec: { ...emptySpec, enums },
    });
    expect(files).toHaveLength(0);
  });

  it('deduplicates structurally identical enums', () => {
    const enums: Enum[] = [
      {
        name: 'ConnectionType',
        values: [
          { name: 'SAML', value: 'saml' },
          { name: 'OIDC', value: 'oidc' },
        ],
      },
      {
        name: 'ProfileConnectionType',
        values: [
          { name: 'SAML', value: 'saml' },
          { name: 'OIDC', value: 'oidc' },
        ],
      },
    ];

    const service: Service = {
      name: 'Test',
      operations: [
        {
          name: 'test',
          httpMethod: 'get',
          path: '/test',
          pathParams: [],
          queryParams: [
            { name: 'type', type: { kind: 'enum', name: 'ConnectionType' }, required: false },
            { name: 'profile_type', type: { kind: 'enum', name: 'ProfileConnectionType' }, required: false },
          ],
          headerParams: [],
          response: { kind: 'primitive', type: 'unknown' },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    };

    const files = generateEnums(enums, {
      ...ctx,
      spec: { ...emptySpec, services: [service], enums },
    });
    // Only one enum file should be generated (the canonical)
    expect(files).toHaveLength(1);
    expect(files[0].content).toContain('ConnectionType');
  });

  it('skips orphan enums not referenced by models or operations', () => {
    const enums: Enum[] = [
      {
        name: 'OrphanEnum',
        values: [
          { name: 'A', value: 'a' },
          { name: 'B', value: 'b' },
        ],
      },
    ];

    const files = generateEnums(enums, {
      ...ctx,
      spec: { ...emptySpec, enums },
    });
    expect(files).toHaveLength(0);
  });

  it('generates deprecated enum values with Obsolete attribute', () => {
    const enums: Enum[] = [
      {
        name: 'Status',
        values: [
          { name: 'ACTIVE', value: 'active' },
          { name: 'OLD_STATUS', value: 'old_status', deprecated: true, description: 'Use ACTIVE instead' },
        ],
      },
    ];

    const service: Service = {
      name: 'Test',
      operations: [
        {
          name: 'test',
          httpMethod: 'get',
          path: '/test',
          pathParams: [],
          queryParams: [{ name: 'status', type: { kind: 'enum', name: 'Status' }, required: false }],
          headerParams: [],
          response: { kind: 'primitive', type: 'unknown' },
          errors: [],
          injectIdempotencyKey: false,
        },
      ],
    };

    const files = generateEnums(enums, {
      ...ctx,
      spec: { ...emptySpec, services: [service], enums },
    });
    expect(files).toHaveLength(1);
    const content = files[0].content;

    expect(content).toContain('[System.Obsolete');
    expect(content).toContain('OldStatus');
  });
});
