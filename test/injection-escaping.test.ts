import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Model, Enum } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateEnums as ktEnums } from '../src/kotlin/enums.js';
import { generateModels as rbModels } from '../src/ruby/models.js';
import { generateEnums as rbEnums } from '../src/ruby/enums.js';
import { generateModels as rustModels } from '../src/rust/models.js';
import { UnionRegistry } from '../src/rust/type-map.js';

const emptySpec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: '',
  services: [],
  models: [],
  enums: [],
  sdk: defaultSdkBehavior(),
};

const ctx: EmitterContext = { namespace: 'workos', namespacePascal: 'WorkOS', spec: emptySpec };

// Spec-derived metadata must be rendered inert in the target language's literal
// syntax. These guard against language-specific execution metacharacters leaking
// into emitted source (Kotlin `$` templates, Ruby `#{}` interpolation / quote
// breakout, Rust serde-rename attribute breakout).
describe('emitter injection escaping', () => {
  it('kotlin: escapes `$` so enum wire values cannot become string templates', () => {
    const enums: Enum[] = [{ name: 'Status', values: [{ value: 'active' }, { value: '${System.getenv()}' }] }];
    const content = ktEnums(enums, ctx)
      .map((f) => f.content)
      .join('\n');
    expect(content).toContain('\\${System.getenv()}');
    expect(content).not.toMatch(/[^\\]\$\{System\.getenv\(\)\}/);
  });

  it('ruby: escapes `#` in double-quoted hash keys/accessors (no #{} interpolation)', () => {
    const models: Model[] = [
      {
        name: 'Thing',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          {
            name: 'evil#{raise "pwned"}',
            type: { kind: 'primitive', type: 'string' },
            required: false,
          },
        ],
      },
    ];
    const content = rbModels(models, { ...ctx, spec: { ...emptySpec, models } })
      .map((f) => f.content)
      .join('\n');
    expect(content).toContain('\\#{raise');
    expect(content).not.toMatch(/[^\\]#\{raise/);
  });

  it('ruby: escapes `\\` in single-quoted enum values (no quote breakout)', () => {
    const enums: Enum[] = [{ name: 'Kind', values: [{ value: 'a\\' }, { value: 'b' }] }];
    const content = rbEnums(enums, ctx)
      .map((f) => f.content)
      .join('\n');
    // The backslash must be doubled so the single-quoted literal terminates.
    expect(content).toContain("'a\\\\'");
  });

  it('rust: escapes `"` in serde rename so field names cannot break out', () => {
    const models: Model[] = [
      {
        name: 'Thing',
        fields: [
          {
            name: 'a")] pub owned: String, } fn pwn() {} struct X { #[serde(rename="b',
            type: { kind: 'primitive', type: 'string' },
            required: true,
          },
        ],
      },
    ];
    const content = rustModels(models, { ...ctx, spec: { ...emptySpec, models } }, new UnionRegistry())
      .map((f) => f.content)
      .join('\n');
    // The `"` in the field name must be escaped inside the rename string...
    expect(content).toContain('rename = "a\\")]');
    // ...so the payload never breaks out into a real struct field or free item.
    expect(content).not.toMatch(/^\s*pub owned: String,/m);
  });
});
