import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildLiveSurface } from '../../src/node/live-surface.js';
import { git, gitQuiet, initTempRepo } from './git.js';

// Git exports GIT_DIR (and sometimes GIT_WORK_TREE / GIT_INDEX_FILE) when it
// runs hooks such as .husky/pre-push. Temp-folder git calls must ignore them.
const HOOK_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'] as const;

let scratch: string;
let bare: string;
let bareConfigBefore: Buffer;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(HOOK_VARS.map((name) => [name, process.env[name]]));
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'git-env-'));
  bare = path.join(scratch, 'outer.git');
  gitQuiet(scratch, 'init', '--bare', bare);
  bareConfigBefore = fs.readFileSync(path.join(bare, 'config'));

  process.env.GIT_DIR = bare;
  process.env.GIT_WORK_TREE = path.join(scratch, 'outer-worktree');
  process.env.GIT_INDEX_FILE = path.join(scratch, 'outer-index');
});

afterEach(() => {
  for (const name of HOOK_VARS) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  fs.rmSync(scratch, { recursive: true, force: true });
});

function makeSrcTree(): string {
  const root = path.join(scratch, 'sdk');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'tracked.ts'), 'export const a = 1;\n');
  return root;
}

function expectOuterRepoUntouched(): void {
  expect(fs.existsSync(path.join(bare, 'index'))).toBe(false);
  expect(fs.existsSync(path.join(scratch, 'outer-index'))).toBe(false);
  expect(fs.existsSync(path.join(scratch, 'outer-worktree'))).toBe(false);
  expect(fs.readFileSync(path.join(bare, 'config')).equals(bareConfigBefore)).toBe(true);
  expect(git(scratch, '--git-dir', bare, 'config', 'core.bare').trim()).toBe('true');
}

describe('temp-repo git helper under inherited GIT_* env', () => {
  it('initializes and stages in the temp folder only', () => {
    const root = makeSrcTree();
    initTempRepo(root);

    expect(fs.statSync(path.join(root, '.git')).isDirectory()).toBe(true);
    expect(git(root, 'ls-files').trim().split('\n')).toEqual(['src/tracked.ts']);
    expectOuterRepoUntouched();
  });
});

describe('buildLiveSurface under inherited GIT_* env', () => {
  it('reads tracked files from the repo at rootDir', () => {
    const root = makeSrcTree();
    initTempRepo(root);
    fs.writeFileSync(path.join(root, 'src', 'untracked.ts'), 'export const b = 2;\n');

    const surface = buildLiveSurface(root);

    expect([...surface.trackedFiles]).toEqual(['src/tracked.ts']);
    expectOuterRepoUntouched();
  });
});
