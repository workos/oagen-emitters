import { describe, expect, it } from 'vitest';
import type { ApiSpec, EmitterContext, Enum } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateEnums } from '../../src/kotlin/enums.js';

describe('kotlin/enums', () => {
  it('emits a repeated wire value once', () => {
    const enums: Enum[] = [
      {
        name: 'MembershipStatus',
        values: [
          { name: 'active', value: 'active' },
          { name: 'active_again', value: 'active' },
          { name: 'inactive', value: 'inactive' },
        ],
      },
    ];
    const spec: ApiSpec = {
      name: 'Test',
      version: '1.0.0',
      baseUrl: '',
      services: [],
      models: [],
      enums,
      sdk: defaultSdkBehavior(),
    };
    const ctx: EmitterContext = { namespace: 'workos', namespacePascal: 'WorkOS', spec };
    const file = generateEnums(enums, ctx).find((f) => f.path.endsWith('/MembershipStatus.kt'))!;
    expect(file.content.match(/^\s+Active\(/gm)).toHaveLength(1);
    expect(file.content).toMatch(/^\s+Inactive\(/m);
  });
});
