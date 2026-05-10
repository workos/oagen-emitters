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
  it('emits a non_exhaustive enum with manual Serialize/Deserialize and a fallback variant', () => {
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
    expect(f.content).toContain('#[non_exhaustive]');
    expect(f.content).toContain('Unknown(String),');
    expect(f.content).toContain('impl Serialize for Status');
    expect(f.content).toContain("impl<'de> Deserialize<'de> for Status");
    expect(f.content).toContain('Self::Active => "active"');
    expect(f.content).toContain('Self::Inactive => "inactive"');
    // No derive(Serialize/Deserialize) — they're hand-written.
    expect(f.content).not.toContain('Serialize, Deserialize)]');
  });

  it('round-trips non-snake-case wire values through canonical strings', () => {
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
    // FromStr matches the original wire string; as_str returns it back.
    expect(f.content).toContain('"kebab-case" => Self::KebabCase');
    expect(f.content).toContain('"mixedCase" => Self::MixedCase');
    expect(f.content).toContain('Self::KebabCase => "kebab-case"');
    expect(f.content).toContain('Self::MixedCase => "mixedCase"');
  });

  it('collapses alias wire values into a single canonical variant', () => {
    const enums: Enum[] = [
      {
        name: 'Trigger',
        values: [
          { name: 'sign-up', value: 'sign-up' },
          { name: 'sign_up', value: 'sign_up' },
          { name: 'sign up', value: 'sign up' },
        ],
      },
    ];
    const files = generateEnums(enums, ctx);
    const f = files.find((x) => x.path === 'src/enums/trigger.rs')!;
    // One Rust variant for all three aliases.
    expect(f.content.match(/^\s+SignUp,$/m)).not.toBeNull();
    // Canonical wire value is the first one seen.
    expect(f.content).toContain('Self::SignUp => "sign-up"');
    // Every alias deserializes into the same variant.
    expect(f.content).toContain('"sign-up" => Self::SignUp');
    expect(f.content).toContain('"sign_up" => Self::SignUp');
    expect(f.content).toContain('"sign up" => Self::SignUp');
  });

  it('falls back to a non-Unknown name when the spec defines an Unknown variant', () => {
    const enums: Enum[] = [
      {
        name: 'State',
        values: [
          { name: 'unknown', value: 'unknown' },
          { name: 'ready', value: 'ready' },
        ],
      },
    ];
    const files = generateEnums(enums, ctx);
    const f = files.find((x) => x.path === 'src/enums/state.rs')!;
    expect(f.content).toContain('Unknown,');
    expect(f.content).toContain('Unrecognized(String),');
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
