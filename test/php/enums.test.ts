import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Enum } from '@workos/oagen';
import { generateEnums } from '../../src/php/enums.js';
import { initializeNaming } from '../../src/php/naming.js';

const emptySpec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: '',
  services: [],
  models: [],
  enums: [],
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
    initializeNaming(enums.map((e) => e.name));
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
    initializeNaming(enums.map((e) => e.name));
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
    initializeNaming(enums.map((e) => e.name));
    const result = generateEnums(enums, ctx);

    expect(result[0].content).toContain('namespace WorkOS\\Resource;');
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
    initializeNaming(enums.map((e) => e.name));
    const result = generateEnums(enums, ctx);

    expect(result[0].content).toContain('case FooBar =');
    expect(result[0].content).toContain('case FooBar2 =');
  });
});
