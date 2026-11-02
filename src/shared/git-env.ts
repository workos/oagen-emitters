/**
 * Repository-locating variables git treats as local to a repo, as printed by
 * `git rev-parse --local-env-vars` (git 2.56). Git exports some of these
 * (e.g. GIT_DIR, GIT_INDEX_FILE) when it runs hooks; left in place they make
 * a `git` call aimed at another directory act on the enclosing repo instead.
 */
export const GIT_LOCAL_ENV_VARS: readonly string[] = [
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

/** A copy of `env` (default: the current process env) with every repository-locating variable removed. */
export function withoutGitLocalEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const scrubbed = { ...env };
  for (const name of GIT_LOCAL_ENV_VARS) delete scrubbed[name];
  return scrubbed;
}
