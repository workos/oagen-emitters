import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Enum } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateEnums } from '../../src/rust/enums.js';

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

describe('rust/enums', () => {
  it('emits a Rust enum with snake_case rename when variants match', () => {
    const enums: Enum[] = [
      {
        name: 'Status',
        values: [
          { name: 'active', value: 'active' },
          { name: 'inactive', value: 'inactive' },
        ],
      },
    ];
    const files = generateEnums(enums, ctx);
    const f = files.find((x) => x.path === 'src/enums/status.rs')!;
    expect(f.content).toContain('pub enum Status {');
    expect(f.content).toContain('Active,');
    expect(f.content).toContain('Inactive,');
    expect(f.content).toContain('#[serde(rename_all = "snake_case")]');
    expect(f.content).toContain('#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]');
  });

  it('emits explicit per-variant rename when wire values are not snake_case', () => {
    const enums: Enum[] = [
      {
        name: 'Mode',
        values: [
          { name: 'kebab-case', value: 'kebab-case' },
          { name: 'mixedCase', value: 'mixedCase' },
        ],
      },
    ];
    const files = generateEnums(enums, ctx);
    const f = files.find((x) => x.path === 'src/enums/mode.rs')!;
    expect(f.content).toContain('#[serde(rename = "kebab-case")]');
    expect(f.content).toContain('#[serde(rename = "mixedCase")]');
    expect(f.content).not.toContain('rename_all = "snake_case"');
  });

  it('skips empty enums', () => {
    const enums: Enum[] = [{ name: 'Empty', values: [] }];
    const files = generateEnums(enums, ctx);
    expect(files.find((f) => f.path === 'src/enums/empty.rs')).toBeUndefined();
  });

  it('always emits a barrel even when no enums', () => {
    const files = generateEnums([], ctx);
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe('src/enums/mod.rs');
  });
});
