import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ApiSpec, EmitterContext, Service, Model } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { nodeEmitter } from '../../src/node/index.js';

const groupModel: Model = {
  name: 'Group',
  fields: [
    { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
    { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
  ],
};

const groupService: Service = {
  name: 'Groups',
  operations: [
    {
      name: 'getGroup',
      httpMethod: 'get',
      path: '/organizations/{organizationId}/groups/{groupId}',
      pathParams: [
        { name: 'organizationId', type: { kind: 'primitive', type: 'string' }, required: true },
        { name: 'groupId', type: { kind: 'primitive', type: 'string' }, required: true },
      ],
      queryParams: [],
      headerParams: [],
      response: { kind: 'model', name: 'Group' },
      errors: [],
      injectIdempotencyKey: false,
    },
  ],
};

const spec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: '',
  services: [groupService],
  models: [groupModel],
  enums: [],
  sdk: defaultSdkBehavior(),
};

const ctx: EmitterContext = {
  namespace: 'workos',
  namespacePascal: 'WorkOS',
  spec,
};

function createTrackedSdkRoot(withHandTests = false): string {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'node-owned-tests-'));
  fs.mkdirSync(path.join(tmpRoot, 'src', 'groups'), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'src', 'groups', 'fixtures'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'src', 'workos.ts'), '// @oagen-ignore-file\nexport class WorkOS {}\n');
  if (withHandTests) {
    fs.writeFileSync(path.join(tmpRoot, 'src', 'groups', 'groups.spec.ts'), "describe('old', () => {});\n");
    fs.writeFileSync(path.join(tmpRoot, 'src', 'groups', 'fixtures', 'group.json'), '{"id":"old"}\n');
  }
  execFileSync('git', ['init'], { cwd: tmpRoot, stdio: 'ignore' });
  execFileSync('git', ['add', 'src'], { cwd: tmpRoot, stdio: 'ignore' });
  return tmpRoot;
}

describe('node test generation ownership', () => {
  it('regenerates tests and fixtures for owned services', () => {
    const tmpRoot = createTrackedSdkRoot();
    try {
      const result = nodeEmitter.generateTests!(spec, {
        ...ctx,
        outputDir: tmpRoot,
        emitterOptions: { ownedServices: ['Groups'], regenerateOwnedTests: true },
      } as EmitterContext);

      const testFile = result.find((f) => f.path === 'src/groups/groups.spec.ts');
      const fixtureFile = result.find((f) => f.path === 'src/groups/fixtures/group.json');
      expect(testFile).toBeDefined();
      expect(testFile!.overwriteExisting).toBe(true);
      expect(fixtureFile).toBeDefined();
      expect(fixtureFile!.overwriteExisting).toBe(true);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('preserves existing hand-written tests and fixtures for owned services', () => {
    const tmpRoot = createTrackedSdkRoot(true);
    try {
      const result = nodeEmitter.generateTests!(spec, {
        ...ctx,
        outputDir: tmpRoot,
        emitterOptions: { ownedServices: ['Groups'], regenerateOwnedTests: true },
      } as EmitterContext);

      expect(result.some((f) => f.path === 'src/groups/groups.spec.ts')).toBe(false);
      expect(result.some((f) => f.path === 'src/groups/fixtures/group.json')).toBe(false);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('skips tests and fixtures when the service is not owned', () => {
    const tmpRoot = createTrackedSdkRoot();
    try {
      const result = nodeEmitter.generateTests!(spec, {
        ...ctx,
        outputDir: tmpRoot,
        emitterOptions: { regenerateOwnedTests: true },
      } as EmitterContext);

      expect(result.some((f) => f.path.startsWith('src/groups/'))).toBe(false);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
