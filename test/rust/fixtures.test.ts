import { describe, it, expect } from 'vitest';
import type { ApiSpec, Enum, Model } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { exampleFromSpec, generateFixtures, generateModelFixture } from '../../src/rust/fixtures.js';

function spec(models: Model[], enums: Enum[] = []): ApiSpec {
  return {
    name: 'Test',
    version: '1.0.0',
    baseUrl: '',
    services: [],
    models,
    enums,
    sdk: defaultSdkBehavior(),
  };
}

describe('rust/fixtures', () => {
  it('prefers a spec `example` over the generated placeholder for a primitive field', () => {
    const models: Model[] = [
      {
        name: 'Event',
        fields: [
          {
            name: 'id',
            type: { kind: 'primitive', type: 'string' },
            required: true,
            example: 'event_01XXXX',
          },
          {
            name: 'created_at',
            type: { kind: 'primitive', type: 'string', format: 'date-time' },
            required: true,
            example: '2026-02-02T16:35:39.317Z',
          },
        ],
      },
    ];
    const files = generateFixtures(spec(models));
    const file = files.find((f) => f.path === 'tests/fixtures/event.json')!;
    expect(file).toBeDefined();
    const parsed = JSON.parse(file.content);
    expect(parsed.id).toBe('event_01XXXX');
    expect(parsed.created_at).toBe('2026-02-02T16:35:39.317Z');
  });

  it('falls back to the placeholder when the example shape does not match the type', () => {
    const models: Model[] = [
      {
        name: 'Wrong',
        fields: [
          // Type is integer but example is a string — must fall back.
          {
            name: 'count',
            type: { kind: 'primitive', type: 'integer' },
            required: true,
            example: 'not-a-number',
          },
        ],
      },
    ];
    const files = generateFixtures(spec(models));
    const file = files.find((f) => f.path === 'tests/fixtures/wrong.json')!;
    const parsed = JSON.parse(file.content);
    expect(parsed.count).toBe(0); // placeholder fallback
  });

  it('uses an example array of strings for an array<string> field', () => {
    const models: Model[] = [
      {
        name: 'Org',
        fields: [
          {
            name: 'domains',
            type: {
              kind: 'array',
              items: { kind: 'primitive', type: 'string' },
            },
            required: true,
            example: ['example.com', 'foo.com'],
          },
        ],
      },
    ];
    const files = generateFixtures(spec(models));
    const file = files.find((f) => f.path === 'tests/fixtures/org.json')!;
    const parsed = JSON.parse(file.content);
    expect(parsed.domains).toEqual(['example.com', 'foo.com']);
  });

  it('skips a model-shaped example to avoid mis-shaped nested structs', () => {
    const models: Model[] = [
      {
        name: 'Outer',
        fields: [
          {
            name: 'actor',
            type: { kind: 'model', name: 'Actor' },
            required: true,
            // Provided as a free-form example; we should NOT use it verbatim.
            example: { not_a_real_field: 'whoops' },
          },
        ],
      },
      {
        name: 'Actor',
        fields: [
          {
            name: 'id',
            type: { kind: 'primitive', type: 'string' },
            required: true,
            example: 'user_TF4C5938',
          },
          {
            name: 'type',
            type: { kind: 'primitive', type: 'string' },
            required: true,
            example: 'user',
          },
        ],
      },
    ];
    const files = generateFixtures(spec(models));
    const file = files.find((f) => f.path === 'tests/fixtures/outer.json')!;
    const parsed = JSON.parse(file.content);
    // The nested model is regenerated from its own fields' examples, not from
    // the parent's free-form example blob.
    expect(parsed.actor).toEqual({ id: 'user_TF4C5938', type: 'user' });
  });

  it('uses an enum example only when it matches a known enum value', () => {
    const enums: Enum[] = [
      {
        name: 'Status',
        values: [
          { name: 'Active', value: 'active' },
          { name: 'Pending', value: 'pending' },
        ],
      },
    ];
    const models: Model[] = [
      {
        name: 'GoodEx',
        fields: [
          {
            name: 'status',
            type: { kind: 'enum', name: 'Status' },
            required: true,
            example: 'pending',
          },
        ],
      },
      {
        name: 'BadEx',
        fields: [
          {
            name: 'status',
            type: { kind: 'enum', name: 'Status' },
            required: true,
            example: 'something_unknown',
          },
        ],
      },
    ];
    const files = generateFixtures(spec(models, enums));
    const good = JSON.parse(files.find((f) => f.path === 'tests/fixtures/good_ex.json')!.content);
    const bad = JSON.parse(files.find((f) => f.path === 'tests/fixtures/bad_ex.json')!.content);
    expect(good.status).toBe('pending'); // valid example wins
    expect(bad.status).toBe('active'); // unknown example → first enum value
  });

  it('treats null examples as unusable so required fields keep a value', () => {
    const models: Model[] = [
      {
        name: 'Nullish',
        fields: [
          {
            name: 'name',
            type: { kind: 'primitive', type: 'string' },
            required: true,
            example: null,
          },
        ],
      },
    ];
    const files = generateFixtures(spec(models));
    const parsed = JSON.parse(files.find((f) => f.path === 'tests/fixtures/nullish.json')!.content);
    expect(parsed.name).toBe('test_name');
  });

  it('exampleFromSpec exposes the shape-checking helper for reuse', () => {
    const enums = new Map<string, Enum>();
    // Primitives are unwrapped through nullable.
    expect(exampleFromSpec('hello', { kind: 'nullable', inner: { kind: 'primitive', type: 'string' } }, enums)).toBe(
      'hello',
    );
    // Integer floats are rejected (they would corrupt typed deserialisation).
    expect(exampleFromSpec(1.5, { kind: 'primitive', type: 'integer' }, enums)).toBeUndefined();
    // Empty arrays fall back so the placeholder can emit a one-element array.
    expect(exampleFromSpec([], { kind: 'array', items: { kind: 'primitive', type: 'string' } }, enums)).toBeUndefined();
  });

  it('threads required-only field selection through generateModelFixture', () => {
    const models: Model[] = [
      {
        name: 'Mixed',
        fields: [
          {
            name: 'kept',
            type: { kind: 'primitive', type: 'string' },
            required: true,
            example: 'real',
          },
          {
            name: 'dropped',
            type: { kind: 'primitive', type: 'string' },
            required: false,
            example: 'ignored',
          },
        ],
      },
    ];
    const modelMap = new Map(models.map((m) => [m.name, m]));
    const fixture = generateModelFixture(models[0]!, modelMap, new Map(), new Set());
    expect(fixture).toEqual({ kept: 'real' });
  });
});
