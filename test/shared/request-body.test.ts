import { describe, expect, it } from 'vitest';
import type { Field, Model, Operation, TypeRef } from '@workos/oagen';
import { resolveRequestBodyModel } from '../../src/shared/request-body.js';

const string: TypeRef = { kind: 'primitive', type: 'string' };
const field = (name: string, required = false, type: TypeRef = string): Field => ({ name, type, required });
const literal = (value: string): TypeRef => ({ kind: 'literal', value });

const models: Model[] = [
  { name: 'Authorize', fields: [field('user_id', true), field('return_to')] },
  {
    name: 'AddAuthorize',
    fields: [field('user_id', true), field('return_to'), field('connection_intent', true, literal('add'))],
  },
  {
    name: 'ReauthorizeAuthorize',
    fields: [
      field('user_id', true),
      field('connection_intent', true, literal('reauthorize')),
      field('connected_account_id', true),
    ],
  },
];

function op(requestBody: TypeRef | undefined): Operation {
  return {
    name: 'authorize',
    httpMethod: 'post',
    path: '/data-integrations/{slug}/authorize',
    pathParams: [],
    queryParams: [],
    headerParams: [],
    requestBody,
    response: { kind: 'primitive', type: 'unknown' },
    errors: [],
    injectIdempotencyKey: false,
  };
}

const union = (...names: string[]): TypeRef => ({
  kind: 'union',
  variants: names.map((name) => ({ kind: 'model', name })),
});

describe('resolveRequestBodyModel', () => {
  it('returns null without a body and the model itself for a model body', () => {
    expect(resolveRequestBodyModel(op(undefined), models, 'Kotlin')).toBeNull();
    expect(resolveRequestBodyModel(op({ kind: 'model', name: 'Authorize' }), models, 'Kotlin')).toBe(models[0]);
  });

  it('projects object alternatives onto one model, requiring a field only when every alternative does', () => {
    const body = resolveRequestBodyModel(
      op(union('Authorize', 'AddAuthorize', 'ReauthorizeAuthorize')),
      models,
      'Kotlin',
    )!;
    expect(body.name).toBe('Authorize');
    expect(body.fields.map((f) => `${f.name}${f.required ? '!' : ''}`)).toEqual([
      'user_id!',
      'return_to',
      'connection_intent',
      'connected_account_id',
    ]);
    // Differing literal selectors widen to a union of those literals.
    expect(body.fields.find((f) => f.name === 'connection_intent')!.type).toEqual({
      kind: 'union',
      variants: [literal('add'), literal('reauthorize')],
    });
    expect(models.map((m) => m.fields.length)).toEqual([2, 3, 3]); // inputs untouched
  });

  it('treats identical inline enums that only differ by generated name as one type', () => {
    const owner = (name: string): Field => ({
      name: 'connection_owner',
      type: { kind: 'enum', name, values: ['user', 'organization'] },
      required: false,
    });
    const withOwners: Model[] = [
      { name: 'A', fields: [owner('AConnectionOwner')] },
      { name: 'B', fields: [owner('BConnectionOwner')] },
    ];
    const body = resolveRequestBodyModel(op(union('A', 'B')), withOwners, 'Kotlin')!;
    expect(body.fields[0].type).toEqual(withOwners[0].fields[0].type);
  });

  it.each<[string, TypeRef, RegExp]>([
    ['a primitive body', string, /unsupported request body \(primitive\)/],
    ['an unresolved model', { kind: 'model', name: 'Missing' }, /unresolved model Missing/],
    [
      'an allOf composition',
      { kind: 'union', compositionKind: 'allOf', variants: [{ kind: 'model', name: 'Authorize' }] },
      /unsupported request body \(union\)/,
    ],
    ['an empty union', { kind: 'union', variants: [] }, /unsupported request body \(union\)/],
    [
      'a non-object alternative',
      { kind: 'union', variants: [{ kind: 'model', name: 'Authorize' }, string] },
      /unsupported request body \(primitive\)/,
    ],
  ])('refuses %s, naming the language and operation', (_case, requestBody, reason) => {
    expect(() => resolveRequestBodyModel(op(requestBody), models, '.NET')).toThrow(
      /^\.NET POST \/data-integrations\/\{slug\}\/authorize: /,
    );
    expect(() => resolveRequestBodyModel(op(requestBody), models, '.NET')).toThrow(reason);
  });

  it('refuses alternatives that type the same field differently', () => {
    const conflicting: Model[] = [
      { name: 'A', fields: [field('x', true)] },
      { name: 'B', fields: [field('x', true, { kind: 'primitive', type: 'integer' })] },
    ];
    expect(() => resolveRequestBodyModel(op(union('A', 'B')), conflicting, 'PHP')).toThrow(/conflicting types for x/);
  });
});
