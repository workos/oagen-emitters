import { execFileSync } from 'node:child_process';
import { withoutGitLocalEnv } from '../../src/shared/git-env.js';

/** Run git in `cwd`, ignoring any inherited repository-locating env. Returns stdout. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: withoutGitLocalEnv() });
}

/** Run git in `cwd` with `stdio: 'ignore'`, ignoring any inherited repository-locating env. */
export function gitQuiet(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: withoutGitLocalEnv() });
}

/** `git init` in `root` and stage `paths`, isolated from the enclosing repo. */
export function initTempRepo(root: string, paths: string[] = ['src']): void {
  gitQuiet(root, 'init');
  gitQuiet(root, 'add', ...paths);
}
