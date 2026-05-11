import { describe, it, expect } from 'vitest';
import type { TypeRef, UnionType } from '@workos/oagen';
import { mapTypeRef, UnionRegistry } from '../../src/rust/type-map.js';

describe('rust/type-map', () => {
  it('falls back to serde_json::Value for non-discriminated unions when no registry', () => {
    const u: UnionType = {
      kind: 'union',
      variants: [
        { kind: 'model', name: 'Foo' },
        { kind: 'model', name: 'Bar' },
      ],
    };
    expect(mapTypeRef(u)).toBe('serde_json::Value');
  });

  it('synthesises a named enum when a registry is provided', () => {
    const reg = new UnionRegistry();
    const u: TypeRef = {
      kind: 'union',
      variants: [
        { kind: 'model', name: 'Foo' },
        { kind: 'model', name: 'Bar' },
      ],
    };
    const name = mapTypeRef(u, { hint: 'WidgetThing', registry: reg });
    expect(name).toBe('WidgetThingOneOf');
    const body = reg.render();
    expect(body).toContain('#[serde(untagged)]');
    expect(body).toContain('pub enum WidgetThingOneOf {');
    expect(body).toContain('Foo(Foo),');
    expect(body).toContain('Bar(Bar),');
  });

  it('emits a tagged enum when the union has a discriminator', () => {
    const reg = new UnionRegistry();
    const u: TypeRef = {
      kind: 'union',
      variants: [
        { kind: 'model', name: 'CatEvent' },
        { kind: 'model', name: 'DogEvent' },
      ],
      discriminator: {
        property: 'event',
        mapping: { 'cat.created': 'CatEvent', 'dog.created': 'DogEvent' },
      },
    };
    mapTypeRef(u, { hint: 'EventPayload', registry: reg });
    const body = reg.render();
    expect(body).toContain('#[serde(tag = "event")]');
    expect(body).toContain('pub enum EventPayloadOneOf {');
  });

  it('deduplicates structurally identical unions to a single type', () => {
    const reg = new UnionRegistry();
    const u: TypeRef = {
      kind: 'union',
      variants: [
        { kind: 'model', name: 'A' },
        { kind: 'model', name: 'B' },
      ],
    };
    const a = mapTypeRef(u, { hint: 'First', registry: reg });
    const b = mapTypeRef(u, { hint: 'Second', registry: reg });
    expect(a).toBe(b);
    expect(reg.size()).toBe(1);
  });

  it('collapses single-variant unions to the inner type', () => {
    const reg = new UnionRegistry();
    const u: TypeRef = {
      kind: 'union',
      variants: [{ kind: 'primitive', type: 'string' }],
    };
    expect(mapTypeRef(u, { hint: 'X', registry: reg })).toBe('String');
    expect(reg.size()).toBe(0);
  });

  it('maps int32 format to i32 and float to f32', () => {
    expect(mapTypeRef({ kind: 'primitive', type: 'integer', format: 'int32' })).toBe('i32');
    expect(mapTypeRef({ kind: 'primitive', type: 'number', format: 'float' })).toBe('f32');
  });
});
