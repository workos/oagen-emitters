import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Enum } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateEnums } from '../../src/php/enums.js';
import { initializeEnumDedup } from '../../src/php/naming.js';

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

describe('generateEnums', () => {
  it('returns empty array for no enums', () => {
    expect(generateEnums([], ctx)).toEqual([]);
  });

  it('generates a string-backed enum', () => {
    const enums: Enum[] = [
      {
        name: 'OrganizationStatus',
        values: [
          { name: 'ACTIVE', value: 'active' },
          { name: 'INACTIVE', value: 'inactive' },
        ],
      },
    ];

    const result = generateEnums(enums, ctx);

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('lib/Resource/OrganizationStatus.php');
    expect(result[0].content).toContain('enum OrganizationStatus: string');
    expect(result[0].content).toContain("case Active = 'active';");
    expect(result[0].content).toContain("case Inactive = 'inactive';");
  });

  it('generates an int-backed enum', () => {
    const enums: Enum[] = [
      {
        name: 'Priority',
        values: [
          { name: 'LOW', value: 1 },
          { name: 'MEDIUM', value: 2 },
          { name: 'HIGH', value: 3 },
        ],
      },
    ];

    const result = generateEnums(enums, ctx);

    expect(result[0].content).toContain('enum Priority: int');
    expect(result[0].content).toContain('case Low = 1;');
    expect(result[0].content).toContain('case Medium = 2;');
    expect(result[0].content).toContain('case High = 3;');
  });

  it('generates correct namespace', () => {
    const enums: Enum[] = [
      {
        name: 'Status',
        values: [{ name: 'ACTIVE', value: 'active' }],
      },
    ];

    const result = generateEnums(enums, ctx);

    expect(result[0].content).toContain('namespace WorkOS\\Resource;');
  });

  it('collapses duplicate enums with identical values into one file', () => {
    const enums: Enum[] = [
      {
        name: 'Order',
        values: [
          { name: 'ASC', value: 'asc' },
          { name: 'DESC', value: 'desc' },
        ],
      },
      {
        name: 'ConnectionOrder',
        values: [
          { name: 'ASC', value: 'asc' },
          { name: 'DESC', value: 'desc' },
        ],
      },
      {
        name: 'ApiKeyOrder',
        values: [
          { name: 'ASC', value: 'asc' },
          { name: 'DESC', value: 'desc' },
        ],
      },
    ];

    // Initialize dedup before generating
    initializeEnumDedup(enums);
    const result = generateEnums(enums, ctx);

    // Should produce only one file (the shortest name: Order)
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('lib/Resource/Order.php');
  });

  it('adds PHPDoc @deprecated for deprecated enum values', () => {
    const enums: Enum[] = [
      {
        name: 'ConnectionType',
        values: [
          { name: 'SAML', value: 'saml' },
          { name: 'OAUTH', value: 'oauth', deprecated: true },
        ],
      },
    ];

    const result = generateEnums(enums, ctx);

    expect(result).toHaveLength(1);
    // The non-deprecated value should not have a PHPDoc
    expect(result[0].content).not.toContain('/** @deprecated */\n    case Saml');
    // The deprecated value should have a PHPDoc
    expect(result[0].content).toContain('/** @deprecated */');
    // Verify the deprecated case follows the PHPDoc
    const lines = result[0].content.split('\n');
    const deprecatedIdx = lines.findIndex((l: string) => l.includes('@deprecated'));
    expect(deprecatedIdx).toBeGreaterThan(-1);
    expect(lines[deprecatedIdx + 1]).toContain("= 'oauth';");
  });

  it('adds PHPDoc with description and @deprecated for enum values', () => {
    const enums: Enum[] = [
      {
        name: 'ConnectionType',
        values: [
          { name: 'SAML', value: 'saml' },
          { name: 'OAUTH', value: 'oauth', description: 'Use OIDC instead', deprecated: true },
        ],
      },
    ];

    const result = generateEnums(enums, ctx);

    expect(result[0].content).toContain('Use OIDC instead');
    expect(result[0].content).toContain('@deprecated');
  });

  it('deduplicates case names', () => {
    const enums: Enum[] = [
      {
        name: 'DupEnum',
        values: [
          { name: 'FOO_BAR', value: 'foo_bar' },
          { name: 'FOO__BAR', value: 'foo__bar' },
        ],
      },
    ];

    const result = generateEnums(enums, ctx);

    expect(result[0].content).toContain('case FooBar =');
    expect(result[0].content).toContain('case FooBar2 =');
  });
});
