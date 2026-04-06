import { describe, it, expect } from 'vitest';
import { pythonEmitter } from '../../src/python/index.js';
import type { EmitterContext } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';

const ctx: EmitterContext = {
  namespace: 'workos',
  namespacePascal: 'WorkOS',
  spec: { name: 'Test', version: '1.0.0', baseUrl: '', services: [], models: [], enums: [], sdk: defaultSdkBehavior() },
};

describe('generateErrors', () => {
  it('returns empty array (errors now hand-maintained in target SDK)', () => {
    expect(pythonEmitter.generateErrors!(ctx)).toEqual([]);
  });
});
