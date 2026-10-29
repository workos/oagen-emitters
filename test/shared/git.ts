import { execFileSync } from 'node:child_process';

/**
 * Repository-locating variables git treats as local to a repo, as printed by
 * `git rev-parse --local-env-vars` (git 2.56). Git exports some of these
 * (e.g. GIT_DIR, GIT_INDEX_FILE) when it runs hooks; left in place they make
 * a temp-folder `git init`/`git add` act on the enclosing repo instead.
 */
const GIT_LOCAL_ENV_VARS = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
];

function scrubbedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of GIT_LOCAL_ENV_VARS) delete env[name];
  return env;
}

/** Run git in `cwd`, ignoring any inherited repository-locating env. Returns stdout. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: scrubbedEnv() });
}

/** Run git in `cwd` with `stdio: 'ignore'`, ignoring any inherited repository-locating env. */
export function gitQuiet(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: scrubbedEnv() });
}

/** `git init` in `root` and stage `paths`, isolated from the enclosing repo. */
export function initTempRepo(root: string, paths: string[] = ['src']): void {
  gitQuiet(root, 'init');
  gitQuiet(root, 'add', ...paths);
}
