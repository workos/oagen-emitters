import { describe, it, expect } from 'vitest';
import type { TypeRef } from '@workos/oagen';
import { mapTypeRef } from '../../src/php/type-map.js';

const STRING: TypeRef = { kind: 'primitive', type: 'string' };
const NULLABLE_STRING: TypeRef = { kind: 'nullable', inner: STRING };

describe('php/type-map mapTypeRef', () => {
  it('maps a plain nullable as the `?T` shorthand', () => {
    expect(mapTypeRef(NULLABLE_STRING)).toBe('?string');
  });

  it('never emits the invalid `?T` shorthand inside a union', () => {
    // Regression: a `oneOf: [string, {string|null}]` spec shape parses into a
    // union of `string` + nullable-`string`. The naive join produced
    // `string|?string`, which is a PHP parse error (php-cs-fixer exit 4).
    const ref: TypeRef = {
      kind: 'union',
      compositionKind: 'oneOf',
      variants: [STRING, NULLABLE_STRING],
    };
    const result = mapTypeRef(ref);
    expect(result).not.toContain('|?');
    expect(result).toBe('?string');
  });

  it('hoists nullability to a trailing `|null` for multi-type unions', () => {
    const ref: TypeRef = {
      kind: 'union',
      compositionKind: 'oneOf',
      variants: [STRING, { kind: 'nullable', inner: { kind: 'primitive', type: 'integer' } }],
    };
    // `string` + `?int` must become `string|int|null`, not `string|?int`.
    const result = mapTypeRef(ref);
    expect(result).not.toContain('|?');
    expect(result).toBe('string|int|null');
  });

  it('leaves a genuine non-nullable union unchanged', () => {
    const ref: TypeRef = {
      kind: 'union',
      compositionKind: 'oneOf',
      variants: [
        { kind: 'model', name: 'Foo' },
        { kind: 'model', name: 'Bar' },
      ],
    };
    expect(mapTypeRef(ref)).toBe('Foo|Bar');
  });
});
