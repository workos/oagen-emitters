import { describe, expect, it, vi } from 'vitest';
import type { ApiParam } from '@workos/oagen/compat';
import { preserveParameterOrder } from '../../src/shared/baseline-params.js';

type Param = { name: string; optional: boolean };

const param = (spec: string): Param => ({ name: spec.replace(/\?$/, ''), optional: spec.endsWith('?') });
const params = (...specs: string[]): Param[] => specs.map(param);
const baseline = (...specs: string[]): ApiParam[] => specs.map((s) => ({ ...param(s), type: 'any' }));
const names = (result: { params: Param[] }) => result.params.map((p) => `${p.name}${p.optional ? '?' : ''}`);

const options = { language: 'test', label: 'Pipes.authorize' };

describe('preserveParameterOrder', () => {
  it('returns the schema order untouched without a baseline', () => {
    const result = preserveParameterOrder(params('slug', 'userId', 'returnTo?'), undefined, options);
    expect(names(result)).toEqual(['slug', 'userId', 'returnTo?']);
    expect(result.pinned).toBe(false);
  });

  it('keeps baseline slots and appends newer optional parameters after them, in schema order', () => {
    // Schema order inserted `accountDisplayName` first and moved `config` behind `codeChallenge`.
    const schema = params(
      'slug',
      'userId',
      'accountDisplayName?',
      'organizationId?',
      'codeChallenge?',
      'config?',
      'options?',
    );
    const result = preserveParameterOrder(
      schema,
      baseline('slug', 'userId', 'organizationId?', 'config?', 'options?'),
      options,
    );
    expect(names(result)).toEqual([
      'slug',
      'userId',
      'organizationId?',
      'config?',
      'options?',
      'accountDisplayName?',
      'codeChallenge?',
    ]);
    expect(result.pinned).toBe(true);
  });

  it('re-declares a baseline-required parameter through makeRequired when the schema made it optional', () => {
    const result = preserveParameterOrder(params('slug', 'userId?', 'secret'), baseline('slug', 'userId', 'secret'), {
      ...options,
      makeRequired: (p) => ({ ...p, optional: false }),
    });
    expect(names(result)).toEqual(['slug', 'userId', 'secret']);
  });

  it('leaves a baseline-required parameter as rendered when no makeRequired is given', () => {
    const result = preserveParameterOrder(
      params('slug', 'userId?', 'secret'),
      baseline('slug', 'userId', 'secret'),
      options,
    );
    expect(names(result)).toEqual(['slug', 'userId?', 'secret']);
    expect(result.pinned).toBe(true);
  });

  describe('when required parameters may not follow optional ones', () => {
    it.each([
      [
        'a new required parameter',
        params('slug', 'userId', 'options?'),
        baseline('slug', 'options?'),
        /new parameter userId is required/,
      ],
      [
        'a baseline-optional parameter that became required',
        params('slug', 'userId', 'options?'),
        baseline('slug', 'userId?', 'options?'),
        /userId became required/,
      ],
      [
        'a removed baseline parameter',
        params('slug', 'options?'),
        baseline('slug', 'removed?', 'options?'),
        /removed was removed/,
      ],
    ])('falls back to the schema order and warns about %s', (_case, schema, previous, reason) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = preserveParameterOrder(schema, previous, { ...options, allowRequiredAfterOptional: false });
        expect(result.params).toEqual(schema);
        expect(result.pinned).toBe(false);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/\[oagen\] test: Pipes\.authorize: /));
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(reason));
      } finally {
        warn.mockRestore();
      }
    });

    it('spells parameters through displayName in the warning', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        preserveParameterOrder(params('slug', 'userId'), baseline('slug'), { ...options, displayName: (n) => `$${n}` });
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/new parameter \$userId is required/));
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('when required parameters may follow optional ones', () => {
    const allow = { ...options, allowRequiredAfterOptional: true };

    it('appends a newly required parameter after every baseline slot, so old positional calls cannot bind it', () => {
      const schema = params(
        'organizationId',
        'slug',
        'userId',
        'accessToken?',
        'state?',
        'options?',
        'connectionIntent?',
      );
      const result = preserveParameterOrder(
        schema,
        baseline('organizationId', 'slug', 'accessToken?', 'state?', 'options?'),
        allow,
      );
      expect(names(result)).toEqual([
        'organizationId',
        'slug',
        'accessToken?',
        'state?',
        'options?',
        'userId',
        'connectionIntent?',
      ]);
      expect(result.pinned).toBe(true);
    });

    it('keeps the slot of a baseline-optional parameter that became required', () => {
      const result = preserveParameterOrder(
        params('slug', 'userId', 'secret?'),
        baseline('slug', 'secret?', 'userId?'),
        allow,
      );
      expect(names(result)).toEqual(['slug', 'secret?', 'userId']);
    });

    it('still falls back when a baseline parameter was removed', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = preserveParameterOrder(params('slug'), baseline('slug', 'gone?'), allow);
        expect(result.pinned).toBe(false);
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/gone was removed/));
      } finally {
        warn.mockRestore();
      }
    });
  });
});
