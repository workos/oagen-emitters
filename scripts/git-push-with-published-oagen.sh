#!/usr/bin/env sh
set -eu

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

restore_local() {
  echo "push wrapper: restoring local ../oagen link"
  npm run oagen:use:local
}

cleanup() {
  restore_local
}

trap cleanup EXIT INT TERM HUP

echo "push wrapper: switching @workos/oagen to the published package"
npm run oagen:use:published

git push "$@"
