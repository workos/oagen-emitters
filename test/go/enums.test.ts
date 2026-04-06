import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Enum } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateEnums } from '../../src/go/enums.js';

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

describe('go/enums', () => {
  it('returns empty for no enums', () => {
    expect(generateEnums([], ctx)).toEqual([]);
  });

  it('generates typed string constants', () => {
    const enums: Enum[] = [
      {
        name: 'ConnectionStatus',
        values: [
          { name: 'ACTIVE', value: 'active' },
          { name: 'INACTIVE', value: 'inactive' },
        ],
      },
    ];
    const files = generateEnums(enums, ctx);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('enums.go');
    const content = files[0].content;
    expect(content).toContain('package workos');
    expect(content).toContain('type ConnectionStatus string');
    expect(content).toContain('ConnectionStatusActive ConnectionStatus = "active"');
    expect(content).toContain('ConnectionStatusInactive ConnectionStatus = "inactive"');
  });

  it('deduplicates identical enums as type aliases', () => {
    const enums: Enum[] = [
      {
        name: 'Alpha',
        values: [{ name: 'A', value: 'a' }],
      },
      {
        name: 'Beta',
        values: [{ name: 'A', value: 'a' }],
      },
    ];
    const files = generateEnums(enums, ctx);
    const content = files[0].content;
    expect(content).toContain('type Alpha string');
    expect(content).toContain('type Beta = Alpha');
  });

  it('handles empty enums as type aliases to string', () => {
    const enums: Enum[] = [{ name: 'UnknownType', values: [] }];
    const files = generateEnums(enums, ctx);
    const content = files[0].content;
    expect(content).toContain('type UnknownType = string');
  });

  it('snapshot: ConnectionStatus enum', () => {
    const enums: Enum[] = [
      {
        name: 'ConnectionStatus',
        values: [
          { name: 'ACTIVE', value: 'active' },
          { name: 'INACTIVE', value: 'inactive' },
          { name: 'PENDING', value: 'pending' },
        ],
      },
    ];
    const files = generateEnums(enums, ctx);
    expect(files[0].content).toMatchInlineSnapshot(`
      "package workos

      // ConnectionStatus represents connection status values.
      type ConnectionStatus string

      const (
      	ConnectionStatusActive ConnectionStatus = "active"
      	ConnectionStatusInactive ConnectionStatus = "inactive"
      	ConnectionStatusPending ConnectionStatus = "pending"
      )
      "
    `);
  });

  it('uses Go acronym conventions for enum type names', () => {
    const enums: Enum[] = [
      {
        name: 'SsoConnectionType',
        values: [{ name: 'SAML', value: 'saml' }],
      },
    ];
    const files = generateEnums(enums, ctx);
    const content = files[0].content;
    expect(content).toContain('type SSOConnectionType string');
  });
});
