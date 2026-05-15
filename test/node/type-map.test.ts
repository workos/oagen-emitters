import { describe, it, expect } from 'vitest';
import { mapTypeRef, mapWireTypeRef } from '../../src/node/type-map.js';
import type { TypeRef } from '@workos/oagen';

describe('mapTypeRef', () => {
  it('maps string primitive', () => {
    const ref: TypeRef = { kind: 'primitive', type: 'string' };
    expect(mapTypeRef(ref)).toBe('string');
  });

  it('maps integer primitive', () => {
    const ref: TypeRef = { kind: 'primitive', type: 'integer' };
    expect(mapTypeRef(ref)).toBe('number');
  });

  it('maps boolean primitive', () => {
    const ref: TypeRef = { kind: 'primitive', type: 'boolean' };
    expect(mapTypeRef(ref)).toBe('boolean');
  });

  it('maps unknown primitive to any', () => {
    const ref: TypeRef = { kind: 'primitive', type: 'unknown' };
    expect(mapTypeRef(ref)).toBe('any');
  });

  it('maps date-time to Date', () => {
    const ref: TypeRef = { kind: 'primitive', type: 'string', format: 'date-time' };
    expect(mapTypeRef(ref)).toBe('Date');
  });

  it('maps model ref to model name', () => {
    const ref: TypeRef = { kind: 'model', name: 'Organization' };
    expect(mapTypeRef(ref)).toBe('Organization');
  });

  it('maps enum ref to enum name', () => {
    const ref: TypeRef = { kind: 'enum', name: 'Status', values: ['active', 'inactive'] };
    expect(mapTypeRef(ref)).toBe('Status');
  });

  it('maps array of primitives', () => {
    const ref: TypeRef = { kind: 'array', items: { kind: 'primitive', type: 'string' } };
    expect(mapTypeRef(ref)).toBe('string[]');
  });

  it('maps array of models', () => {
    const ref: TypeRef = { kind: 'array', items: { kind: 'model', name: 'Org' } };
    expect(mapTypeRef(ref)).toBe('Org[]');
  });

  it('maps nullable type', () => {
    const ref: TypeRef = { kind: 'nullable', inner: { kind: 'primitive', type: 'string' } };
    expect(mapTypeRef(ref)).toBe('string | null');
  });

  it('maps union type', () => {
    const ref: TypeRef = {
      kind: 'union',
      variants: [
        { kind: 'primitive', type: 'string' },
        { kind: 'primitive', type: 'number' },
      ],
    };
    expect(mapTypeRef(ref)).toBe('string | number');
  });

  it('deduplicates union variants', () => {
    const ref: TypeRef = {
      kind: 'union',
      variants: [
        { kind: 'primitive', type: 'string' },
        { kind: 'primitive', type: 'string' },
      ],
    };
    expect(mapTypeRef(ref)).toBe('string');
  });

  it('parenthesizes unions in arrays', () => {
    const ref: TypeRef = {
      kind: 'array',
      items: {
        kind: 'union',
        variants: [
          { kind: 'primitive', type: 'string' },
          { kind: 'primitive', type: 'number' },
        ],
      },
    };
    expect(mapTypeRef(ref)).toBe('(string | number)[]');
  });

  it('maps map type', () => {
    const ref: TypeRef = { kind: 'map', valueType: { kind: 'primitive', type: 'string' } };
    expect(mapTypeRef(ref)).toBe('Record<string, string>');
  });

  it('maps string literal', () => {
    const ref: TypeRef = { kind: 'literal', value: 'active' };
    expect(mapTypeRef(ref)).toBe("'active'");
  });

  it('maps number literal', () => {
    const ref: TypeRef = { kind: 'literal', value: 42 };
    expect(mapTypeRef(ref)).toBe('42');
  });
});

describe('mapWireTypeRef', () => {
  it('maps model ref with Response suffix', () => {
    const ref: TypeRef = { kind: 'model', name: 'Organization' };
    expect(mapWireTypeRef(ref)).toBe('OrganizationResponse');
  });

  it('maps array of models with Response suffix', () => {
    const ref: TypeRef = { kind: 'array', items: { kind: 'model', name: 'Org' } };
    expect(mapWireTypeRef(ref)).toBe('OrgResponse[]');
  });

  it('maps date-time as string in wire type', () => {
    const ref: TypeRef = { kind: 'primitive', type: 'string', format: 'date-time' };
    expect(mapWireTypeRef(ref)).toBe('string');
  });

  it('maps enum ref unchanged', () => {
    const ref: TypeRef = { kind: 'enum', name: 'Status', values: ['active'] };
    expect(mapWireTypeRef(ref)).toBe('Status');
  });

  it('maps nullable model with Response suffix', () => {
    const ref: TypeRef = { kind: 'nullable', inner: { kind: 'model', name: 'Org' } };
    expect(mapWireTypeRef(ref)).toBe('OrgResponse | null');
  });
});
