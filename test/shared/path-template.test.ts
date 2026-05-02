import { describe, expect, it } from 'vitest';
import { parsePathTemplate, hasPathParams } from '../../src/shared/path-template.js';

describe('parsePathTemplate', () => {
  it('splits a path with a single param', () => {
    expect(parsePathTemplate('/orgs/{id}')).toEqual([
      { kind: 'literal', value: '/orgs/' },
      { kind: 'param', name: 'id' },
    ]);
  });

  it('splits a path with multiple params', () => {
    expect(parsePathTemplate('/orgs/{id}/users/{uid}')).toEqual([
      { kind: 'literal', value: '/orgs/' },
      { kind: 'param', name: 'id' },
      { kind: 'literal', value: '/users/' },
      { kind: 'param', name: 'uid' },
    ]);
  });

  it('handles a path that ends in a param', () => {
    expect(parsePathTemplate('/foo/{id}')).toEqual([
      { kind: 'literal', value: '/foo/' },
      { kind: 'param', name: 'id' },
    ]);
  });

  it('handles a path that starts with a param', () => {
    expect(parsePathTemplate('{id}/foo')).toEqual([
      { kind: 'param', name: 'id' },
      { kind: 'literal', value: '/foo' },
    ]);
  });

  it('returns a single literal segment for paths with no params', () => {
    expect(parsePathTemplate('/health')).toEqual([{ kind: 'literal', value: '/health' }]);
  });

  it('returns empty for an empty string', () => {
    expect(parsePathTemplate('')).toEqual([]);
  });

  it('strips a single leading slash when requested', () => {
    expect(parsePathTemplate('/orgs/{id}', { stripLeadingSlash: true })).toEqual([
      { kind: 'literal', value: 'orgs/' },
      { kind: 'param', name: 'id' },
    ]);
  });

  it('preserves snake_case param names verbatim', () => {
    expect(parsePathTemplate('/audit_logs/exports/{audit_log_export_id}')).toEqual([
      { kind: 'literal', value: '/audit_logs/exports/' },
      { kind: 'param', name: 'audit_log_export_id' },
    ]);
  });
});

describe('hasPathParams', () => {
  it('returns true when any segment is a param', () => {
    expect(hasPathParams(parsePathTemplate('/orgs/{id}'))).toBe(true);
  });

  it('returns false for paths with no params', () => {
    expect(hasPathParams(parsePathTemplate('/health'))).toBe(false);
  });

  it('returns false for empty paths', () => {
    expect(hasPathParams(parsePathTemplate(''))).toBe(false);
  });
});
